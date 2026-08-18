# Desktop Install Docs, App Icon Fix & First-Launch Onboarding Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the installed macOS app icon, document the desktop install in the README, and give first-time users a guided empty state plus a 4-step feature tour.

**Architecture:** The icon fix is a bounded diagnostic on the existing `@electron/packager` pipeline. Onboarding is a new `features/onboarding` area in `apps/web`: a `WelcomePanel` rendered by `App` when the projects list resolves empty, and a custom `Tour` (positioned popovers over a dimmed backdrop, no new dependency) triggered once after the first project registration, persisted via a new optional `hasCompletedTour` boolean in server preferences.

**Tech Stack:** Bun (test runner + scripts), React 19 + @testing-library/react, TanStack Query v5, Hono (server routes), @electron/packager.

**Spec:** `docs/superpowers/specs/2026-08-18-desktop-install-icon-onboarding-design.md`

**Conventions that apply to every task:** all new copy, comments and test names in English. Commit messages: plain conventional commits, no attribution or AI mentions (repo rule). Run tests with `bun test <path>` from the repo root.

---

## Chunk 1: Icon fix + README

### Task 1: Diagnose and fix the installed app icon

The packaging pipeline already wires an icon (`scripts/make-icons.ts` → `apps/desktop/build/icon.icns`; `scripts/package-mac.ts` passes `icon: icnsPath` to `@electron/packager`), yet the installed `~/Applications/Atelier.app` shows the default Electron icon. This is a stop-at-first-success diagnostic, not TDD.

**Files:**
- Possibly modify: `scripts/package-mac.ts`
- Read only: `scripts/make-icons.ts`, `assets/logo.svg`

- [ ] **Step 1: Inspect the currently installed bundle**

Run:
```bash
ls ~/Applications/Atelier.app/Contents/Resources/*.icns
plutil -p ~/Applications/Atelier.app/Contents/Info.plist | grep -i icon
```
Interpret:
- `.icns` present AND `CFBundleIconFile` points at it → the bundle is correct; the problem is a stale macOS icon cache (go to Step 4 after repackaging).
- `.icns` missing or `CFBundleIconFile` still `electron.icns` while the file was replaced/absent → packager option issue (go to Step 2, then fix in Step 3).

- [ ] **Step 2: Regenerate the icon and validate it**

Run:
```bash
bun run make:icons
open apps/desktop/build/icon.icns   # must render the Atelier logo in Preview
```
If Preview shows nothing or an error, fix `scripts/make-icons.ts` first (out of expected scope — surface to the human if the .icns itself is broken).

- [ ] **Step 3: Repackage and verify the fresh bundle BEFORE blaming the cache**

Run:
```bash
bun run package:mac
ls dist-app/Atelier-darwin-arm64/Atelier.app/Contents/Resources/*.icns
plutil -p dist-app/Atelier-darwin-arm64/Atelier.app/Contents/Info.plist | grep -i icon
```
Expected: an `.icns` whose bytes match `apps/desktop/build/icon.icns` (`cmp` them) and a `CFBundleIconFile` naming it. If the fresh bundle is wrong, fix `scripts/package-mac.ts` (e.g. pass the icon path without the `.icns` extension, which some packager versions require: `icon: icnsPath.replace(/\.icns$/, '')`) and repackage. Note: `package:mac` installs to `~/Applications` as part of the script.

- [ ] **Step 4: Clear the icon cache only if a correct bundle still shows the old icon**

Run:
```bash
touch ~/Applications/Atelier.app
killall Finder Dock
```
If still stale, re-register with LaunchServices:
```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f ~/Applications/Atelier.app
```

- [ ] **Step 5: Verify acceptance and commit (only if code changed)**

Acceptance: `Atelier.app` shows the Atelier logo in Finder, the Dock (launch it), and the app switcher.
If `scripts/package-mac.ts` was modified:
```bash
git add scripts/package-mac.ts
git commit -m "fix(desktop): ensure packaged app bundles the Atelier icon"
```
If nothing changed (pure cache issue), no commit — note the outcome for the final report.

### Task 2: README "Install the desktop app" section

**Files:**
- Modify: `README.md` (lines 113–118, the `Desktop app:` block)

- [ ] **Step 1: Replace the desktop block**

Replace:
```markdown
Desktop app:

```bash
bun run dev:desktop     # build web + launch Electron
bun run package:mac     # package a macOS .app
```
```
with:
```markdown
### Install the desktop app (macOS)

```bash
bun run package:mac
```

This builds the web UI, bundles it with the embedded server into a
self-contained `Atelier.app`, and installs it to `~/Applications`. Launch it
from there — no dev servers, no token setup: the app spawns its own server
and reuses your local Claude Code credentials.

Prerequisites are the same as above (Bun ≥ 1.2, a Claude Code-authenticated
environment). To iterate on the shell instead, `bun run dev:desktop` builds
the web UI and launches Electron against your working tree.
```

- [ ] **Step 2: Proofread rendering and commit**

Run: `grep -n "Install the desktop app" README.md` (section present, heading level `###` fits under `## Getting started`).
```bash
git add README.md
git commit -m "docs: explain how to install the desktop app"
```

## Chunk 2: Preferences flag (shared type + server)

### Task 3: `hasCompletedTour` preference

**Files:**
- Modify: `packages/shared/src/protocol.ts` (Preferences type, ~line 39)
- Modify: `apps/server/src/routes/settings-routes.ts` (PATCH /preferences validation)
- Test: `apps/server/src/app.test.ts` (existing preferences section, ~line 397)

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/app.test.ts`, after the existing PATCH /preferences tests (follow their exact fetch/auth pattern — copy the shape of the `defaultPermissionMode` test at line 420):

```ts
test('PATCH /api/preferences persists hasCompletedTour', async () => {
  const { app, headers, reload } = await makeApp()
  const res = await app.request('/api/preferences', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ hasCompletedTour: true }),
  })
  expect(res.status).toBe(200)
  const reloaded = await reload()
  expect(reloaded.get().preferences.hasCompletedTour).toBe(true)
})

test('PATCH /api/preferences rejects a non-boolean hasCompletedTour', async () => {
  const { app, headers } = await makeApp()
  const res = await app.request('/api/preferences', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ hasCompletedTour: 'yes' }),
  })
  expect(res.status).toBe(400)
})
```

NOTE: `makeApp`/`headers`/`reload` are placeholders for whatever helper the surrounding tests actually use — mirror the neighboring `PATCH /api/preferences persists defaultPermissionMode and survives a reload` test verbatim (same setup helper, same request shape), changing only the field.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/server/src/app.test.ts -t hasCompletedTour`
Expected: BOTH tests FAIL — the PATCH handler writes preferences through a per-field whitelist inside `data.update` (settings-routes.ts ~line 98), so an unknown key is silently dropped (persist test: `undefined` after reload) and unvalidated (rejection test: 200 instead of 400).

- [ ] **Step 3: Add the type and the validation**

`packages/shared/src/protocol.ts`, inside `Preferences` after `defaultPermissionMode`:
```ts
  /** First-launch feature tour completed (or skipped). Absent = false (pre-existing installs never see the tour — it only triggers on a first registration). */
  hasCompletedTour?: boolean
```

`apps/server/src/routes/settings-routes.ts`, in the PATCH handler next to the other field guards (English message — new user-facing strings are English even though legacy guards are French):
```ts
    if (parsed.hasCompletedTour !== undefined && typeof parsed.hasCompletedTour !== 'boolean') {
      return c.json({ error: 'invalid request: "hasCompletedTour" must be a boolean' }, 400)
    }
```

AND the write line — the handler persists through a per-field whitelist, so without it the value is validated but never stored. Inside the existing `data.update((d) => { ... })` block (~line 98), after the `defaultPermissionMode` branch:
```ts
      if (parsed.hasCompletedTour !== undefined) d.preferences.hasCompletedTour = parsed.hasCompletedTour as boolean
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/src/app.test.ts`
Expected: all PASS (full file, to catch validation-order regressions).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol.ts apps/server/src/routes/settings-routes.ts apps/server/src/app.test.ts
git commit -m "feat(server): hasCompletedTour preference for the first-launch tour"
```

## Chunk 3: Guided empty state

### Task 4: WelcomePanel component

**Files:**
- Create: `apps/web/src/features/onboarding/components/welcome-panel/WelcomePanel.tsx`
- Test: `apps/web/src/features/onboarding/components/welcome-panel/WelcomePanel.test.tsx`
- Modify: `apps/web/src/styles.css` (append)

- [ ] **Step 1: Write the failing test**

```tsx
import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WelcomePanel } from '@/features/onboarding/components/welcome-panel/WelcomePanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

describe('WelcomePanel', () => {
  test('renders the three getting-started steps', () => {
    render(<WelcomePanel onGetStarted={() => {}} />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0].textContent).toContain('Register a project')
    expect(items[1].textContent).toContain('Start a session')
    expect(items[2].textContent).toContain('Watch the dashboard')
  })

  test('the primary button fires onGetStarted', () => {
    let called = 0
    render(<WelcomePanel onGetStarted={() => called++} />)
    fireEvent.click(screen.getByRole('button', { name: /register your first project/i }))
    expect(called).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/features/onboarding/components/welcome-panel/WelcomePanel.test.tsx`
Expected: FAIL — cannot resolve `WelcomePanel`.

- [ ] **Step 3: Implement WelcomePanel**

```tsx
export type WelcomePanelProps = {
  /** Focuses the register-project form in the sidebar — the form is already visible when no project exists. */
  onGetStarted: () => void
}

/**
 * First-launch empty state (spec 2026-08-18): shown by App in the chat zone
 * while the projects list is resolved and empty. No persisted flag — it
 * disappears once a project exists.
 */
export function WelcomePanel({ onGetStarted }: WelcomePanelProps) {
  return (
    <section className="welcome" aria-label="Welcome">
      <h1>Welcome to Atelier</h1>
      <p>A control room for Claude Code: chat with your sessions, watch their status live, and keep a project dashboard in the same window.</p>
      <ol>
        <li>
          <strong>Register a project</strong> — point Atelier at a repository folder.
        </li>
        <li>
          <strong>Start a session</strong> — chat with Claude inside that project.
        </li>
        <li>
          <strong>Watch the dashboard</strong> — plan limits, modified files, dev servers and PRs.
        </li>
      </ol>
      <button type="button" className="new-btn" onClick={onGetStarted}>
        Register your first project
      </button>
    </section>
  )
}
```

Append to `apps/web/src/styles.css`:
```css
/* First-launch welcome panel (spec 2026-08-18) */
.welcome {
  margin: auto;
  max-width: 420px;
  padding: 24px;
  text-align: left;
}
.welcome h1 {
  font-size: 20px;
  margin: 0 0 8px;
}
.welcome p {
  color: var(--muted-foreground, #888);
  margin: 0 0 16px;
}
.welcome ol {
  margin: 0 0 20px;
  padding-left: 20px;
  display: grid;
  gap: 8px;
}
```
(The real tokens in `styles.css` are `--color-muted`/`--t-muted` — use `var(--t-muted)` instead of the placeholder `var(--muted-foreground, #888)`; double-check with a grep before writing.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/features/onboarding/components/welcome-panel/WelcomePanel.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/onboarding apps/web/src/styles.css
git commit -m "feat(web): welcome panel component for the first-launch empty state"
```

### Task 5: App renders WelcomePanel when projects resolve empty

**Files:**
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/App.test.tsx` (reuse the existing `fakeBackend` helper and render pattern — a `QueryClientProvider` wraps `<App backend={...} />`; mirror a neighboring test's `renderApp` usage exactly):

```tsx
describe('first-launch welcome', () => {
  test('shows the welcome panel when the projects list resolves empty', async () => {
    renderApp(fakeBackend({ listProjects: async () => [] }))
    expect(await screen.findByRole('button', { name: /register your first project/i })).toBeTruthy()
    // The composer is not rendered behind the welcome panel. Probe matches the
    // real composer (aria-label 'Reply to Claude', the query used by the
    // existing App tests) — do NOT loosen it to a regex that matches nothing.
    expect(screen.queryByLabelText('Reply to Claude')).toBeNull()
  })

  test('never flashes the welcome panel while projects load or on fetch error', async () => {
    renderApp(fakeBackend({ listProjects: () => new Promise(() => {}) }))
    expect(screen.queryByText(/welcome to atelier/i)).toBeNull()

    cleanup()
    renderApp(fakeBackend({ listProjects: async () => Promise.reject(new Error('down')) }))
    await screen.findByText(/could not load projects/i)
    expect(screen.queryByText(/welcome to atelier/i)).toBeNull()
  })

  test('the welcome panel disappears once a project is registered', async () => {
    let registered = false
    renderApp(
      fakeBackend({
        listProjects: async () => (registered ? [project] : []),
        registerProject: async (path) => {
          registered = true
          return { id: 'p1', path, color: 'cyan', sessionCount: 0 }
        },
      }),
    )
    await screen.findByText(/welcome to atelier/i)
    fireEvent.change(screen.getByLabelText('Project folder path'), { target: { value: '/tmp/demo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    await waitFor(() => expect(screen.queryByText(/welcome to atelier/i)).toBeNull())
  })
})
```

Adapt error-query retries: the projects query uses react-query defaults (retries), so either pass a `QueryClient` with `retry: false` (the existing `renderApp` already does if so — check) or use the existing failed-fetch test at line 93 as the template.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/web/src/App.test.tsx -t "first-launch welcome"`
Expected: FAIL — the welcome panel does not exist yet.

- [ ] **Step 3: Wire WelcomePanel into App**

In `apps/web/src/App.tsx`:

Import:
```tsx
import { WelcomePanel } from '@/features/onboarding/components/welcome-panel/WelcomePanel'
```

After the `projectsStatus` declaration (~line 213):
```tsx
  // First-launch empty state (spec 2026-08-18): only a RESOLVED empty list
  // shows the welcome — pending renders the normal shell (no flash), and a
  // fetch error keeps the sidebar's retry card as the single error surface.
  const showWelcome = projectsStatus === 'success' && projects.length === 0
```

In the JSX, wrap the chat-zone content (`ChatView` + `PermissionModeGate` + bypass chip + `Composer`) so the welcome replaces it — the banners above stay mounted:
```tsx
        <main className="chat">
          <ErrorBanner status={stream.status} error={stream.error} />
          {/* ...existing notice and openFailure banners unchanged... */}
          {showWelcome ? (
            <WelcomePanel
              onGetStarted={() => {
                // The sidebar's register form is already visible when no
                // project exists — the button just moves focus into it.
                document.querySelector<HTMLInputElement>('.register input')?.focus()
              }}
            />
          ) : (
            <>
              <ChatView ... />
              {needsPermissionChoice && <PermissionModeGate ... />}
              {activeSession?.permissionMode === 'bypassPermissions' && ( ... )}
              <Composer ... />
            </>
          )}
        </main>
```
(`...` = the existing props, byte-for-byte unchanged; only the wrapping conditional is new.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/App.test.tsx`
Expected: all PASS — the full file, to catch regressions in existing empty-sidebar tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): guided welcome panel when no project is registered"
```

## Chunk 4: Feature tour

### Task 6: Tour component + step definitions

**Files:**
- Create: `apps/web/src/features/onboarding/components/tour/tour-steps.ts`
- Create: `apps/web/src/features/onboarding/components/tour/Tour.tsx`
- Test: `apps/web/src/features/onboarding/components/tour/Tour.test.tsx`
- Modify: `apps/web/src/styles.css` (append)
- Modify: `apps/web/src/features/settings/components/settings-panel/SettingsPanel.tsx` (add `data-tour="settings"` to the trigger button)

- [ ] **Step 1: Create the step definitions**

`tour-steps.ts`:
```ts
/** One coach-mark step: `anchor` is a CSS selector resolved at render time. */
export type TourStep = { anchor: string; title: string; body: string }

/**
 * First-launch tour (spec 2026-08-18). Anchors use existing stable class
 * names where the shell already has them, and data-tour attributes elsewhere.
 * A missing anchor skips its step — never crashes the tour.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  { anchor: '.sidebar', title: 'Projects & sessions', body: 'Your projects and their sessions live here. Use “+ Session” to start a new conversation.' },
  { anchor: '.composer', title: 'Talk to Claude', body: 'Type here to work with Claude. Slash commands and @file mentions are supported.' },
  { anchor: '.dash', title: 'Dashboard', body: 'Live widgets: plan limits, modified files, dev servers, GitHub PRs. Drag cards to rearrange.' },
  { anchor: '[data-tour="settings"]', title: 'Settings', body: 'IDE, default model, theme and permission defaults are managed here.' },
]
```

- [ ] **Step 2: Write the failing tests**

`Tour.test.tsx`:
```tsx
import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tour } from '@/features/onboarding/components/tour/Tour'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
  document.querySelectorAll('[data-test-anchor]').forEach((el) => el.remove())
})

/** Mounts fake anchor elements the steps can attach to. */
function mountAnchors(selectors: string[]) {
  for (const selector of selectors) {
    const el = document.createElement('div')
    if (selector.startsWith('.')) el.className = selector.slice(1)
    else el.setAttribute('data-tour', 'settings')
    el.setAttribute('data-test-anchor', '')
    document.body.appendChild(el)
  }
}

const ALL_ANCHORS = ['.sidebar', '.composer', '.dash', '[data-tour="settings"]']

describe('Tour', () => {
  test('walks through the steps with Next and finishes with Done', () => {
    mountAnchors(ALL_ANCHORS)
    let finished = 0
    render(<Tour onFinish={() => finished++} />)
    expect(screen.getByText('Projects & sessions')).toBeTruthy()
    expect(screen.getByText('1/4')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Talk to Claude')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('4/4')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(finished).toBe(1)
  })

  test('Skip finishes immediately', () => {
    mountAnchors(ALL_ANCHORS)
    let finished = 0
    render(<Tour onFinish={() => finished++} />)
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(finished).toBe(1)
  })

  test('Escape finishes the tour like Skip', () => {
    mountAnchors(ALL_ANCHORS)
    let finished = 0
    render(<Tour onFinish={() => finished++} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(finished).toBe(1)
  })

  test('a missing anchor skips its step instead of crashing', () => {
    mountAnchors(['.sidebar', '.dash', '[data-tour="settings"]']) // no .composer
    render(<Tour onFinish={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    // Step 2 (.composer) is skipped — the tour lands on the dashboard step.
    expect(screen.getByText('Dashboard')).toBeTruthy()
  })

  test('all anchors missing finishes immediately without rendering', () => {
    let finished = 0
    render(<Tour onFinish={() => finished++} />)
    expect(finished).toBe(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test apps/web/src/features/onboarding/components/tour/Tour.test.tsx`
Expected: FAIL — cannot resolve `Tour`.

- [ ] **Step 4: Implement Tour**

`Tour.tsx`:
```tsx
import { useEffect, useMemo, useState } from 'react'
import { TOUR_STEPS } from '@/features/onboarding/components/tour/tour-steps'

export type TourProps = {
  /** Called exactly once when the tour ends — Done, Skip or Escape all persist the flag (spec 2026-08-18). */
  onFinish: () => void
}

/**
 * First-launch coach marks: a dimmed backdrop plus one positioned popover per
 * step. Anchors are resolved lazily per render; a missing anchor (layout
 * changed) skips its step rather than crashing.
 */
export function Tour({ onFinish }: TourProps) {
  const [index, setIndex] = useState(0)

  // First step at or after `index` whose anchor exists in the DOM.
  const resolved = useMemo(() => {
    for (let i = index; i < TOUR_STEPS.length; i++) {
      const el = document.querySelector(TOUR_STEPS[i].anchor)
      if (el !== null) return { i, step: TOUR_STEPS[i], rect: el.getBoundingClientRect() }
    }
    return null
  }, [index])

  // Ran out of anchored steps (Done clicked past the last one, or nothing to
  // anchor to at all) → finish. Effect, not render-time call: onFinish sets
  // parent state.
  const exhausted = resolved === null
  useEffect(() => {
    if (exhausted) onFinish()
  }, [exhausted, onFinish])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onFinish()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onFinish])

  if (resolved === null) return null
  const { i, step, rect } = resolved
  const isLast = TOUR_STEPS.slice(i + 1).every((s) => document.querySelector(s.anchor) === null)

  // Clamped fixed position next to the anchor — simple and robust across the
  // 3-zone layout; no collision library for 4 static steps (YAGNI).
  const top = Math.min(Math.max(rect.top + 16, 16), window.innerHeight - 200)
  const left = Math.min(Math.max(rect.right + 16, 16), window.innerWidth - 296)

  return (
    <div className="tour-backdrop">
      <div className="tour-pop" role="dialog" aria-label={step.title} style={{ top, left }}>
        <h2>{step.title}</h2>
        <p>{step.body}</p>
        <footer>
          <span className="tour-count">{`${i + 1}/${TOUR_STEPS.length}`}</span>
          {!isLast && (
            <button type="button" className="banner-btn" onClick={onFinish}>
              Skip
            </button>
          )}
          <button type="button" className="new-btn" onClick={() => (isLast ? onFinish() : setIndex(i + 1))}>
            {isLast ? 'Done' : 'Next'}
          </button>
        </footer>
      </div>
    </div>
  )
}
```

NOTE for the implementer: the popover is a plain positioned div rather than a Radix Popover — the spec's real constraint is "no new dependency + theme-consistent"; Radix anchoring adds nothing for 4 static steps (deliberate simplification, not a missed requirement). The test "all anchors missing finishes immediately" requires the `useEffect` finish path; jsdom/happy-dom gives zeroed rects — position math still runs, that is fine. If `screen.getByText('1/4')` fails because of the template string, query `screen.getByText(/1\s*\/\s*4/)`.

Append to `apps/web/src/styles.css`:
```css
/* First-launch tour (spec 2026-08-18) */
.tour-backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.45);
  z-index: 60;
}
.tour-pop {
  position: fixed;
  width: 280px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--background, #1b1b1f);
  border: 1px solid var(--border, #333);
  box-shadow: 0 8px 32px rgb(0 0 0 / 0.4);
}
.tour-pop h2 {
  font-size: 14px;
  margin: 0 0 6px;
}
.tour-pop p {
  font-size: 13px;
  margin: 0 0 12px;
}
.tour-pop footer {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tour-count {
  margin-right: auto;
  font-size: 12px;
  opacity: 0.7;
}
```
(As in Task 4: swap the CSS variable names for the ones `styles.css` actually defines — grep an existing dialog/panel rule and reuse its background/border tokens.)

- [ ] **Step 5: Add the settings anchor**

In `apps/web/src/features/settings/components/settings-panel/SettingsPanel.tsx`, add `data-tour="settings"` to the gear trigger button (the element the user clicks to open the dialog — locate the `DialogTrigger`/button at the top of the JSX). Attribute only, no behavior change.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test apps/web/src/features/onboarding`
Expected: PASS (WelcomePanel 2 + Tour 5).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/onboarding apps/web/src/styles.css apps/web/src/features/settings/components/settings-panel/SettingsPanel.tsx
git commit -m "feat(web): first-launch feature tour with coach marks"
```

### Task 7: Tour trigger + persistence wiring in App

**Files:**
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `App.test.tsx`, extend the `first-launch welcome` describe (reuse the register-flow test's backend shape from Task 5):

```tsx
  test('registering the first project from the welcome state starts the tour', async () => {
    let registered = false
    renderApp(
      fakeBackend({
        listProjects: async () => (registered ? [project] : []),
        registerProject: async (path) => {
          registered = true
          return { id: 'p1', path, color: 'cyan', sessionCount: 0 }
        },
        getPreferences: async () => ({ ...DEFAULT_PREFERENCES }), // no hasCompletedTour key → falsy
      }),
    )
    await screen.findByText(/welcome to atelier/i)
    fireEvent.change(screen.getByLabelText('Project folder path'), { target: { value: '/tmp/demo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    expect(await screen.findByText('Projects & sessions')).toBeTruthy()
  })

  test('finishing the tour persists hasCompletedTour', async () => {
    const patches: object[] = []
    let registered = false
    renderApp(
      fakeBackend({
        listProjects: async () => (registered ? [project] : []),
        registerProject: async (path) => {
          registered = true
          return { id: 'p1', path, color: 'cyan', sessionCount: 0 }
        },
        patchPreferences: async (patch) => {
          patches.push(patch)
          return { ...DEFAULT_PREFERENCES, ...patch }
        },
      }),
    )
    await screen.findByText(/welcome to atelier/i)
    fireEvent.change(screen.getByLabelText('Project folder path'), { target: { value: '/tmp/demo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    await screen.findByText('Projects & sessions')
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(patches).toContainEqual({ hasCompletedTour: true }))
    expect(screen.queryByText('Projects & sessions')).toBeNull()
  })

  test('a registration with existing projects never starts the tour', async () => {
    let projectFetches = 0
    renderApp(
      fakeBackend({
        listProjects: async () => {
          projectFetches++
          return [project]
        },
      }),
    )
    await screen.findByText('atelier') // sidebar rendered
    const fetchesBefore = projectFetches
    // Open the footer « + Project » form and register a second project.
    fireEvent.click(screen.getByRole('button', { name: '+ Project' }))
    fireEvent.change(screen.getByLabelText('Project folder path'), { target: { value: '/tmp/two' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    // Positive signal that onSuccess ran (the ['projects'] invalidation
    // refetches) — asserting absence on an already-absent probe would pass
    // trivially before the trigger even had a chance to misfire.
    await waitFor(() => expect(projectFetches).toBeGreaterThan(fetchesBefore))
    expect(screen.queryByText('Projects & sessions')).toBeNull()
  })

  test('hasCompletedTour true suppresses the tour after a first registration', async () => {
    let registered = false
    renderApp(
      fakeBackend({
        listProjects: async () => (registered ? [project] : []),
        registerProject: async (path) => {
          registered = true
          return { id: 'p1', path, color: 'cyan', sessionCount: 0 }
        },
        getPreferences: async () => ({ ...DEFAULT_PREFERENCES, hasCompletedTour: true }),
      }),
    )
    await screen.findByText(/welcome to atelier/i)
    fireEvent.change(screen.getByLabelText('Project folder path'), { target: { value: '/tmp/demo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    await waitFor(() => expect(screen.queryByText(/welcome to atelier/i)).toBeNull())
    expect(screen.queryByText('Projects & sessions')).toBeNull()
  })
```

NOTE: the Tour's anchors (`.sidebar`, `.composer`, `.dash`) exist in App's rendered DOM, so no fake anchors are needed here. The first-step title doubles as the "tour is visible" probe. The mock `getPreferences` in `fakeBackend` currently omits `theme` deliberately — keep that contract in overrides.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/web/src/App.test.tsx -t tour`
Expected: FAIL — no tour in App yet.

- [ ] **Step 3: Wire the trigger into App**

In `apps/web/src/App.tsx`:

Import:
```tsx
import { Tour } from '@/features/onboarding/components/tour/Tour'
```

Near the other queries:
```tsx
  // Tour flag — silent on failure: without data the trigger stays off rather
  // than showing the tour to someone who may have completed it.
  const preferencesQuery = useQuery({ queryKey: ['preferences'], queryFn: backend.getPreferences, retry: false })
```

State next to the other UI state:
```tsx
  /** Tour armed by the first registration from the welcome state (spec 2026-08-18). */
  const [tourRequested, setTourRequested] = useState(false)
```

Extend the existing `registerProject` mutation's `onSuccess` (react-query v5 invokes the latest render's callbacks, so `showWelcome` is current — same guarantee the deleteSession comment documents):
```tsx
  const registerProject = useMutation({
    mutationFn: backend.registerProject,
    // Failure surfaces through `registerProject.error` in the sidebar form.
    onSuccess: () => {
      // Tour trigger (spec 2026-08-18): ONLY a registration from the welcome
      // state — adding a project to an existing install never fires it. Gated
      // on isSuccess so a pending/failed preferences fetch keeps the trigger
      // OFF (never show the tour to someone who may have completed it).
      if (showWelcome && preferencesQuery.isSuccess && preferencesQuery.data.hasCompletedTour !== true) setTourRequested(true)
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
```
(`showWelcome` from Task 5 must be declared BEFORE this mutation — move the `showWelcome` line above the mutations block if needed.)

Finish handler (place near the other callbacks):
```tsx
  const finishTour = useCallback(() => {
    // UX first (spec error handling): the tour closes even if the PATCH
    // fails — worst case it re-arms on a future first-registration (practically never).
    setTourRequested(false)
    backend
      .patchPreferences({ hasCompletedTour: true })
      .then(() => queryClient.invalidateQueries({ queryKey: ['preferences'] }))
      .catch((error: unknown) => console.error('could not persist hasCompletedTour', error))
  }, [backend, queryClient])
```

Render, next to `<Toaster />`:
```tsx
      {tourRequested && <Tour onFinish={finishTour} />}
```

- [ ] **Step 4: Run the full web test suite**

Run: `bun test apps/web`
Expected: all PASS. Watch specifically for the Task 5 "welcome disappears" test still passing (the tour now mounts on top — its probe queries the welcome text, unaffected by the backdrop).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): trigger the feature tour after the first project registration"
```

### Task 8: End-to-end verification

- [ ] **Step 1: Full test suite**

Run: `bun test`
Expected: all PASS (780+ tests).

- [ ] **Step 2: Manual verify (fresh data dir)**

```bash
ATELIER_TOKEN=atelier-dev bun run dev:server -- --data /tmp/atelier-onboarding-verify &
bun run dev:web
```
Open http://localhost:4518 and check: welcome panel visible → "Register your first project" focuses the sidebar input → register a real folder → tour appears (4 steps, Next/Skip/Escape) → after Done, `cat /tmp/atelier-onboarding-verify/app-data.json` (or the file the `--data` flag actually points at — check `apps/server/src/cli-args.ts` for whether `--data` is a dir or a file) contains `"hasCompletedTour": true`. Reload the page, delete nothing: no tour. Adjust the `--data` invocation to the real CLI contract before running.
Give the user the URL and shut both servers down afterwards (report active servers per workspace convention).

- [ ] **Step 3: Icon acceptance recap**

Confirm (from Task 1) the installed `Atelier.app` shows the Atelier logo in Finder + Dock. If Task 1 required a repackage AFTER the onboarding work landed, run `bun run package:mac` once more so the installed app carries the final build.
