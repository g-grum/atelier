import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DevServer } from '@atelier/shared'
import { DevServersWidget, type DevServersWidgetApi } from '@/features/dashboard/components/dev-servers-widget/DevServersWidget'

afterEach(cleanup)

const SERVERS: DevServer[] = [
  { port: 4518, pid: 42, label: 'vite', command: 'bunx vite --port 4518', killable: true },
  { port: 3010, pid: 43, label: 'external API', command: 'node api/server.js', killable: false },
]

function makeApi(overrides: Partial<DevServersWidgetApi> = {}): DevServersWidgetApi & { stopped: number[] } {
  const stopped: number[] = []
  return {
    stopped,
    stopDevServer: async (pid: number) => {
      stopped.push(pid)
    },
    ...overrides,
  }
}

describe('DevServersWidget', () => {
  test('no servers: empty state', () => {
    render(<DevServersWidget servers={[]} api={makeApi()} />)
    expect(screen.getByText('No dev servers running')).toBeTruthy()
  })

  test('one row per server: green dot, :port, label, command', () => {
    render(<DevServersWidget servers={SERVERS} api={makeApi()} />)
    expect(document.querySelectorAll('.pr-dot.open').length).toBe(2)
    expect(screen.getByText(':4518')).toBeTruthy()
    expect(screen.getByText('vite')).toBeTruthy()
    expect(screen.getByText('bunx vite --port 4518')).toBeTruthy()
    expect(screen.getByText(':3010')).toBeTruthy()
    expect(screen.getByText('external API')).toBeTruthy()
    expect(screen.getByText('node api/server.js')).toBeTruthy()
  })

  test('Open opens http://localhost:PORT for its row', () => {
    const opened: string[] = []
    render(<DevServersWidget servers={SERVERS} api={makeApi()} openUrl={(url) => opened.push(url)} />)
    const buttons = screen.getAllByRole('button', { name: 'Open' })
    expect(buttons.length).toBe(2)
    fireEvent.click(buttons[0]!)
    fireEvent.click(buttons[1]!)
    expect(opened).toEqual(['http://localhost:4518', 'http://localhost:3010'])
  })

  test('Stop only on killable rows and wired to the pid; non-killable rows get an external badge', async () => {
    const api = makeApi()
    render(<DevServersWidget servers={SERVERS} api={api} />)
    const stops = screen.getAllByRole('button', { name: 'Stop' })
    expect(stops.length).toBe(1)
    expect(screen.getByText('external')).toBeTruthy()
    fireEvent.click(stops[0]!)
    await waitFor(() => expect(api.stopped).toEqual([42]))
  })

  test('stop failure surfaces the error inline', async () => {
    render(
      <DevServersWidget
        servers={SERVERS}
        api={makeApi({
          stopDevServer: async () => {
            throw new Error('this server was not started by Atelier')
          },
        })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await screen.findByText('this server was not started by Atelier')
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
