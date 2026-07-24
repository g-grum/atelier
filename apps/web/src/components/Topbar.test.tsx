import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { Topbar } from './Topbar'

// RTL wraps renders/events in act() — React 19 requires the env flag outside a test-runner preset.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(cleanup)

describe('Topbar', () => {
  test('the brand renders the logo image from the public asset', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <Topbar project={null} session={null} status="idle" onRename={() => {}} patchPreferences={async () => ({})} />
      </QueryClientProvider>,
    )
    const logo = screen.getByAltText('Logo Atelier')
    expect(logo.getAttribute('src')).toBe('/favicon.svg')
  })
})
