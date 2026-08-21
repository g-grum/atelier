# Permission mode selector + sticky user messages — design

Date: 2026-08-21. Status: approved.

## Goals

1. Set the session permission mode (auto / accept edits / plan / skip permissions)
   from a compact selector next to the composer submit button, at any time.
2. Pin each user message to the top of the conversation while its turn scrolls,
   collapsed to ~200px when longer, expandable on click.

## A. Permission mode selector

### Modes

`SessionPermissionMode` (packages/shared/src/protocol.ts) grows from
`'default' | 'bypassPermissions'` to:

```ts
type SessionPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
```

Existing persisted values stay valid — no migration. `SESSION_PERMISSION_MODES`
lists all four; route validation (sessions-routes.ts) follows automatically.

### Approach decision

SDK-native `permissionMode` is used ONLY for `'plan'`. Native
`bypassPermissions`/`acceptEdits` short-circuit `canUseTool` and swallow
AskUserQuestion MCQs (documented lesson in sdk-client.ts) — those two modes
stay implemented inside the callback:

| Mode | QueryOptions.permissionMode | canUseTool behavior |
|---|---|---|
| default | (unset) | broker.request (unchanged) |
| acceptEdits | (unset) | auto-allow Edit/Write/NotebookEdit; rest → broker |
| plan | `'plan'` | broker.request — ExitPlanMode arrives as a normal permission |
| bypassPermissions | (unset) | auto-allow all (unchanged) |

AskUserQuestion routing stays first-priority in every mode (unchanged).

Mode is read at turn start (`runTurn`), so a change applies to the next turn —
consistent with the one-fresh-query-per-turn architecture; no
`setPermissionMode` mid-turn.

### ExitPlanMode

In plan mode the SDK requests permission for `ExitPlanMode` with the plan
markdown in its input. The permission flows through the existing broker/UI. On
allow, the server flips the persisted session mode to `'default'` so the next
turn executes normally. On deny, the session stays in plan mode.

### UI

- New `ModeSelector` component inside `.composer .box`, left of the attach
  button: a small button showing the current mode label, opening an upward
  menu (Auto / Accept edits / Plan / Skip permissions — the last styled as
  danger). Selecting calls `patchSession(sessionId, { permissionMode })`.
- `PermissionModeGate` is removed. Sessions are created with the preferences
  default (existing inheritance) resolved to `'default'` when unset — the
  `null` "unanswered" state and the composer-disabled gate disappear.
- The existing "Skip permissions" warning chip stays.

## B. Sticky user messages

- Each `.msg.user` block in `.messages` gets `position: sticky; top: 0` with
  an opaque background and z-index above scrolled content. While reading a
  turn's response, its user prompt stays pinned; the latest user message is
  therefore always visible.
- Collapse: when the rendered message exceeds ~200px (measured via
  `scrollHeight`), cap it at `max-height: 200px` with a bottom fade and make
  the block clickable. Click toggles expanded (local state per message);
  expanded removes the cap; click again collapses. Messages that fit are
  untouched (no pointer affordance).

## Testing

- Server unit: canUseTool routing per mode (4 modes × representative tools),
  plan option presence in QueryOptions, ExitPlanMode allow → mode flips to
  default (deny → stays plan).
- Web component: ModeSelector renders modes, selection patches the session;
  MessageItem collapse/expand toggle; App no longer blocks composer on
  fresh sessions.
- Known lesson applied: tests registering a project override
  `listSessions: async () => []`.
