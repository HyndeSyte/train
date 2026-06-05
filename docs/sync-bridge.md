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
  "sessionType": "RP | LP | RPush | LS | RPr",
  "status": "Completed | Partial | Stopped",
  "durationMin": 47,
  "overrideUsed": false,
  "anchor": {
    "slot": "RP_anchor_ring-pullup | RPush_anchor_ring-pushup",
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
the page body only. Responses: `{ ok, action, notionPageId, sessionId }` where `action`
is `created | updated | soft-deleted | noop-absent`.

### Delete (tombstone) body

```json
{ "op": "delete", "sessionId": "uuid" }
```

## Environment variables

Set these in **Netlify - Site configuration - Environment variables**. Never commit them.

| Var | Required | Value |
| --- | --- | --- |
| `NOTION_TOKEN` | yes | Notion internal integration secret |
| `NOTION_DATA_SOURCE_ID` | yes | Data source ID of "Training - Session Log": `bb53c37f-c472-4ca1-b5cd-7dfe2b03ce37` |
| `TRAIN_SYNC_SECRET` | optional | Shared key; if set, the PWA must send a matching `X-Train-Sync-Key` header |
| `ALLOWED_ORIGIN` | optional | CORS origin; defaults to `https://hyndesyte.github.io` |

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
npm test      # node --test over the pure mapping/validation module
```
