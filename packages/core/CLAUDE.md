# Core package rules

`packages/core` is the shared foundation for Atelier's frontend: utility types,
pure utils, and framework-level hooks.

## App isolation (critical)

Core must NEVER import from any app (`apps/web`, `apps/server`, `apps/desktop`),
and never from `@atelier/shared` — the wire protocol is a contract between the
app and the server, not a frontend primitive. If core needs app-specific
behaviour, take it as a parameter (callback, config object) instead.

## What belongs here

- `types/`: types with no domain meaning — `Stylable`, `Dictionary`, `Maybe`.
  Anything that mentions a session, a widget or a PR belongs in the app.
- `utils/`: pure functions, one exported function per file, file named after it
  in kebab-case (`error-message.ts` exports `errorMessage`).
- `hooks/`: React hooks that would be at home in any React app (`useDebounce`).
  A hook that calls the Atelier API belongs in the feature that owns it.

## Error classes

A domain error extends `Error`, takes a required `message`, calls
`super(message)`, and sets `this.name` to the `Domain_Error` form:

```typescript
export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Domain_Error'
  }
}
```
