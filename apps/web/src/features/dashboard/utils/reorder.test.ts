import { describe, expect, test } from 'bun:test'
import type { WidgetInstance } from '@atelier/shared'
import { reorderWidgets } from '@/features/dashboard/utils/reorder'

const layout: WidgetInstance[] = [
  { id: 'a', type: 'rate-limits', span: 2, height: 'M' },
  { id: 'b', type: 'modified-files', span: 2, height: 'M' },
  { id: 'c', type: 'github-prs', span: 1, height: 'S', config: { repo: 'o/r' } },
]

describe('reorderWidgets', () => {
  test('moves the dragged id to the drop target position', () => {
    expect(reorderWidgets(layout, 'a', 'c').map((w) => w.id)).toEqual(['b', 'c', 'a'])
    expect(reorderWidgets(layout, 'c', 'a').map((w) => w.id)).toEqual(['c', 'a', 'b'])
  })

  test('unknown ids or self-drop return the SAME array (no useless PUT)', () => {
    expect(reorderWidgets(layout, 'a', 'a')).toBe(layout)
    expect(reorderWidgets(layout, 'nope', 'a')).toBe(layout)
    expect(reorderWidgets(layout, 'a', 'nope')).toBe(layout)
  })
})
