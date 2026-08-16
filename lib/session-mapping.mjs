// Pure mapping + validation for the Train -> Notion session sync.
// No network, no secrets. Imported by the Netlify handler and exercised directly by tests.
// Property names below MUST match the "Training - Session Log" Notion schema exactly.

// RP..RPr = current ring-spine rotation. MVS = the v7 Floor (minimum-viable) day.
// U1/L1/U2/L2 = retired pre-v4 types, accepted ONLY so existing history backfills
// faithfully; new sessions never emit them. Still a controlled enum.
export const SESSION_TYPES = ['RP', 'LP', 'RPush', 'LS', 'RPr', 'MVS', 'U1', 'L1', 'U2', 'L2'];
export const STATUSES = ['Completed', 'Partial', 'Stopped'];
export const ANCHOR_SLOTS = ['RP_anchor_ring-pullup', 'RPush_anchor_ring-pushup'];

const MAX_BODY_BYTES = 64 * 1024;   // reject oversized payloads (defensive)
const TEXT_CAP = 1900;              // stay under Notion's 2000-char per-rich_text limit

// Validate the parsed POST body. Returns {ok:true, op} or {ok:false, error}.
export function validatePayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const op = body.op || 'upsert';
  if (op !== 'upsert' && op !== 'delete') return { ok: false, error: `unknown op: ${op}` };
  if (typeof body.sessionId !== 'string' || body.sessionId.length < 8) {
    return { ok: false, error: 'sessionId required (string, >= 8 chars)' };
  }
  if (op === 'delete') return { ok: true, op };   // a delete tombstone needs only the sessionId
  if (!SESSION_TYPES.includes(body.sessionType)) {
    return { ok: false, error: `sessionType must be one of ${SESSION_TYPES.join(', ')}` };
  }
  if (!STATUSES.includes(body.status)) {
    return { ok: false, error: `status must be one of ${STATUSES.join(', ')}` };
  }
  if (body.anchor && !ANCHOR_SLOTS.includes(body.anchor.slot)) {
    return { ok: false, error: `anchor.slot must be one of ${ANCHOR_SLOTS.join(', ')}` };
  }
  return { ok: true, op };
}

export function withinSizeLimit(rawString) {
  return typeof rawString === 'string' && Buffer.byteLength(rawString, 'utf8') <= MAX_BODY_BYTES;
}

// Human-readable row title, e.g. "2026-06-04 - RP" or "2026-06-04 - RP (Stopped)".
export function sessionTitle(body) {
  const suffix = body.status && body.status !== 'Completed' ? ` (${body.status})` : '';
  return `${body.date} · ${body.sessionType}${suffix}`;
}

function richText(s) { return [{ text: { content: String(s).slice(0, TEXT_CAP) } }]; }

// Map a validated upsert payload to Notion page properties (2025-09-03 property JSON).
export function toNotionProperties(body, nowISO) {
  const p = {
    'Session': { title: richText(sessionTitle(body)) },
    'Session ID': { rich_text: richText(body.sessionId) },
    'Status': { select: { name: body.status } },
    'Session Type': { select: { name: body.sessionType } },
    'Synced At': { date: { start: nowISO } },
    'Deleted': { checkbox: false },
  };
  if (typeof body.sessionSequence === 'number') p['Session Sequence'] = { number: body.sessionSequence };
  if (body.date) p['Date'] = { date: { start: body.date } };
  if (body.completedAt) p['Completed At'] = { date: { start: body.completedAt } };
  if (typeof body.durationMin === 'number') p['Duration (min)'] = { number: body.durationMin };
  if (typeof body.overrideUsed === 'boolean') p['Override Used'] = { checkbox: body.overrideUsed };
  if (typeof body.sessionNote === 'string' && body.sessionNote) p['Session Note'] = { rich_text: richText(body.sessionNote) };
  if (typeof body.issueCount === 'number') p['Issue Count'] = { number: body.issueCount };
  if (Array.isArray(body.issueFlags) && body.issueFlags.length) {
    p['Issue Flags'] = { multi_select: body.issueFlags.slice(0, 20).map((name) => ({ name: String(name).slice(0, 90) })) };
  }
  if (typeof body.attentionFlag === 'boolean') p['Attention Flag'] = { checkbox: body.attentionFlag };
  // v7 elastic sessions: written only when the payload carries a boolean (older app builds
  // send null/omit it). Requires the 'Core Complete' checkbox property on the Notion DB.
  if (typeof body.coreComplete === 'boolean') p['Core Complete'] = { checkbox: body.coreComplete };

  if (body.anchor) {
    const a = body.anchor;
    p['Anchor Slot'] = { select: { name: a.slot } };
    if (a.exercise) p['Anchor Exercise'] = { rich_text: richText(a.exercise) };
    if (a.reps) p['Anchor Reps'] = { rich_text: richText(a.reps) };
    if (typeof a.rawQualityReps === 'number') p['Anchor Raw Quality Reps'] = { number: a.rawQualityReps };
    if (typeof a.creditedReps === 'number') p['Anchor Credited Reps'] = { number: a.creditedReps };
    if (typeof a.creditDelta === 'number') p['Anchor Credit Delta'] = { number: a.creditDelta };
    if (typeof a.creditCapped === 'boolean') p['Anchor Credit Capped'] = { checkbox: a.creditCapped };
    if (typeof a.load === 'number') p['Anchor Load'] = { number: a.load };
    if (a.loadUnit) p['Anchor Load Unit'] = { select: { name: a.loadUnit } };
    if (typeof a.targetTotal === 'number') p['Anchor Target Total'] = { number: a.targetTotal };
  }
  return p;
}

// Build the page-body blocks: session note, per-exercise detail, collected issues, raw JSON.
export function toNotionChildren(body) {
  const children = [];
  const detail = body.detail || {};

  if (body.sessionNote) {
    children.push(heading('Session note'));
    children.push(paragraph(body.sessionNote));
  }
  if (Array.isArray(detail.exercises) && detail.exercises.length) {
    children.push(heading('Exercises'));
    detail.exercises.forEach((ex) => {
      const reps = Array.isArray(ex.reps) ? ex.reps.join('/') : (ex.reps || '');
      const role = ex.role ? ` [${ex.role}]` : '';
      children.push(bullet(`${ex.name || ex.exId}${role} — ${reps}`));
      if (ex.issue) children.push(bullet(`⚠ issue: ${ex.issue}`));
      if (ex.note) children.push(bullet(`note: ${ex.note}`));
    });
  }
  if (Array.isArray(detail.collectedIssues) && detail.collectedIssues.length) {
    children.push(heading('Collected issues'));
    detail.collectedIssues.forEach((i) => children.push(bullet(String(i))));
  }
  if (body.raw !== undefined) {
    children.push(heading('Raw JSON'));
    chunk(JSON.stringify(body.raw, null, 2), TEXT_CAP).forEach((c) => children.push(codeBlock(c)));
  }
  return children;
}

function heading(text) {
  return { object: 'block', type: 'heading_3', heading_3: { rich_text: richText(text) } };
}
function paragraph(text) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(text) } };
}
function bullet(text) {
  return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(text) } };
}
function codeBlock(text) {
  return { object: 'block', type: 'code', code: { language: 'json', rich_text: [{ text: { content: text } }] } };
}
function chunk(str, n) {
  const out = [];
  for (let i = 0; i < str.length; i += n) out.push(str.slice(i, i + n));
  return out;
}
