# Atelier — design

Date: 2026-07-02 · Status: validated with owner (Germain) through brainstorming; visual reference = mockup artifact v4.2.

## Purpose

Personal desktop app embedding Claude Code through the official Claude Agent SDK. It replaces the terminal for daily use and doubles as a portfolio piece: visual session management (name, create, resume, fork), streaming chat with interactive tool permissions, real-time usage with limit forecasting, per-session model selection, repo activity (merges/PRs), and one-click "open in WebStorm at file:line".

## Success criteria

1. Daily driver: Germain runs his real Claude Code sessions in it — no lost conversation, ever.
2. Portfolio: a polished web demo (mocked backend, zero API key) plus a clean README make the project self-explanatory to a recruiter in under two minutes.

## Architecture

Bun-workspaces monorepo, four units with strict boundaries:

| Unit | Role | Depends on |
|---|---|---|
| `apps/desktop` | Electron shell only: spawns the server, opens the window, single-instance lock, injects the auth token into the SPA. No business logic. | server (spawn) |
| `apps/server` | Bun + Hono. Owns the Agent SDK, the permission broker, `gh` queries, IDE opening, app data. | shared |
| `apps/web` | React + Vite + Tailwind + shadcn SPA. Talks HTTP/WS to localhost only — zero Electron imports. | shared |
| `packages/shared` | Protocol types: WS events, REST DTOs. The single contract between server and web. | — |

The SPA never touches the SDK directly; the shell never touches business logic. Each unit is testable alone (see Testing).

### Server interface

REST:
- `GET /projects` · `POST /projects` (register a folder)
- `GET /projects/:id/sessions` — from SDK `listSessions()` (name, updatedAt, message count; if the SDK doesn't return a count, the server derives it from the session JSONL — the endpoint shape is fixed either way)
- `GET /sessions/:id/messages` — full history from SDK `getSessionMessages()`; loaded on resume and on WS resync. The WS carries live traffic only, never replays history.
- `POST /projects/:id/sessions` `{ name?, model? }` (model defaults to the preference). The SDK has no createSession — a session id is born on the first `query()` turn. So this endpoint mints a **draft** (local id, kept in app data); the SDK session materializes on the first `user_message`, the server then maps draft id → SDK id, applies any deferred rename, and announces the mapping in the first `status` event after materialization (`{ draftId, sessionId }`) — the server keeps honoring the draft id on REST/WS afterwards. `GET .../sessions` returns the merge of SDK `listSessions()` and unsent drafts. `DELETE /sessions/:id` is valid for drafts (removes the app-data record; abandoned drafts don't linger). Forking a draft rejects (no SDK session yet — a v0.4 concern).
- `PATCH /sessions/:id` `{ name?, model? }` (rename and/or switch model — a model change applies from the next turn) · `POST /sessions/:id/fork` (v0.4)
- `DELETE /projects/:id` (unregister from app data only; never touches `~/.claude`)
- `GET /rules` · `DELETE /rules/:id` — always-allow rules (settings)
- `GET /preferences` · `PATCH /preferences` — IDE, default model
- `GET /usage/history` — persisted usage events for the gauges (v0.2; recording itself starts in v0.1 so the gauges are meaningful on day one of v0.2)
- `GET /projects/:id/activity` — `gh` (recent merges, open PRs + mergeable/checks) (v0.3)
- `POST /open-in-ide` `{ file, line? }`

This list is the end-state API; entries tagged with a milestone land then, untagged entries are v0.1. v0.1 expects a single registered project (UI shows one); the server does not enforce it.

WS `/sessions/:id/stream`:
- client → server: `user_message`, `permission_response { requestId, decision: allow|deny|always }`, `abort`
- server → client: `assistant_delta`, `tool_use { toolUseId, kind, summary, file?, line?, diffstat? }`, `tool_result { toolUseId, ok, summary }`, `permission_request { requestId, toolName, rendered command/input, proposedRule }`, `usage { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }`, `status { idle|streaming|error }` (sketches are indicative; `packages/shared` is the normative contract)
- On every (re)connect the server sends a `status` snapshot — including the **in-flight partial assistant text** of the current turn (the server buffers the live turn), so a mid-turn reconnect has no gap — **and re-emits any pending `permission_request`s**; broker state is not history, so reconnect recovery cannot rely on `getSessionMessages` for it.
- Queries from several sessions may stream concurrently; only an explicit `abort`, an app-level session close, or app quit ends one — switching sessions in the UI never does.
- Exact payload shapes and the `tool_use.kind` enum (Bash, Edit, Read, …, driving the color system) are defined once in `packages/shared`. Noted there: the `status.error` variant carries a reason and, for usage-limit errors, the reset time (the banner depends on it); `usage` includes cache-read/creation token counts (real traffic is cache-dominated and the forecast's fidelity depends on them).

Permission broker: the SDK `canUseTool` callback publishes a `permission_request` and awaits a pending promise resolved by the client's `permission_response`. No timeout — an unanswered request stays pending; closing the session aborts the query cleanly.

Always-allow rules (aligned with Claude Code's own allow-rule model, per project): `{ toolName, matcher }` where the matcher is a command prefix for Bash, a path glob for file tools (Edit/Write, defaulting to the project folder), and `null` (whole tool) only for tools without sensitive input (e.g. Read). **The server derives the proposed matcher** (Bash: the first two words of the command — binary + subcommand, e.g. `git push`, `bun validate`) and ships it in `permission_request.proposedRule`, so the UI shows exactly what "Always" will allow *before* the click. "Always" from a Bash prompt therefore allows that command prefix, never all of Bash. A stored rule matching in `canUseTool` auto-allows silently — no `permission_request` is published. Bash prefix matching is word-boundary (`git push` matches `git push origin x`, not `git pushx`). Rules persist in app data; the v0.1 settings panel lists and removes them (a mistaken "always" must be revocable in-app from day one) and holds the IDE/default-model preferences.

Security: server binds `127.0.0.1`; ephemeral token generated by the shell, required on every request; CORS locked to the app origin.

Serving the SPA: in the packaged app the server serves the built `apps/web` at `http://127.0.0.1:<port>` (no `file://`), which gives CORS a real origin and lets the shell inject the token via the initial URL. In dev, Vite serves the SPA and proxies to the server. The demo build swaps the server for the fixture backend, same origin model.

### Persistence

- Conversations: SDK-owned JSONL under `~/.claude` — the single source of truth. The app never writes them directly; the UI is a rebuildable cache.
- App data: one local JSON file — registered projects (path, identity color), preferences (IDE, default model), per-session model overrides (sessionId → model; the session's current model must survive resume and restart), session drafts and the draft→SDK-id map, always-allow rules, usage-event history (rolling 7 days, for the window/weekly gauges), fork lineage (parent session id → child session ids, for the v0.4 tree — the SDK does not expose fork ancestry).

## Functional scope by milestone

- **v0.1 — core (usable daily):** one project; session list/name/create/resume; streaming chat; collapsible tool calls typed by kind (color) with diffstat; interactive permission prompts; minimal settings panel (always-rules list/removal, IDE, default model — a mistaken "always" must be revocable in-app from day one); "Modified files" panel + per-tool-call **open in WebStorm at file:line**; model selector per session; real session token usage and usage-event recording (feeds the v0.2 gauges).
- **v0.2 — multi-projects + usage gauges:** registered folders with identity colors; sessions grouped per project; the 5-hour/weekly gauges and limit forecast (they need the persisted usage history to be meaningful).
- **v0.3 — repo dashboard:** merges today/this week (bar chart), open PRs with state, recent-merges timeline — all via `gh` server-side. `gh` missing or unauthenticated degrades the panel to an explanatory empty state, never an error.
- **v0.4 — visual fork:** `forkSession` (from the tip; forking from an arbitrary message is a later refinement) + navigable conversation tree from the app-data lineage (the portfolio signature).

Planning note: implementation plans are written one milestone at a time; the first plan covers v0.1 only.

Out of scope for v1: light theme, multi-window, automatic worktree-per-session, MCP configuration UI, mobile.

## Usage & limits (honest data policy)

- Session tokens and burn rate: **real**, from per-message SDK usage events.
- 5-hour window / weekly gauges and the "limit reached ~HH:MM" forecast: **local estimates** from a sliding window of the app's own usage events, user-calibratable; labelled "estimé" in the UI. No public API exposes plan limits — this is stated in the README too.

## UI

Visual reference: mockup v4.2 (artifact). Three zones: sidebar 262px (projects → sessions), chat (reading width ~48rem), right panel 306px (usage, model, modified files, activity, fork). Semantic color system — every color encodes information: project identity (cyan/magenta/violet), tool kind (Bash cyan, Edit violet), states (mint running/open, violet merged, red critical), amber reserved exclusively for permission prompts, usage bar gradient cyan→magenta with red threshold marker. Motion minimal and reduced-motion-aware.

## IDE opening

Default WebStorm: `webstorm://open?file=<abs>&line=<n>` (JetBrains Toolbox scheme), fallback to the `webstorm` CLI launcher with `--line`. Setting supports `vscode`, `cursor`, `idea` schemes. If the launcher/scheme fails: toast with the fix (install Toolbox launcher) and a copy-path fallback.

## Error handling

Guiding rule: the app can never lose a conversation (truth lives in `~/.claude`).
- WS drop → auto-reconnect, resync via `getSessionMessages` (idempotent).
- Usage limit hit mid-stream → explicit banner with reset time; session stays readable.
- `claude` binary missing / not logged in → onboarding screen, not a crash.
- Fork/rename failures surface as toasts with the SDK error message.
- Abort semantics: only the explicit `abort` event (or app-level session close) aborts the SDK query. A bare socket disconnect never does — the query keeps running and the client resyncs on reconnect (history via REST, broker state via the re-emitted `permission_request`s and `status` snapshot).

## Testing

- `packages/shared`: unit tests on event parsing/guards.
- `apps/server`: the SDK is wrapped behind an interface → integration tests with a mocked SDK, including the full permission round-trip (request → response → resume) and the always-rule persistence.
- `apps/web`: unit tests on the stream-event reducer; Testing Library on the permission prompt and session list.
- **Demo mode doubles as e2e harness:** recorded, anonymized session fixtures replayed by a mock backend — the same build powers the portfolio web demo and Playwright e2e runs (zero tokens spent).

## Demo mode (portfolio)

`apps/server` ships a `--demo` flag serving fixtures instead of the SDK; the SPA is unchanged. Deployment of the demo (e.g. Vercel) is deferred until the repo goes public.

## Naming & repo

Name: **Atelier**. Local-only for now: `~/workspace/atelier`, git initialized; remote/publication decided later (MIT license planned for publication).
