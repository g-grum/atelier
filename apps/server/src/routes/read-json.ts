/**
 * Parses a request body and normalizes it to a plain object — null for
 * malformed JSON AND for any legal non-object JSON value ('null', '[]', '"x"',
 * '42', 'true'), so handlers can 400 instead of TypeError-ing into a 500.
 */
export async function readJsonObject(req: { json(): Promise<unknown> }): Promise<Record<string, unknown> | null> {
  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return null
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
}
