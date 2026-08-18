import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import type { Project } from '@atelier/shared'
import { Topbar } from '@/components/topbar/Topbar'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

const withClient = (ui: React.ReactElement) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
}

const PROJECT: Project = { id: 'p1', path: '/work/atelier', color: 'cyan' }

describe('Topbar', () => {
  test('the brand renders the logo image from the public asset', () => {
    render(
      withClient(<Topbar project={null} session={null} status="idle" githubAccount={null} onRename={() => {}} patchPreferences={async () => ({})} />),
    )
    const logo = screen.getByAltText('Atelier logo')
    expect(logo.getAttribute('src')).toBe('/favicon.svg')
  })

  test('shows the GitHub account chip when a project with a GitHub remote is open', () => {
    render(
      withClient(
        <Topbar
          project={PROJECT}
          session={null}
          status="idle"
          githubAccount={{ account: 'g-grum', repo: 'g-grum/atelier' }}
          onRename={() => {}}
          patchPreferences={async () => ({})}
        />,
      ),
    )
    expect(screen.getByText('g-grum')).not.toBeNull()
  })

  test('no account chip when the account is unknown', () => {
    render(
      withClient(<Topbar project={PROJECT} session={null} status="idle" githubAccount={null} onRename={() => {}} patchPreferences={async () => ({})} />),
    )
    expect(screen.queryByText('g-grum')).toBeNull()
  })
})
