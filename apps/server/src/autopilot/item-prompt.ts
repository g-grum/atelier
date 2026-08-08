/** Prompts des items autopilot (spec 2026-08-05) — purs, testables, sans I/O. */

export function buildItemPrompt({ issue, title, body, branch }: { issue: number; title: string; body: string; branch: string }): string {
  return `Tu es un agent AUTONOME : ne pose aucune question, tranche seul et avance jusqu'au bout.

Ta mission : implémenter l'issue GitHub #${issue} — « ${title} ».

Description de l'issue :
${body.trim() || '(pas de description)'}

Contexte : tu travailles dans un worktree git isolé, déjà sur la branche ${branch}, dépendances installées. Le repo contient ses specs et plans dans docs/ — lis ce qui est pertinent avant de coder.

Méthode :
1. Explore le code existant et suis ses patterns (style, tests voisins).
2. TDD : test qui échoue → implémentation minimale → vert. Commits atomiques, messages en français.
3. Gates OBLIGATOIRES avant de conclure : \`bun test\` et \`bun node_modules/typescript/bin/tsc --noEmit -p apps/web\` — les deux doivent être verts.
4. Pousse la branche : \`git push -u origin ${branch}\`.
5. Ouvre la PR : \`gh pr create --title "…" --body "… Closes #${issue}"\` — le corps résume ce qui a été fait et se termine par Closes #${issue}.

Ne merge JAMAIS. Ne touche pas à main. La PR est ton livrable final.`
}

export function buildRetryPrompt(issue: number): string {
  return `Termine ta mission : exécute les gates (\`bun test\` + \`bun node_modules/typescript/bin/tsc --noEmit -p apps/web\`), corrige ce qui est rouge, pousse la branche et ouvre la PR (\`gh pr create\` avec un corps se terminant par Closes #${issue}). C'est le livrable attendu.`
}

export type ReviewFinding = { title: string; detail: string }

export function buildReviewPrompt({ issue, title, body, branch, verdictPath }: { issue: number; title: string; body: string; branch: string; verdictPath: string }): string {
  return `Tu es un agent reviewer AUTONOME : ne pose aucune question, tranche seul.

Ta mission : reviewer la PR de la branche ${branch}, qui implémente l'issue #${issue} — « ${title} ».

Description de l'issue :
${body.trim() || '(pas de description)'}

Contexte : tu es dans le worktree de la branche, dépendances installées. La branche par défaut est main.

Méthode :
1. Lis le diff complet : \`git diff main...HEAD\`.
2. Vérifie l'adéquation à l'issue, la cohérence avec les patterns du repo (style, tests voisins, docs/specs pertinentes) et cherche les vrais défauts (bugs, cas limites, tests manquants ou mensongers).
3. Exécute les gates : \`bun test\` et \`bun node_modules/typescript/bin/tsc --noEmit -p apps/web\` — un gate rouge est un finding bloquant.
4. Écris ton verdict — UNIQUEMENT ce fichier, rien d'autre : ${verdictPath}
   Format JSON strict : {"verdict":"approve"} ou {"verdict":"request_changes","findings":[{"title":"…","detail":"…"}]} (findings non vide).

Interdits : committer, pousser, merger, commenter sur GitHub — aucune trace en ligne. Le fichier de verdict est ton SEUL livrable.`
}

export function buildReReviewPrompt(verdictPath: string): string {
  return `Des corrections ont été poussées sur la branche depuis ta review. Re-vérifie : relis \`git diff main...HEAD\`, ré-exécute les gates (\`bun test\` + \`bun node_modules/typescript/bin/tsc --noEmit -p apps/web\`), et réécris ton verdict JSON à ${verdictPath} (mêmes règles, mêmes interdits).`
}

export function buildFixPrompt(findings: ReviewFinding[]): string {
  const list = findings.map((f) => `- ${f.title} : ${f.detail}`).join('\n')
  return `La review de ta PR demande des corrections :

${list}

Corrige chaque point (TDD quand c'est pertinent), exécute les gates (\`bun test\` + \`bun node_modules/typescript/bin/tsc --noEmit -p apps/web\`), puis commite et pousse sur ta branche. Ne merge JAMAIS. Ne touche pas à main.`
}

export function buildRetryVerdictPrompt(verdictPath: string): string {
  return `Il manque ton verdict. Écris le fichier JSON à ${verdictPath} — {"verdict":"approve"} ou {"verdict":"request_changes","findings":[{"title":"…","detail":"…"}]} — c'est ton SEUL livrable.`
}
