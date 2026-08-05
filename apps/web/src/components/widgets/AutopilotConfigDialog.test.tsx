import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ProjectSummary, WidgetInstance } from '@atelier/shared'
import { AutopilotConfigDialog } from './AutopilotConfigDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const projects: ProjectSummary[] = [
  { id: 'p1', path: '/work/atelier', color: 'cyan', sessionCount: 3 },
  { id: 'p2', path: '/work/autre', color: 'magenta', sessionCount: 1 },
]

const instance: WidgetInstance = { id: 'a1', type: 'autopilot', span: 2, height: 'M', config: { projectId: 'p2', maxItems: 5 } }
const fresh: WidgetInstance = { id: 'a2', type: 'autopilot', span: 2, height: 'M', config: { projectId: '', maxItems: 3 } }

function renderDialog(inst: WidgetInstance = instance) {
  const saved: WidgetInstance[] = []
  const closed: boolean[] = []
  render(<AutopilotConfigDialog instance={inst} projects={projects} onSave={(next) => saved.push(next)} onClose={() => closed.push(true)} />)
  return { saved, closed }
}

describe('AutopilotConfigDialog', () => {
  test('préremplit projet et maxItems', () => {
    renderDialog()
    expect((screen.getByLabelText('Projet cible') as HTMLSelectElement).value).toBe('p2')
    expect((screen.getByLabelText('Items max par run') as HTMLInputElement).value).toBe('5')
  })

  test('instance fraîche (projectId vide) : défaut = premier projet', () => {
    renderDialog(fresh)
    expect((screen.getByLabelText('Projet cible') as HTMLSelectElement).value).toBe('p1')
  })

  test('enregistrer clampe maxItems (1-10) et sauve la config', () => {
    const { saved, closed } = renderDialog()
    fireEvent.change(screen.getByLabelText('Items max par run'), { target: { value: '99' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(saved).toEqual([{ ...instance, config: { projectId: 'p2', maxItems: 10 } }])
    expect(closed).toEqual([true])
  })

  test('changer de projet est pris en compte', () => {
    const { saved } = renderDialog()
    fireEvent.change(screen.getByLabelText('Projet cible'), { target: { value: 'p1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(saved[0]!.config).toEqual({ projectId: 'p1', maxItems: 5 })
  })
})
