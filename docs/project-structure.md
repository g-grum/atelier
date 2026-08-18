# Project structure conventions

## Naming convention

- React components are ALWAYS in PascalCase
- React component files must ALWAYS match the name of the exported component
- Util methods are ALWAYS in camelCase
- Util method file names must match the name of the exported function, but in
  kebab-case (`error-message.ts` exports `errorMessage`)
- Folder names are ALWAYS in kebab-case
- Test files must ALWAYS match the name of the file they test, suffixed with
  `.test` before the extension (`Composer.test.tsx`, `reorder.test.ts`), and sit
  next to that file
- `ui/` primitives keep the kebab-case file names shadcn generates (`button.tsx`)

## Folder convention

An **area** is a section of an application (e.g. chat in
`apps/web/src/features/chat`). Each area's internal structure follows this same
`Folder convention`.

These are the allowed folders in the root of a structure that mentions
`Folder convention`:

- `api`: clients for the Atelier server's REST/WS surface
- `assets`: static assets — images, fonts
- `components`: custom React components
- `contexts`: React contexts for the current area
- `features`: contains areas, each following the `Folder convention`
- `hooks`: custom React hooks
- `mocks`: methods and data to create mock/fixture data
- `stores`: stores for the current area
- `test-utils`: reusable test helpers (rendering a hook/component with its providers)
- `types`: custom types
- `ui`: presentation primitives with no domain knowledge (shadcn components)
- `utils`: utility functions

`i18n/` and `routes/` are part of the convention but unused today: Atelier is
English-only and has no router.

## Structure description

### Root

- `apps`: independent applications — `web` (React), `server` (Bun/Hono),
  `desktop` (Electron shell)
- `packages`: shareable packages — `core` (types, utils, hooks) and `shared`
  (the client/server wire protocol)
- `docs`: documentation
- `scripts`: repository tooling (icons, packaging, structure checks)

### Components

Every component lives in a self-contained folder named after it in kebab-case.
At the root of that folder you should ONLY find:

- the component file itself
- its test file

Anything else related to the component goes in a folder following the
`Folder convention` (`utils/`, `hooks/`, `types/`…).

```
features/chat/components/composer/
  Composer.tsx
  Composer.test.tsx
```

### Where a new module goes (`apps/web`)

- Used by one feature → inside that feature (`features/<area>/components|utils|hooks`)
- Used by two features or by the shell → up one level: `components/` (shell
  chrome), `stores/`, `api/`, or `ui/` for a domain-free primitive
- No Atelier domain knowledge at all → `packages/core`

## Structure relations

A **domain** is any direct subfolder of `/apps` or `/packages`.

- `apps/*` domains are isolated: none may be imported by another domain
- `packages/*` is the shared library: any domain may import it
- a `packages/*` domain may only import other `packages/*`, never `apps/*`
- `packages/core` may not import `@atelier/shared`: the wire protocol is a
  contract between the app and the server, not a frontend primitive
- features never import each other. Anything two features need moves up to
  `components/`, `stores/`, `api/`, `ui/` or `@atelier/core`

Imports inside `apps/web` use the `@/` alias (`@/stores/stream-reducer`), except
between files of the same component folder.

These rules are enforced by `scripts/check-structure.ts`, run as part of
`bun test`. The tsconfig paths alone would not catch a relative
`../../features/chat`.
