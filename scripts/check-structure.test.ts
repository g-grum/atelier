import { describe, expect, test } from 'bun:test'
import { collectSourceFiles, structureViolations } from './check-structure'

describe('structure checker', () => {
  test('flags a feature importing from another feature', () => {
    const violations = structureViolations([
      {
        path: 'apps/web/src/features/chat/components/composer/Composer.tsx',
        text: "import { SessionListItem } from '@/features/sessions/components/session-list-item/SessionListItem'\n",
      },
    ])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('features/chat')
    expect(violations[0]).toContain('features/sessions')
  })

  test('flags a relative cross-feature import too', () => {
    const violations = structureViolations([
      { path: 'apps/web/src/features/chat/components/composer/Composer.tsx', text: "import x from '../../../settings/utils/models'\n" },
    ])
    expect(violations).toHaveLength(1)
  })

  test('allows a feature importing its own modules, the shell, stores or a package', () => {
    const violations = structureViolations([
      {
        path: 'apps/web/src/features/chat/components/composer/Composer.tsx',
        text: [
          "import { matchFiles } from '@/features/chat/utils/file-mentions'",
          "import { Button } from '@/ui/button/button'",
          "import type { StreamState } from '@/stores/stream-reducer'",
          "import { cn } from '@atelier/core/utils/cn'",
          "import type { SessionSummary } from '@atelier/shared'",
          "import { useState } from 'react'",
          '',
        ].join('\n'),
      },
    ])
    expect(violations).toEqual([])
  })

  test('flags a package importing from an app', () => {
    const violations = structureViolations([
      { path: 'packages/core/utils/cn.ts', text: "import { backend } from '@atelier/web/src/api/backend'\n" },
    ])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('packages/core')
  })

  test('flags core importing the wire protocol', () => {
    const violations = structureViolations([{ path: 'packages/core/types/session.ts', text: "import type { SessionSummary } from '@atelier/shared'\n" }])
    expect(violations).toHaveLength(1)
  })

  test('allows shared to stay independent', () => {
    const violations = structureViolations([{ path: 'packages/shared/src/protocol.ts', text: "import { z } from 'zod'\n" }])
    expect(violations).toEqual([])
  })
})

describe('this repository', () => {
  test('has no structure violations', () => {
    const violations = structureViolations(collectSourceFiles())
    expect(violations).toEqual([])
  })

  test('actually scanned the sources', () => {
    expect(collectSourceFiles().length).toBeGreaterThan(50)
  })
})
