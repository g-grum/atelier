# Autopilot niveau 2 — review automatique et auto-merge

**Date** : 2026-08-07 · **Statut** : validé (politique full-auto choisie par Germain)

## Objectif

En v0.1.13/14, l'autopilot livre des PRs que Germain review et merge à la main.
Niveau 2 : chaque PR est reviewée par un agent dédié, corrigée si besoin (un
cycle), puis mergée automatiquement quand la CI est verte. L'humain n'intervient
que sur les items en échec.

## Cycle de vie d'un item (extension)

```
queued → running → pr_opened → reviewing ─┬─ approve ──→ merging → merged
                                          └─ request_changes → fixing → reviewing (1 seul cycle)
```

- `AutopilotItemStatus` gagne `reviewing`, `fixing`, `merging`, `merged`.
- **États terminaux** : `merged`, `failed`, et `pr_opened` (= « PR livrée, non
  mergée » — atteint si le run est arrêté avant merge). `cleanup()` les accepte
  tous les trois.
- **Boot** : `reviewing`/`fixing`/`merging` sont non-terminaux → normalisés
  `failed` au démarrage, comme `running` aujourd'hui.
- Second cycle de review négatif → `failed`, erreur « la review a rejeté la PR
  après correction », `prUrl` conservé pour l'autopsie.
- CI rouge → `failed` « CI rouge sur la PR ». Timeout CI → `failed` « timeout CI ».
- `stop()` pendant review/fix/attente CI → l'item retombe à `pr_opened` (la PR
  existe et reste mergeable à la main) ; le run s'arrête comme aujourd'hui.

## Session de review

- Deuxième session réelle sur le **même projet temporaire** (même worktree),
  nom `Review #<n>`, `bypassPermissions`, créée au passage à `reviewing`.
- `AutopilotItem.reviewSessionId` (persisté) ; le prédicat « session
  autopilot ? » (index.ts) matche aussi ce champ → QCM deny couvert.
- Fin de tour suivie par le même mécanisme `waitForTurnEnd` (hub, remap
  `resolveSessionId`, timeout `itemTimeoutMs` par tour, abort au timeout).
  `error` de tour → réutilise `failItem` (dont l'arrêt du run sur rate limit).

## Verdict : fichier local (pas GitHub)

GitHub **refuse** approve/request-changes sur sa propre PR (même compte g-grum
partout) — et l'incognito interdit tout artefact botty. Le verdict est donc un
fichier hors worktree, dans `.worktrees/` (déjà gitignoré) :

- Chemin : `<repoRoot>/.worktrees/review-<issue>.json`, communiqué à l'agent
  dans son prompt. Le runner le **supprime avant** chaque tour de review
  (un verdict périmé ne doit jamais être relu).
- Schéma : `{ "verdict": "approve" | "request_changes", "findings": [{ "title": string, "detail": string }] }`
  — `findings` obligatoire et non vide quand `request_changes`.
- Fichier absent ou invalide après le tour → **une** relance (prompt de rappel),
  sinon `failed` « la review n'a pas rendu de verdict ».
- Lecture par un seam injectable (`readVerdict(path)`) pour les tests du runner.

## Correction (fixing)

Les findings sont renvoyés à la **session d'implémentation** (toujours vivante,
même stream) via `buildFixPrompt` : corriger, gates verts, push sur la branche.
Fin de tour → re-review (même session de review, `buildReReviewPrompt`).
**Un seul cycle fix→re-review**, symétrique de la relance PR unique existante.

## Attente CI et merge

- `GithubService.prCi(repo, number, githubUser)` : `gh pr view --json
  statusCheckRollup`, SANS cache, même mapping que `mapPr` (passed/failed/pending/null).
- Poll toutes les 30 s, plafond `ciTimeoutMs` (défaut 20 min, injectable).
  Chaque tick vérifie `run.state === 'running'` (sinon → `pr_opened`, cf. stop).
  `statusCheckRollup` vide (CI jamais déclenchée) → on merge quand même après
  un délai de grâce de 2 min (workflows GitHub parfois muets — cf. panne runners).
- `GithubService.mergePr(repo, number, githubUser)` : `gh pr merge --squash
  --delete-branch` (suppression branche distante ; worktree + branche locale
  restent à `cleanup()`). Échec gh → `failed` avec le stderr FR habituel.

## Prompts (item-prompt.ts, purs)

- `buildReviewPrompt({ issue, title, body, branch, verdictPath })` : agent
  AUTONOME ; lire l'issue et le diff (`git diff main...HEAD`), vérifier
  l'adéquation à l'issue, les patterns du repo, exécuter les gates (`bun test`,
  tsc apps/web) ; écrire le verdict JSON à `verdictPath` ; ne rien committer,
  ne rien pousser, ne JAMAIS merger ; aucune trace sur GitHub.
- `buildReReviewPrompt(...)` : re-vérifier après correction, mêmes règles.
- `buildFixPrompt({ findings })` : corriger chaque finding, gates verts,
  commits + push sur la branche, ne pas merger.
- `buildRetryVerdictPrompt(verdictPath)` : rappel « écris le verdict ».

## Widget

Nouveaux libellés d'état FR : `reviewing` « en review », `fixing`
« en correction », `merging` « merge en cours », `merged` « mergée » (vert).
`pr_opened` devient « PR ouverte (non mergée) ». Rien d'autre ne change.

## Hors périmètre

Reviews multi-angles parallèles, plus d'un cycle de correction, choix du mode
de merge, commentaires GitHub. YAGNI tant que le cycle simple n'a pas tourné.

## Tests

TDD. Runner : fakes existants (streams/github/workspace) + seam `readVerdict` ;
cas couverts : happy path merge, request_changes→fix→approve, double rejet,
verdict absent puis relance, CI rouge, timeout CI, stop pendant merging, boot
normalisant les nouveaux statuts, rate limit en tour de review. GithubService :
`prCi` (mapping, sans cache) et `mergePr` (args, erreurs). Widget : libellés.
Validation finale : run E2E réel sur une issue de test (serveur isolé, compte
gh ACTIF = g-grum, préférence githubUser patchée), PR reviewée et mergée sans
intervention.
