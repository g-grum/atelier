import type { ReviewFinding } from './item-prompt'

export type ReviewVerdict = { verdict: 'approve' | 'request_changes'; findings: ReviewFinding[] }

/** Parse stricte du fichier de verdict (spec 2026-08-07) — tout écart → null (l'appelant relance puis échoue). */
export function parseVerdict(raw: string): ReviewVerdict | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const { verdict, findings } = v as { verdict?: unknown; findings?: unknown }
  if (verdict === 'approve') return { verdict: 'approve', findings: [] }
  if (verdict !== 'request_changes') return null
  if (!Array.isArray(findings) || findings.length === 0) return null
  const parsed: ReviewFinding[] = []
  for (const f of findings) {
    const { title, detail } = (f ?? {}) as { title?: unknown; detail?: unknown }
    if (typeof title !== 'string' || title.length === 0) return null
    parsed.push({ title, detail: typeof detail === 'string' ? detail : '' })
  }
  return { verdict: 'request_changes', findings: parsed }
}

export type ReadVerdict = (path: string) => Promise<ReviewVerdict | null>

export const readVerdict: ReadVerdict = async (path) => {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  return parseVerdict(await file.text())
}

/** Suppression best-effort (avant chaque tour de review, et au cleanup). */
export async function removeVerdict(path: string): Promise<void> {
  try {
    await Bun.file(path).unlink()
  } catch {
    // absent = déjà propre
  }
}
