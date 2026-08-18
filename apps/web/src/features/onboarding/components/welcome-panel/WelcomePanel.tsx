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
      <p>
        A control room for Claude Code: chat with your sessions, watch their status live, and keep a project dashboard
        in the same window.
      </p>
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
