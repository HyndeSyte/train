import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePayload,
  withinSizeLimit,
  sessionTitle,
  toNotionProperties,
  toNotionChildren,
} from '../lib/session-mapping.mjs';

const base = {
  op: 'upsert',
  sessionId: 'abcd1234-uuid-0001',
  sessionSequence: 3,
  date: '2026-06-04',
  completedAt: '2026-06-04T13:47:00.000Z',
  sessionType: 'RP',
  status: 'Completed',
  durationMin: 47,
  overrideUsed: false,
  sessionNote: 'right shoulder felt good',
  issueCount: 0,
  issueFlags: [],
  attentionFlag: false,
};

const anchor = {
  slot: 'RP_anchor_ring-pullup',
  exercise: 'ring-pullup',
  reps: '5/5/4/4',
  rawQualityReps: 18,
  creditedReps: 17,
  creditDelta: 1,
  creditCapped: false,
  load: 0,
  loadUnit: 'lb',
  targetTotal: 24,
};

// ---- validatePayload ----
test('validate: happy upsert', () => {
  assert.deepEqual(validatePayload(base), { ok: true, op: 'upsert' });
});
test('validate: default op is upsert', () => {
  assert.equal(validatePayload({ ...base, op: undefined }).op, 'upsert');
});
test('validate: unknown op rejected', () => {
  assert.equal(validatePayload({ ...base, op: 'frobnicate' }).ok, false);
});
test('validate: missing sessionId rejected', () => {
  assert.equal(validatePayload({ ...base, sessionId: undefined }).ok, false);
});
test('validate: short sessionId rejected', () => {
  assert.equal(validatePayload({ ...base, sessionId: 'abc' }).ok, false);
});
test('validate: bad sessionType rejected', () => {
  assert.equal(validatePayload({ ...base, sessionType: 'XX' }).ok, false);
});
test('validate: bad status rejected', () => {
  assert.equal(validatePayload({ ...base, status: 'Done' }).ok, false);
});
test('validate: bad anchor slot rejected', () => {
  assert.equal(validatePayload({ ...base, anchor: { slot: 'nope' } }).ok, false);
});
test('validate: good anchor slot accepted', () => {
  assert.equal(validatePayload({ ...base, anchor }).ok, true);
});
test('validate: delete needs only sessionId', () => {
  assert.deepEqual(validatePayload({ op: 'delete', sessionId: 'abcd1234-uuid-0001' }), { ok: true, op: 'delete' });
});
test('validate: delete without sessionId rejected', () => {
  assert.equal(validatePayload({ op: 'delete' }).ok, false);
});

// ---- sessionTitle ----
test('title: completed has no suffix', () => {
  assert.equal(sessionTitle(base), '2026-06-04 \u00b7 RP');
});
test('title: stopped shows suffix', () => {
  assert.equal(sessionTitle({ ...base, status: 'Stopped' }), '2026-06-04 \u00b7 RP (Stopped)');
});

// ---- toNotionProperties ----
test('props: required fields + Deleted defaults false', () => {
  const p = toNotionProperties(base, '2026-06-04T14:00:00.000Z');
  assert.equal(p['Session ID'].rich_text[0].text.content, 'abcd1234-uuid-0001');
  assert.equal(p['Status'].select.name, 'Completed');
  assert.equal(p['Session Type'].select.name, 'RP');
  assert.equal(p['Deleted'].checkbox, false);
  assert.equal(p['Synced At'].date.start, '2026-06-04T14:00:00.000Z');
  assert.equal(p['Session'].title[0].text.content, '2026-06-04 \u00b7 RP');
});
test('props: no anchor block when anchor absent', () => {
  const p = toNotionProperties(base, 'x');
  assert.equal('Anchor Slot' in p, false);
});
test('props: anchor block present + correct', () => {
  const p = toNotionProperties({ ...base, anchor }, 'x');
  assert.equal(p['Anchor Slot'].select.name, 'RP_anchor_ring-pullup');
  assert.equal(p['Anchor Reps'].rich_text[0].text.content, '5/5/4/4');
  assert.equal(p['Anchor Raw Quality Reps'].number, 18);
  assert.equal(p['Anchor Credited Reps'].number, 17);
  assert.equal(p['Anchor Credit Capped'].checkbox, false);
});
test('props: issue flags mapped to multi_select', () => {
  const p = toNotionProperties({ ...base, issueFlags: ['ring-pullup'] }, 'x');
  assert.equal(p['Issue Flags'].multi_select[0].name, 'ring-pullup');
});
test('props: long note truncated to <= 1900', () => {
  const p = toNotionProperties({ ...base, sessionNote: 'x'.repeat(5000) }, 'x');
  assert.ok(p['Session Note'].rich_text[0].text.content.length <= 1900);
});

// ---- toNotionChildren ----
test('children: exercises + issues + raw json present', () => {
  const c = toNotionChildren({
    ...base,
    detail: {
      exercises: [{ name: 'Ring Pull-Up', role: 'anchor', reps: [5, 5, 4, 4], issue: 'finger ache' }],
      collectedIssues: ['finger ache'],
    },
    raw: { a: 1 },
  });
  const types = c.map((b) => b.type);
  assert.ok(types.includes('heading_3'));
  assert.ok(types.includes('bulleted_list_item'));
  assert.ok(types.includes('code'));
});
test('children: raw json chunked under cap per block', () => {
  const c = toNotionChildren({ ...base, raw: { note: 'y'.repeat(5000) } });
  const codeBlocks = c.filter((b) => b.type === 'code');
  assert.ok(codeBlocks.length >= 2);
  codeBlocks.forEach((b) => assert.ok(b.code.rich_text[0].text.content.length <= 1900));
});
test('children: empty when no note/detail/raw', () => {
  const c = toNotionChildren({ ...base, sessionNote: '', detail: {}, raw: undefined });
  assert.equal(c.length, 0);
});

// ---- withinSizeLimit ----
test('size limit: small ok, huge rejected', () => {
  assert.equal(withinSizeLimit('{}'), true);
  assert.equal(withinSizeLimit('x'.repeat(70 * 1024)), false);
  assert.equal(withinSizeLimit(undefined), false);
});
