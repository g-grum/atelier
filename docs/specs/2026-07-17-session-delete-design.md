# Session deletion from the UI — design

Date: 2026-07-17 · Status: validated with owner (Germain) through brainstorming.

## Purpose

Let the user delete any conversation from the sidebar — real SDK sessions, not just drafts. Deletion is **real**: the session's `.jsonl` under `~/.claude/projects/` is removed via the SDK's `deleteSession`, so the session also disappears from `claude --resume` in the CLI. No tombstones, no trash can.

## Decisions (owner-validated)

1. **Real deletion** — SDK `deleteSession`, permanent, shared with the CLI. Not Atelier-only hiding, not a delayed trash.
2. **Streaming session** — deleting a session mid-turn aborts the turn (same path as Stop), disposes the stream, then deletes. One gesture, no 409.
3. **Confirmation** — real sessions get a confirmation dialog ("Supprimer la conversation « name » ? Cette action est définitive."). Drafts keep their instant, no-confirmation delete (unchanged).

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

**`SessionStreamRegistry.dispose(id)`** (new) — if a stream exists for the resolved id: abort the in-flight turn (`turnAbort?.abort()` + broker abort, the same path the WS `abort` message takes), close attached sockets, remove the entry from the registry map. Idempotent: disposing an unknown id is a no-op. Without this, the in-memory singleton would outlive the deleted file and a reconnection would resurrect a ghost session.

**`SessionsService.delete(id)`** (replaces `deleteDraft` as the route's target) —

1. If `id` is an unsent draft: filter `AppData.drafts`; done.
2. Else resolve the SDK id (`draftMap` honors materialized-draft ids) and locate the owning project (the session must belong to a registered project's dir; otherwise 404).
3. `registry.dispose(resolvedId)`.
4. `sdk.deleteSession(resolvedId, project.path)`.
5. Clean `AppData`: drop `modelOverrides[resolvedId]`, `permissionModes[resolvedId]`, and the `draftMap` entry pointing at `resolvedId`. **Keep `usageEvents`** — consumption history stays meaningful after the conversation is gone.
6. Unknown id or SDK "not found" → throw the service's not-found error → route maps to 404.

Ordering note: dispose-before-delete guarantees the SDK process is no longer appending to the `.jsonl` when it is removed.

### Web

**`SessionSidebar`** — pass `onDelete` for every session, not only drafts. Draft → call delete immediately (unchanged). Real session → open the confirmation dialog.

**Confirmation dialog** — use the existing, currently unused `components/ui/dialog.tsx`. Copy: title « Supprimer la conversation ? », body « "{name}" sera définitivement supprimée. », buttons Annuler / Supprimer (destructive style). `Escape`/Annuler closes with no action. The × button's `aria-label` distinguishes « Supprimer la conversation » from « Supprimer le brouillon ».

**`App.tsx` mutation** — `deleteSession` mutation mirrors the existing `deleteDraft` one: on success invalidate `['sessions']`; if the deleted session is the selected one, `controller.close()`, `setSelected(null)`, bump `openAttempt` to orphan any in-flight `open()`. On error → `setNotice(...)` banner; the list is only invalidated on success, so a failed delete leaves the UI intact.

### Error handling

- SDK deletion failure (locked file, vanished file) → 404 for not-found, 500 otherwise; client shows the notice banner and keeps the list.
- Deleting the streaming session: the abort inside `dispose` follows the Stop path, so the client's stream status settles the same way Stop does before the list refreshes.

## Testing

TDD, mirroring existing patterns:

- `sessions-service.test.ts` — real-session delete calls `sdk.deleteSession` with resolved id + project dir; disposes the stream first; cleans `modelOverrides`/`permissionModes`/`draftMap`; keeps `usageEvents`; unknown id throws not-found; draft delete unchanged.
- `app.test.ts` — `DELETE /api/sessions/:id`: 204 for a real session, 204 for a draft, **404 for an unknown id** (regression test for the old silent no-op).
- `session-stream.test.ts` — `registry.dispose(id)` aborts the in-flight turn, closes sockets, removes the entry; disposing an unknown id is a no-op.
- `SessionSidebar.test.tsx` — × visible on real sessions; clicking it opens the dialog; confirming calls delete; cancelling does not.
- `App.test.tsx` — full flow: delete selected real session → confirmation → deselection + list invalidation; delete non-selected session leaves selection alone.

## Out of scope

- Bulk delete, project-level purge.
- Undo/restore (real deletion was an explicit owner choice).
- Deleting sessions from unregistered projects.
