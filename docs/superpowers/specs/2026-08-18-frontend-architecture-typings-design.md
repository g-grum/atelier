# Frontend architecture and shared typings

Date: 2026-08-18
Status: approved

## Goal

Bring the typing vocabulary and the project structure of `dylogy-frontend` into
Atelier's React app: shared utility types (`Stylable`, `Dictionary`, `Maybe`,
`PropsWithRef`, `NonNullableProps`) in a `packages/core` package, and
`apps/web/src` reorganised into feature areas following dylogy's Folder
convention.

## Scope decisions

- A new `packages/core` holds types, utils and hooks. No `packages/design-system`
  and no `packages/api` for now: `apps/web` is their only consumer, so extracting
  them would add indirection without a second caller.
- `packages/shared` keeps its single responsibility: the client/server protocol.
- `WithRouterUrl` is not ported — Atelier has no router.
- `i18n/`, `contexts/`, `storybook-helpers/` and `.stories` files are not
  introduced: Atelier is English-only and has no Storybook. The Folder convention
  allows them the day they are needed.

## Section 1 — `packages/core`

```
packages/core/
  package.json          # @atelier/core; exports ".", "./types", "./utils", "./hooks"; react as peerDep
  tsconfig.json
  CLAUDE.md             # isolation rule: core never imports from apps/*
  types/
    common.ts           # Maybe<T>, Dictionary<T = string>, NonNullableProps<T, K>
    react.ts            # Stylable, PropsWithRef<P, T>
  utils/
    cn.ts               # moved from apps/web/src/lib/utils.ts
    errors.ts           # domain error classes, this.name = 'Domain_Error'
  hooks/
```

Types are taken from `dylogy-frontend/packages/core/utils/types.ts`. Two
deliberate departures from dylogy's implementation:

1. Types live in `types/`, not `utils/types.ts` — dylogy's own documented
   convention, which its implementation predates.
2. Cross-package resolution uses `package.json` `exports` with bun workspaces,
   Atelier's existing mechanism, rather than dylogy's `tsconfig` paths.

## Section 2 — `apps/web/src` structure

```
apps/web/src/
  main.tsx  App.tsx  App.test.tsx  styles.css
  components/                  # shared shell, folder-per-component
    topbar/  error-banner/
  ui/                          # shadcn primitives, folder-per-component, kebab-case files
    button/  dialog/  dropdown-menu/  input/  sonner/  tooltip/
  features/
    chat/
      components/{chat-view,composer,message-item,tool-call-item,markdown-body,
                  permission-prompt,permission-mode-gate,question-prompt,
                  modified-files-panel}/
      utils/{file-mentions.ts,slash-commands.ts}
    sessions/
      components/{session-sidebar,session-list-item,delete-session-dialog}/
      utils/last-session.ts
    settings/
      components/{settings-panel,model-selector,theme-toggle,rate-limits-panel,
                  github-account-chip}/
      utils/{models.ts,theme.ts}
    dashboard/
      components/{dashboard-grid,widget-frame,autopilot-widget,
                  autopilot-config-dialog,dev-servers-widget,pr-list-widget,
                  pr-config-dialog}/
      utils/{reorder.ts,widget-registry.ts}
  api/                         # client, backend, ws, status-socket
  stores/                      # session-controller, session-status-store, stream-reducer
  mocks/fixtures.ts
```

`api/` and `stores/` stay at the app root rather than moving into a feature. The
import graph justifies it: the `api/*` modules form one coupled cluster consumed
by the shell, chat and settings; `stream-reducer` is consumed by five chat
components plus `Topbar` and `ErrorBanner`; `session-controller` by `App` and
`api/backend`. Pushing them into a feature would create cross-feature imports,
which the structure forbids.

Naming follows dylogy: PascalCase components in files matching the component
name, kebab-case folders and utils, `.test` suffix, tests colocated with the
component they cover.

## Section 3 — conventions and guardrails

- `docs/project-structure.md`, adapted from dylogy: naming convention, the closed
  list of allowed folders (`api|assets|components|contexts|features|hooks|i18n|
  mocks|routes|stores|test-utils|types|ui|utils`), and the import rules.
- Import rules: `packages/*` never imports from `apps/*`; `apps/*` are isolated
  from each other; features never import from each other — anything two features
  need moves up to `components/`, `stores/`, `api/` or `@atelier/core`.
- Enforcement: `tsconfig` paths prevent aliased cross-domain resolution, but they
  do not stop a relative `../../features/chat` import. A test that scans import
  statements covers that gap, so the rule is actually enforced rather than merely
  documented.
- `CLAUDE.md` per package and app, describing where a new module belongs.

## Section 4 — migration and verification

Five commits, each leaving the repository green:

1. `packages/core` created; `apps/web` depends on it; `lib/utils.ts` re-exports
   `cn` so no call site changes yet.
2. Typings adopted across web props and signatures. No file moves — this is the
   commit that answers the original request, kept separate to stay reviewable.
3. `features/` restructure via `git mv`, imports rewritten to `@/features/...`.
4. `state/` becomes `stores/` + `mocks/`; `lib/` disappears.
5. Docs, per-package `CLAUDE.md`, and the import guard test.

Verification per commit: `bun test`, `tsc --noEmit` on web and core, and
`bun run build:web`. The existing suite — 30+ component test files, 864 tests
green at baseline — is what makes this refactor safe. No new tests are written
for the moves, since behaviour does not change; the only added test is the import
guard in commit 5.

Finally the app is launched (`dev:server` + `dev:web`) and chat, dashboard and
settings are exercised: a green build does not prove that a dynamic import or an
asset path survived.
