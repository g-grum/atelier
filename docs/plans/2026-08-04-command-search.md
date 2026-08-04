# Recherche dans le popover de commandes — plan d'implémentation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Taper `/` dans le composer devient un explorateur de commandes : recherche en sous-chaîne par paliers (nom/alias puis description) et dépliage de la description complète sur l'item actif.

**Architecture:** Deux unités indépendantes, 100 % web (aucun changement serveur/protocole) : (1) `matchCommands` (`apps/web/src/lib/slash-commands.ts`) passe d'un filtre par préfixe à un classement par paliers — fonction pure, signature inchangée, le Composer n'y touche pas ; (2) le popover du Composer déplie la description de l'item actif via CSS `line-clamp`, avec activation au survol souris (`onMouseMove`).

**Tech Stack:** React 18, `bun test` + happy-dom + @testing-library/react, CSS vanilla (`styles.css`).

**Spec:** `docs/specs/2026-08-04-command-search-design.md` (fait foi en cas de doute).

**Commandes de test** (depuis la racine du repo, bun ABSOLU : `/Users/demo/.bun/bin/bun`) :

- unité lib : `bun test apps/web/src/lib/slash-commands.test.ts`
- Composer : `bun test apps/web/src/components/Composer.test.tsx`
- suite complète : `bun test`

---

## Chunk 1 : recherche par paliers + dépliage actif

### Task 1 : `matchCommands` — recherche par paliers

**Files:**
- Modify: `apps/web/src/lib/slash-commands.ts:17-23` (la fonction `matchCommands` seule ; `commandPrefix` et `completeCommand` inchangées)
- Test: `apps/web/src/lib/slash-commands.test.ts`

- [x] **Step 1 : Écrire les tests qui échouent**

Dans `slash-commands.test.ts`, ajouter une fixture dédiée à la recherche (APRÈS le `const CMDS` existant, sans le modifier — les tests existants s'appuient dessus) :

```ts
// Fixture de recherche : couvre les trois paliers (P1 préfixe nom/alias,
// P2 sous-chaîne nom/alias, P3 sous-chaîne description).
const SEARCH = [
  { name: 'review', description: 'relire une pull request', argumentHint: '', aliases: [] },
  { name: 'writing-plans', description: 'écrire un plan d’implémentation', argumentHint: '', aliases: [] },
  { name: 'code-review', description: 'review the current diff', argumentHint: '', aliases: [] },
  { name: 'verify', description: 'exercise the change and review behavior', argumentHint: '', aliases: [] },
]
```

Puis, DANS le `describe('matchCommands', …)` existant, ajouter :

```ts
  test('P2 : sous-chaîne du nom — plan trouve writing-plans', () => {
    expect(matchCommands(SEARCH, 'plan').map((c) => c.name)).toEqual(['writing-plans'])
  })
  test('P3 : sous-chaîne de la description — diff trouve code-review', () => {
    expect(matchCommands(SEARCH, 'diff').map((c) => c.name)).toEqual(['code-review'])
  })
  test('ordre des paliers : P1 avant P2 avant P3', () => {
    // review : P1 = review (préfixe), P2 = code-review (le nom contient),
    // P3 = verify (seule la description contient).
    expect(matchCommands(SEARCH, 'review').map((c) => c.name)).toEqual(['review', 'code-review', 'verify'])
  })
  test('dédup : une commande matchant nom ET description sort une seule fois', () => {
    // writing-plans matche 'plan' par le nom (P2) ET par la description — un seul résultat.
    expect(matchCommands(SEARCH, 'plan')).toHaveLength(1)
  })
  test('la casse est ignorée aussi dans la description', () => {
    expect(matchCommands(SEARCH, 'DIFF').map((c) => c.name)).toEqual(['code-review'])
  })
  test('aucun match : liste vide', () => {
    expect(matchCommands(SEARCH, 'zzz')).toEqual([])
  })
  test('requête vide : tout le catalogue dans l’ordre d’origine', () => {
    expect(matchCommands(SEARCH, '').map((c) => c.name)).toEqual([
      'review',
      'writing-plans',
      'code-review',
      'verify',
    ])
  })
```

- [x] **Step 2 : Vérifier qu'ils échouent**

Run: `/Users/demo/.bun/bin/bun test apps/web/src/lib/slash-commands.test.ts`
Expected: FAIL — au moins « P2 », « P3 », « ordre des paliers » échouent (le filtre actuel par préfixe renvoie `[]` pour `plan` et `diff`). Les tests existants passent toujours.

- [x] **Step 3 : Implémenter la recherche par paliers**

Remplacer la fonction `matchCommands` (et son commentaire) dans `slash-commands.ts` par :

```ts
/**
 * Recherche par paliers (spec 2026-08-04) : P1 = nom/alias COMMENCE par la
 * requête, P2 = nom/alias CONTIENT, P3 = description CONTIENT. Insensible à
 * la casse. Chaque commande apparaît une seule fois, dans son meilleur
 * palier ; l'ordre d'origine est préservé à l'intérieur d'un palier (une
 * seule passe, pas de sort à score). Requête vide : tout matche P1 — le
 * catalogue complet sort dans l'ordre d'origine, sans cas spécial.
 */
export function matchCommands(commands: readonly SlashCommandInfo[], prefix: string): SlashCommandInfo[] {
  const p = prefix.toLowerCase()
  const starts: SlashCommandInfo[] = []
  const contains: SlashCommandInfo[] = []
  const described: SlashCommandInfo[] = []
  for (const command of commands) {
    const names = [command.name, ...command.aliases].map((n) => n.toLowerCase())
    if (names.some((n) => n.startsWith(p))) starts.push(command)
    else if (names.some((n) => n.includes(p))) contains.push(command)
    else if (command.description.toLowerCase().includes(p)) described.push(command)
  }
  return [...starts, ...contains, ...described]
}
```

- [x] **Step 4 : Vérifier que tout passe**

Run: `/Users/demo/.bun/bin/bun test apps/web/src/lib/slash-commands.test.ts`
Expected: PASS — tous les tests du fichier (anciens + nouveaux).

- [x] **Step 5 : Commit**

```bash
git add apps/web/src/lib/slash-commands.ts apps/web/src/lib/slash-commands.test.ts
git commit -m "feat(web): recherche par paliers dans matchCommands (nom/alias puis description)"
```

### Task 2 : dépliage de la description sur l'item actif + survol souris

**Files:**
- Modify: `apps/web/src/components/Composer.tsx:85-103` (le `<li>` du popover)
- Modify: `apps/web/src/styles.css:361` (ajout d'une règle après `.cmd-desc`)
- Test: `apps/web/src/components/Composer.test.tsx`

- [x] **Step 1 : Écrire le test qui échoue**

Dans `Composer.test.tsx`, DANS le `describe` qui contient les tests du popover (celui des tests « ↓ puis Enter… », « un clic sur une option complète »), ajouter :

```ts
  test('le survol souris rend une option active (déplie sa description)', () => {
    renderComposer({ commands: CMDS })
    type('/')
    expect(options()).toHaveLength(2)
    expect(options()[1]?.getAttribute('aria-selected')).toBe('false')
    fireEvent.mouseMove(options()[1]!)
    expect(options()[1]?.getAttribute('aria-selected')).toBe('true')
    expect(options()[0]?.getAttribute('aria-selected')).toBe('false')
  })
```

(Le dépliage lui-même est du CSS pur porté par la classe `active`/`aria-selected` — non observable sous happy-dom, on teste l'activation.)

- [x] **Step 2 : Vérifier qu'il échoue**

Run: `/Users/demo/.bun/bin/bun test apps/web/src/components/Composer.test.tsx`
Expected: FAIL — `aria-selected` de l'option 1 reste `"false"` après `mouseMove` (aucun handler souris ne pilote `active` aujourd'hui).

- [x] **Step 3 : Implémenter**

Dans `Composer.tsx`, sur le `<li>` du popover (juste au-dessus du `onMouseDown` existant), ajouter :

```tsx
              // onMouseMove, pas onMouseEnter : quand la liste défile sous un
              // curseur immobile (navigation clavier), onMouseEnter volerait la
              // sélection ; onMouseMove n'active que si la souris bouge vraiment.
              onMouseMove={() => setActive(index)}
```

Dans `styles.css`, juste après la règle `.command-popover .cmd-desc` (ligne 361), ajouter :

```css
  .command-popover li.active .cmd-desc { white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; }
```

(Le `li` reste en flex row `align-items: baseline` : la description multiligne — `flex: 1; min-width: 0` — s'aligne sur sa première ligne, nom et hint restent dessus. Aucun changement d'état React.)

- [x] **Step 4 : Vérifier que tout passe**

Run: `/Users/demo/.bun/bin/bun test apps/web/src/components/Composer.test.tsx`
Expected: PASS — le nouveau test et tous les tests existants du fichier (notamment « ↓ puis Enter sélectionne la DEUXIÈME option » : la sélection clavier ne doit pas être cassée).

- [x] **Step 5 : Commit**

```bash
git add apps/web/src/components/Composer.tsx apps/web/src/components/Composer.test.tsx apps/web/src/styles.css
git commit -m "feat(web): item actif au survol + description dépliée (line-clamp) dans le popover"
```

### Task 3 : suite complète, build et vérification manuelle

**Files:** aucun nouveau — vérification.

- [x] **Step 1 : Suite complète**

Run: `/Users/demo/.bun/bin/bun test`
Expected: PASS — 0 échec. (⚠️ flaky connu, indépendant de cette feature : `App session deletion > deleting a NON-selected session leaves the selection alone` peut dépasser son timeout sous charge machine — le relancer seul avant de conclure, cf. mémoire projet.)

- [x] **Step 2 : Build web**

Run: `/Users/demo/.bun/bin/bun run build:web`
Expected: build OK sans erreur TypeScript. (Déploiement web : servi depuis `dist/` — un ⌘R dans l'app suffit ensuite, pas de repackage.)

- [x] **Step 3 : Vérification manuelle (vrai navigateur/app — non exécutable en headless)**

Dans Atelier, ouvrir une session, taper `/` :
- `/plan` liste `writing-plans` (P2) ; `/diff` liste une commande via sa description (P3) ; les résultats préfixe sortent en premier.
- Survoler une option la surligne et déplie sa description (≤ 4 lignes) ; l'item actif au clavier fait pareil.
- Navigation clavier ↓/↑ : le `scrollIntoView({block: 'nearest'})` reste confortable malgré la hauteur variable de l'item déplié ; le nudge de défilement au survol d'un item partiellement visible ne gêne pas (points de vigilance de la spec).

- [x] **Step 4 : Cocher le plan et commit final**

```bash
git add docs/plans/2026-08-04-command-search.md
git commit -m "docs: plan recherche popover — exécution complète"
```
