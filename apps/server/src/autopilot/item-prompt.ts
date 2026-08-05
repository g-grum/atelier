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
