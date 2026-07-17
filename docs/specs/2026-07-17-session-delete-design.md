# Session deletion from the UI — design

Date: 2026-07-17 · Status: validated with owner (Germain) through brainstorming.

## Purpose

Let the user delete any conversation from the sidebar — real SDK sessions, not just drafts. Deletion is **real**: the session's `.jsonl` under `~/.claude/projects/` is removed via the SDK's `deleteSession`, so the session also disappears from `claude --resume` in the CLI. No tombstones, no trash can.

## Decisions (owner-validated)

1. **Real deletion** — SDK `deleteSession`, permanent, shared with the CLI. Not Atelier-only hiding, not a delayed trash.
2. **Streaming session** — deleting a session mid-turn aborts the turn (same path as Stop), disposes the stream, then deletes. One gesture, no 409.
3. **Confirmation** — real sessions get a confirmation dialog (title « Supprimer la conversation ? », body « "{name}" sera définitivement supprimée. »). Drafts keep their instant, no-confirmation delete (unchanged).

## Current state (what exists)

- `DELETE /api/sessions/:id` exists but is draft-only: `sessions.deleteDraft(id)` filters `AppData.drafts`. Passing a real session id is a **silent no-op that still returns 204** — a bug this feature fixes (unknown id → 404).
- `SessionListItem` already renders a `.del` × button, but `SessionSidebar` only passes `onDelete` for drafts.
- `backend.deleteSession(id)` is already exposed client-side (real + fixtures).
- `SessionStreamRegistry` caches one `SessionStream` per resolved id **forever**; no removal method exists.
- The SDK exposes `deleteSession(sessionId, { dir? })` — "removes `{sessionId}.jsonl` and the `{sessionId}/` subagent-transcript subdirectory; throws if the session is not found". Not yet declared on Atelier's `SdkClient` interface.

## Design

### API (unchanged surface, corrected semantics)

`DELETE /api/sessions/:id` remains the single entry point. The service decides:

- id is a draft → remove it from `AppData.drafts` (current behavior).
- id is a real session (or a materialized draft, resolved through `draftMap`) → dispose its stream, call SDK `deleteSession`, clean up `AppData`.
- id unknown anywhere, or SDK throws "not found" → **404** (ends the silent 204 no-op).
- 204 on success. No request body, no new routes.

### Server units

**`SdkClient` interface + `AgentSdkClient` + `MockSdkClient`** — add `deleteSession(sessionId: string, dir: string): Promise<void>`. The real client forwards to the SDK with `{ dir }` (the project path, same convention as `listSessions`). The mock records the call in `calls` like every other method.

**`SessionStreamRegistry.dispose(id)`** (new) — if a stream exists for the given id (the registry re-keys draft→SDK ids at materialization; dispose accepts either): abort the in-flight turn (`turnAbort?.abort()` + broker abort, the same path the WS `abort` message takes), drop all registered sinks so no further events flow, remove the entry from the registry map. Idempotent: disposing an unknown id is a no-op. Without this, the in-memory singleton would outlive the deleted file and a reconnection would resurrect a ghost session.

Server-side socket closing is deliberately **not** part of dispose: `SessionStream` is socket-free by design (sinks are send callbacks; the WebSockets live in the WS glue in `app.ts`). Atelier is a single-window app (single-instance lock), and the one client that can be attached is the deleting client, which closes its own socket (`controller.close()`, see Web section). An orphaned socket that never reconnects is harmless and cleaned up by its `onClose`.

Wiring note: the registry is currently constructed inside `createApp`, after `SessionsService` is built in `index.ts`. Move its construction to the composition root (`index.ts`) and inject it into both `createApp` and `SessionsService`.

**`SessionsService.delete(id)`** (replaces `deleteDraft` as the route's target) —

1. Resolve `sdkId = draftMap[id]` if present, else `id` itself if it names a real session.
2. `registry.dispose(id)` — runs for drafts too. A draft whose *first turn is still in flight* is still in `AppData.drafts`; disposing aborts that turn so the "deleted" draft doesn't materialize into a resurrected SDK session. (Narrow accepted race: if the SDK flushes the `.jsonl` despite the abort, the session simply reappears in the list and can be deleted again.)
3. If a draft record exists for `id`: filter it from `AppData.drafts`.
4. If `sdkId` names a real session: locate the owning project by scanning registered projects' dirs via `sdk.listSessions` (O(projects) local calls — acceptable for a personal app; the DELETE route carries no project id), then `sdk.deleteSession(sdkId, project.path)`.
5. Clean `AppData`: drop `modelOverrides[sdkId]`, `permissionModes[sdkId]`, and the `draftMap` entry pointing at `sdkId`. **Keep `usageEvents`** — consumption history stays meaningful after the conversation is gone.
6. If neither a draft record nor a real session was found → not-found → route maps to 404.

Not-found convention: no such error class exists yet; the service throws a small dedicated error (e.g. `SessionNotFoundError`), the route catches it → 404. SDK "not found" is detected by message-sniffing the untyped `Error` (acceptable; stated so the plan doesn't rediscover it). Other failures propagate → 500.

Ordering note: dispose-before-delete guarantees the SDK process is no longer appending to the `.jsonl` when it is removed. A WS reconnect between dispose and SDK delete could theoretically re-mint the stream via `registry.get()`, but the only client is the deleting one, which has already deselected — accepted, out of scope.

### Web

**`SessionSidebar`** — pass `onDelete` for every session, not only drafts. Draft → call delete immediately (unchanged). Real session → open the confirmation dialog.

**Confirmation dialog** — use the existing `components/ui/dialog.tsx` (already used by `SettingsPanel`). Copy: title « Supprimer la conversation ? », body « "{name}" sera définitivement supprimée. », buttons Annuler / Supprimer (destructive style). `Escape`/Annuler closes with no action. The × button's `aria-label` distinguishes « Supprimer la conversation » from « Supprimer le brouillon ».

**`App.tsx` mutation** — `deleteSession` mutation mirrors the existing `deleteDraft` one: on success invalidate `['sessions']`; if the deleted session is the selected one, `controller.close()`, `setSelected(null)`, bump `openAttempt` to orphan any in-flight `open()`. On error → `setNotice(...)` banner; the list is only invalidated on success, so a failed delete leaves the UI intact.

### Error handling

- SDK deletion failure (locked file, vanished file) → 404 for not-found, 500 otherwise; client shows the notice banner and keeps the list.
- Deleting the streaming session: the abort inside `dispose` follows the Stop path, so the client's stream status settles the same way Stop does before the list refreshes.

## Testing

TDD, mirroring existing patterns:

- `sessions-service.test.ts` — real-session delete calls `sdk.deleteSession` with resolved id + project dir; disposes the stream first; cleans `modelOverrides`/`permissionModes`/`draftMap`; keeps `usageEvents`; unknown id throws `SessionNotFoundError`; draft delete unchanged; deleting a draft also disposes its stream (mid-first-turn case).
- `app.test.ts` — `DELETE /api/sessions/:id`: 204 for a real session, 204 for a draft, **404 for an unknown id** (regression test for the old silent no-op).
- `session-stream.test.ts` — `registry.dispose(id)` aborts the in-flight turn, drops sinks (no events delivered afterwards), removes the entry (a later `get` builds a fresh stream); disposing an unknown id is a no-op; dispose works with either the draft id or the re-keyed SDK id.
- `SessionSidebar.test.tsx` — × visible on real sessions; clicking it opens the dialog; confirming calls delete; cancelling does not.
- `App.test.tsx` — full flow: delete selected real session → confirmation → deselection + list invalidation; delete non-selected session leaves selection alone.

## Out of scope

- Bulk delete, project-level purge.
- Undo/restore (real deletion was an explicit owner choice).
- Deleting sessions from unregistered projects.
