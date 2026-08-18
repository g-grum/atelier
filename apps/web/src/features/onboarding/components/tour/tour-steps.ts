/** One coach-mark step: `anchor` is a CSS selector resolved at render time. */
export type TourStep = { anchor: string; title: string; body: string }

/**
 * First-launch tour (spec 2026-08-18). Anchors use existing stable class
 * names where the shell already has them, and data-tour attributes elsewhere.
 * A missing anchor skips its step — never crashes the tour.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    anchor: '.sidebar',
    title: 'Projects & sessions',
    body: 'Your projects and their sessions live here. Use \u201c+ Session\u201d to start a new conversation.',
  },
  {
    anchor: '.composer',
    title: 'Talk to Claude',
    body: 'Type here to work with Claude. Slash commands and @file mentions are supported.',
  },
  {
    anchor: '.dash',
    title: 'Dashboard',
    body: 'Live widgets: plan limits, modified files, dev servers, GitHub PRs. Drag cards to rearrange.',
  },
  {
    anchor: '[data-tour="settings"]',
    title: 'Settings',
    body: 'IDE, default model, theme and permission defaults are managed here.',
  },
]
