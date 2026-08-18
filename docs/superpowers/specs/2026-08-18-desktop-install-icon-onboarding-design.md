# Desktop install docs, app icon fix, and first-launch onboarding

Date: 2026-08-18
Status: approved by user (design phase)

## Goal

Three improvements to Atelier's first-contact experience:

1. The installed macOS app must show the Atelier icon (currently shows the default Electron icon).
2. The README must clearly explain how to install the desktop app (build-from-source; no release infrastructure).
3. First-time users must get in-app guidance: a guided empty state plus a short feature tour.

All new user-facing copy is in English.

## Non-goals

- No GitHub Releases, DMG, code signing with a Developer ID, or notarization.
- No Windows/Linux packaging.
- No API-key entry or environment checks (claude binary missing / not logged in) — still deferred.
- No localization work beyond writing the new copy in English.

## 1. Icon fix (investigate + verify)

Current state: `scripts/make-icons.ts` generates `apps/desktop/build/icon.icns` from
`assets/logo.svg`, and `scripts/package-mac.ts` passes it to `@electron/packager`
(`icon: icnsPath`). Despite this, the installed `~/Applications/Atelier.app` shows the
default Electron icon.

Plan (diagnostic sequence, stop at first success):

1. Regenerate icons (`bun run make:icons`) and validate the `.icns` opens in Preview.
2. Repackage (`bun run package:mac`) and check the installed app in Finder and the Dock.
3. If still default: inspect the packaged bundle — `Contents/Resources/*.icns` present?
   `CFBundleIconFile` set in `Contents/Info.plist`? Fix whichever is broken (packager
   option or post-package step in `package-mac.ts`).
4. Last resort: clear the macOS icon cache / re-register with LaunchServices, since a
   previously installed unbranded build can pin a stale icon.

Acceptance: freshly packaged and installed `Atelier.app` shows the Atelier logo in
Finder, the Dock, and the app switcher.

## 2. README — "Install the desktop app" section

Replace the current two-line desktop mention (Getting started, near the end) with a
dedicated subsection:

- What `bun run package:mac` produces: a self-contained `Atelier.app` (bundled web UI +
  server), installed to `~/Applications`, no dev servers needed afterwards.
- Prerequisites: same as dev (Bun >= 1.2, Claude Code-authenticated environment, macOS).
- Note that the app reuses local Claude Code credentials and needs no token setup.
- Keep `bun run dev:desktop` documented as the dev loop.

Tone: concise, English, no download links or release promises.

## 3. Guided empty state

Component: `apps/web/src/features/onboarding/components/WelcomePanel.tsx`.

Behavior:

- In `App.tsx`, when the projects query has resolved and the list is empty, render
  `WelcomePanel` in the chat zone instead of the empty `ChatView` + composer.
- Content: one-line "what Atelier is", three numbered steps (register a project → start
  a session → watch the dashboard), and a primary button that opens the existing
  register-project form in the sidebar (reuse the sidebar's existing open/focus
  mechanism; add a small callback or store flag if none exists).
- No persisted flag: the panel disappears naturally once a project exists, and comes
  back if all projects are removed. While the projects query is loading, render the
  normal shell (no flash of the welcome panel).

## 4. Feature tour (custom coach marks)

Decision: custom implementation on existing Radix/shadcn popover primitives (approach A).
Rejected: driver.js (fights theme tokens), react-joyride (heavy, React 19 lag).

Components: `apps/web/src/features/onboarding/components/Tour.tsx` plus a small step
definition module.

- ~4 sequential steps anchored via `data-tour="..."` attributes: session sidebar →
  composer → dashboard → settings gear.
- Each step: positioned popover with title, one sentence, step counter (1/4),
  Next / Skip buttons; final step shows Done. Dimmed backdrop over the rest of the UI;
  Escape skips.
- Trigger: shown once, right after the first project registration completes, when
  `preferences.hasCompletedTour` is falsy.
- Persistence: new optional boolean `hasCompletedTour` in server preferences
  (`~/.atelier/app-data.json`, `apps/server/src/store/app-data.ts`), default `false`,
  set `true` via the existing preferences update API on Done or Skip. Server-side so it
  survives browser/desktop switches. Missing field (existing installs) reads as `false`;
  since the tour only triggers on first project registration, existing users with
  projects never see it.

## Data flow

- Empty state: driven purely by the existing projects react-query cache.
- Tour: `registerProject` success + `preferences.hasCompletedTour === false` → mount
  Tour → on Done/Skip → `PATCH` preferences (existing endpoint) → react-query cache
  updates → Tour unmounts.

## Error handling

- Preferences PATCH failure on tour completion: close the tour anyway (UX first), log
  the error; worst case the tour re-triggers once on a future first-project event
  (practically never).
- Missing tour anchor (layout changed): skip that step rather than crash.

## Testing

- Unit (English test names): WelcomePanel renders iff projects resolved empty; Tour
  trigger condition (first registration + flag falsy); flag persists via preferences
  API; missing-anchor step skip.
- Manual verify pass: fresh `--data` dir → welcome panel → register project → tour →
  `hasCompletedTour: true` written → repackage → installed app shows Atelier icon.
