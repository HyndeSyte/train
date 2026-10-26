# Train -> Notion sync bridge

Server-side bridge that syncs finished workout sessions from the **Train PWA** into a
**Notion** operational database ("Training - Session Log"), automatically and with zero
manual steps per session.

It lives in this repo alongside the PWA but deploys as a **functions-only Netlify site**:
Netlify publishes only the stub page (`public/`) and builds the function
(`netlify/functions/`), while GitHub Pages independently serves the PWA from the repo root.
The two never collide.

It exists because the PWA is a static public app: it cannot hold a Notion token (a public
repo would expose it) and browsers cannot call the Notion API directly (no CORS). A tiny
server-side function is the only way to hold the secret and make the call.

## Architecture

```
Train PWA (on finalize)
  --POST session JSON-->  Netlify Function  (holds NOTION_TOKEN)
                            --Notion API-->  "Training - Session Log" database
```

- **localStorage in the PWA is the source of truth.** This DB is a derived mirror.
- **Idempotent upsert** keyed by `sessionId`: a timeout that creates the row but never
  returns is healed on the next push (the dedup query finds the row and the call returns
  success instead of duplicating).
- **Soft delete:** a delete in the PWA sends a tombstone that sets `Deleted = true`; the
  row is never hard-deleted in v1.

## Endpoint

`POST /.netlify/functions/sync-training-session`

### Upsert body

```json
{
  "op": "upsert",
  "sessionId": "uuid (stable, created at finalize)",
  "sessionSequence": 42,
  "date": "2026-06-04",
  "completedAt": "2026-06-04T13:47:00.000Z",
  "sessionType": "A | B | C | EN | MVS | PT  (EN shows as \"Engine\"; RP | LP | RPush | LS | RPr accepted for v7 history)",
  "status": "Completed | Partial | Stopped",
  "durationMin": 47,
  "overrideUsed": false,
  "coreComplete": true,
  "mode": "Normal | Recovery",
  "armCheck": "Better | Same | Worse",
  "ptList": true,
  "anchor": {
    "slot": "A_anchor_ring-pullup | C_anchor_ring-pushup  (v7: RP_anchor_ring-pullup | RPush_anchor_ring-pushup)",
    "exercise": "ring-pullup",
    "reps": "5/5/4/4",
    "rawQualityReps": 18,
    "creditedReps": 17,
    "creditDelta": 1,
    "creditCapped": false,
    "load": 0,
    "loadUnit": "lb",
    "targetTotal": 24
  },
  "sessionNote": "free text",
  "issueCount": 1,
  "issueFlags": ["ring-pullup"],
  "attentionFlag": false,
  "detail": {
    "exercises": [
      { "name": "Ring Pull-Up", "role": "anchor", "reps": [5,5,4,4], "issue": "...", "note": "..." }
    ],
    "collectedIssues": ["..."]
  },
  "raw": { "...": "full session entry, stored verbatim in the page body" }
}
```

`anchor` is omitted for sessions without a heavy ring anchor. `detail` and `raw` populate
the page body only.

`mode`, `armCheck` and `ptList` (v7.3 recovery layer, 2026-10-15) are optional and map to the
Notion properties **Mode** (select: Normal, Recovery), **Arm Check** (select: Better, Same,
Worse) and **PT List** (checkbox). Older app builds omit them and nothing is written. Values
are validated against those option names, so a typo fails loudly as a 400 instead of
creating a stray option. `PT` is the recovery layer's daily PT-list session: it runs outside
the rotation, carries `ptList: true`, and lists PT's items in `detail.exercises` with
`role: "pt"` and the dose as `reps`. A new `Session Type` option (such as `PT` or `MVS`) is
created by Notion on the first write that uses it. Responses: `{ ok, action, notionPageId, sessionId }` where `action`
is `created | updated | soft-deleted | noop-absent`.

### Delete (tombstone) body

```json
{ "op": "delete", "sessionId": "uuid" }
```

### One writer: the client header and the writer flag (2026-10-20)

Every request names its client with `X-Train-Client: pwa` or `X-Train-Client: native` (a
missing header counts as `pwa`, so a PWA that predates the header keeps syncing). Before any
Notion call the function reads `https://hyndesyte.github.io/train/writer.json` (`{"writer":
"pwa"}` until the native cutover, `native` after it, back to `pwa` at rollback), cache-busted,
three tries of 500 ms, cached 60 seconds per instance; the cache expires on time whether or
not the refresh succeeds. Outcomes, all with the usual CORS headers and `Vary: Origin,
X-Train-Client`:

| Case | Response |
| --- | --- |
| client equals the flag | the normal 200 |
| client is not the flag (or is unrecognised) | `403 { ok:false, error:"not the writer", writer }` |
| no readable flag and no unexpired cached value | `503 { ok:false, error:"writer unknown" }`, `Retry-After: 60` |

Neither refusal touches Notion. The flag file is committed as `pwa` before the writer check
deploys; a `writer.json`-only commit is pre-authorized at any hour and starts no native build.
The PWA sends `pwa`; the native shell sends `native` and treats a 403 as terminal for that
drain (the entry stays pending for a manual retry).

### CORS

The matching `Origin` is echoed from an allowlist (`https://hyndesyte.github.io`,
`capacitor://localhost`, plus comma-separated `ALLOWED_ORIGIN` extras, case-insensitive) on
POST and OPTIONS; an unlisted origin gets no `Access-Control-Allow-Origin`. Preflight allows
`Content-Type, X-Train-Sync-Key, X-Train-Client`. CORS is not auth. An update never clears
`Deleted` (delete wins), so a stale re-post cannot resurrect a tombstone.

## Environment variables

Set these in **Netlify - Site configuration - Environment variables**. Never commit them.

| Var | Required | Value |
| --- | --- | --- |
| `NOTION_TOKEN` | yes | Notion internal integration secret |
| `NOTION_DATA_SOURCE_ID` | yes | Data source ID of "Training - Session Log": `bb53c37f-c472-4ca1-b5cd-7dfe2b03ce37` |
| `TRAIN_SYNC_SECRET` | optional | Shared key; if set, the PWA must send a matching `X-Train-Sync-Key` header |
| `ALLOWED_ORIGIN` | optional | Extra CORS origin(s), comma-separated; the built-in allowlist (`https://hyndesyte.github.io`, `capacitor://localhost`) always applies |

The Notion integration must be **explicitly shared with the database** (database ... menu ->
Connections), or every write returns 403.

## Netlify site setup (one-time)

Connect this repo to a new Netlify site under your team. Netlify reads `netlify.toml`
automatically: build command is a no-op, publish dir is `public/` (the stub), functions dir
is `netlify/functions/`. Then set the environment variables above. GitHub Pages continues to
serve the PWA from the repo root, untouched.

## Notion API

Version `2025-09-03` (data-source-scoped): dedup via `POST /v1/data_sources/{id}/query`,
create via `POST /v1/pages` with a `data_source_id` parent, update via `PATCH /v1/pages/{id}`.

## Test

```
npm test      # node --test: the mapping module, the handler (CORS, upsert, delete, writer check) and the app
```
