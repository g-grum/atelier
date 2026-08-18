# Web app rules

Read `docs/project-structure.md` first — naming, folder convention and import
rules live there. This file only covers what is specific to `apps/web`.

## Layout

```
src/
  App.tsx  main.tsx  styles.css     # shell: composes the features
  components/                       # shell chrome shared by features (topbar, error-banner)
  ui/                               # shadcn primitives, no domain knowledge
  features/{chat,sessions,settings,dashboard}/
  api/                              # REST + WS clients for the Atelier server
  stores/                           # session-controller, session-status-store, stream-reducer
  mocks/                            # fixtures replayed by the mock backend
```

## Where does my new code go?

- A component used by a single feature → `features/<area>/components/<kebab-name>/`
- A component used by two features or by `App` → `components/`
- A styling-only primitive → `ui/`
- A pure helper with Atelier meaning → `features/<area>/utils/`
- A pure helper with no Atelier meaning → `@atelier/core/utils/<name>`
- Mutable state shared across features → `stores/`

`api/` and `stores/` deliberately stay at the app root: the api modules are one
coupled cluster, and `stream-reducer` / `session-controller` are consumed by the
shell and by several features. Pushing them into a feature would force
cross-feature imports, which the structure forbids.

## Types

Reach for the shared vocabulary in `@atelier/core/types` instead of re-declaring
it: `Stylable` for a component styled by its parent, `PropsWithRef` when a ref is
forwarded, `Dictionary<T>` over `Record<string, T>`, `Maybe<T>` for
`T | null | undefined`. Do NOT replace a precise `string | null` with
`Maybe<string>` — that widens the type.

Domain types come from `@atelier/shared` (the wire protocol). Never redeclare a
protocol shape locally.
