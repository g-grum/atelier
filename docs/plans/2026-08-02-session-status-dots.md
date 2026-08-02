# Pastilles d'état par session (vert / bleu) — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Afficher dans la liste de sessions une pastille verte quand une session travaille (tour en cours) et bleue quand un tour vient de se terminer/échouer hors focus et attend l'utilisateur, vidée au focus.

**Architecture:** Un « status hub » serveur (canal WS additif `/api/sessions-status`) diffuse l'état live (`idle | streaming | error`) de **toutes** les sessions à partir du registre de `SessionStream` existant ; le streaming actif par socket unique reste inchangé. Le client tient une petite source externe (`statuses`, `waiting`) : le bleu est **dérivé d'une transition** `streaming → (idle|error)` observée hors session focalisée. Le vert de la session active reste piloté par `streamingSessionId` (optimiste), combiné au hub pour les sessions de fond.

**Tech Stack:** Bun + Hono + `hono/bun` `upgradeWebSocket` (serveur) ; React 18 `useSyncExternalStore` + WebSocket auto-reconnectant (client) ; TypeScript, `bun test`.

**Spec:** `docs/specs/2026-08-02-session-status-dots-design.md` (source de vérité).

---

## File Structure

**Serveur**
- Modifier `packages/shared/src/protocol.ts` — ajouter `SessionState`, `SessionStatusEvent`, `parseSessionStatus`. (type + garde, indépendants de `ServerEvent` pour ne PAS toucher le réducteur client ni ses consommateurs exhaustifs).
- Modifier `apps/server/src/stream/session-stream.ts` — `setState()` centralisé émettant `onStatusChange`, getter `currentState`, option de constructeur `onStatusChange`.
- Modifier `apps/server/src/stream/session-stream.ts` (classe `SessionStreamRegistry`, même fichier) — sinks de statut, `onStatusConnect` / `onStatusClose` (snapshot initial), `publishStatus`, câblage `onStatusChange` sur chaque stream créé.
- Modifier `apps/server/src/app.ts` — route WS `/api/sessions-status` (glue only).

**Client**
- Modifier `packages/shared/src/protocol.ts` (déjà ci-dessus — type partagé).
- Créer `apps/web/src/state/session-status-store.ts` — la source externe (`statuses`/`waiting`, transitions, `setActive`).
- Créer `apps/web/src/api/status-socket.ts` — WS receive-only auto-reconnectant vers `/api/sessions-status`.
- Modifier `apps/web/src/App.tsx` — instancier le store, ouvrir/fermer le socket, `useSyncExternalStore`, `setActive` au changement de `selected`, passer `statuses`/`waiting` à la sidebar.
- Modifier `apps/web/src/components/SessionSidebar.tsx` — nouvelles props `statuses`/`waiting`, nouvelle signature `dotState`.
- Modifier `apps/web/src/components/SessionListItem.tsx` — `SessionDotState` gagne `'waiting'`.
- Modifier `apps/web/src/styles.css` — variante `.dot[data-state='waiting']` (bleu, statique).

**Convention de tests :** `bun test <path>` ; suivre le harnais existant (`apps/server/src/stream/session-stream.test.ts` pour le SDK factice ; `apps/web/src/components/*.test.tsx` pour le rendu React ; `apps/web/src/state/*.test.ts` pour les stores).

> **Isolation :** implémenter dans un worktree dédié `.worktrees/status-dots` (voir memory `parallel-jobs-coordination` : des sessions jumelles tournent). Ne pas démarrer de serveur sur 4517 sans vérifier `lsof`. Le plan n'exige aucun serveur en marche — tout est couvert par `bun test`.

---

## Chunk 1: Serveur — protocole + status hub

### Task 1: Type et garde `SessionStatusEvent` (protocole partagé)

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Test: `packages/shared/src/protocol.test.ts` (créer s'il n'existe pas ; sinon y ajouter)

- [ ] **Step 1: Écrire le test qui échoue**

⚠️ **`packages/shared/src/protocol.test.ts` EXISTE déjà** (importe `{ describe, expect, test }` de `bun:test` et plusieurs symboles de `./protocol`). NE PAS recréer le fichier ni ré-importer `describe`/`expect` (double binding = SyntaxError). **Fusionner** : ajouter `parseSessionStatus` à l'import existant `from './protocol'`, puis ajouter ce `describe` (en réutilisant `test` déjà importé) :

```ts
// import existant complété : import { …, parseSessionStatus } from './protocol'

describe('parseSessionStatus', () => {
  test('accepte un évènement bien formé', () => {
    expect(parseSessionStatus(JSON.stringify({ type: 'session_status', sessionId: 's1', state: 'streaming' })))
      .toEqual({ type: 'session_status', sessionId: 's1', state: 'streaming' })
  })
  test('rejette un mauvais type, un état inconnu, un sessionId non-string ou un JSON invalide', () => {
    expect(parseSessionStatus(JSON.stringify({ type: 'status', sessionId: 's1', state: 'idle' }))).toBeNull()
    expect(parseSessionStatus(JSON.stringify({ type: 'session_status', sessionId: 's1', state: 'busy' }))).toBeNull()
    expect(parseSessionStatus(JSON.stringify({ type: 'session_status', sessionId: 42, state: 'idle' }))).toBeNull()
    expect(parseSessionStatus('{not json')).toBeNull()
  })
})
```

- [ ] **Step 2: Lancer le test → échec**

Run: `bun test packages/shared/src/protocol.test.ts`
Expected: FAIL (`parseSessionStatus` is not a function / export manquant).

- [ ] **Step 3: Implémenter le type et la garde**

Dans `packages/shared/src/protocol.ts`, après le bloc `ServerEvent` (vers la ligne 119) :

```ts
// ── Status hub (spec 2026-08-02) : canal WS séparé /api/sessions-status ──
export type SessionState = 'idle' | 'streaming' | 'error'
/** Diffusé par le hub à chaque transition d'état d'une session (et en snapshot à la connexion). Volontairement HORS de ServerEvent : le socket de session et son réducteur ne le voient jamais. */
export type SessionStatusEvent = { type: 'session_status'; sessionId: string; state: SessionState }

const SESSION_STATES = new Set<SessionState>(['idle', 'streaming', 'error'])

export function parseSessionStatus(raw: string): SessionStatusEvent | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    if (v?.type !== 'session_status' || typeof v.sessionId !== 'string' || !SESSION_STATES.has(v.state as SessionState)) return null
    return { type: 'session_status', sessionId: v.sessionId, state: v.state as SessionState }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Lancer le test → succès**

Run: `bun test packages/shared/src/protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/src/protocol.test.ts
git commit -m "feat(shared): SessionStatusEvent + parseSessionStatus (status hub)"
```

---

### Task 2: `SessionStream` — `setState` centralisé + `onStatusChange` + `currentState`

**Files:**
- Modify: `apps/server/src/stream/session-stream.ts`
- Test: `apps/server/src/stream/session-stream.test.ts`

**Contexte :** aujourd'hui `this.state = X` est assigné à ~5 endroits (102, 116, 157, 170, turn_done, turn_error) et le tour NE broadcast PAS de `status` au démarrage (les deltas impliquent `streaming`). Le hub, lui, a besoin de CHAQUE transition, démarrage inclus. On centralise via `setState()`.

- [ ] **Step 1: Écrire le test qui échoue**

Suivre le harnais du fichier (construction d'un `SessionStream` avec SDK factice). Ajouter un test qui capture les transitions via `onStatusChange` :

```ts
it('émet chaque transition d’état via onStatusChange (streaming au démarrage, idle en fin)', async () => {
  const states: Array<{ sessionId: string; state: string }> = []
  // Construire un SessionStream DIRECTEMENT (import { SessionStream }) — registry.get()
  // n'accepte pas onStatusChange ; SessionStream est exporté. Passer au constructeur :
  //   onStatusChange: (sessionId, state) => states.push({ sessionId, state })
  // et scripter le SDK factice pour émettre { type: 'turn_done' } (le mock ne l'auto-émet PAS).
  stream.onMessage(JSON.stringify({ type: 'user_message', text: 'hi' }))
  await tick() // = Bun.sleep(0) : draine réellement le générateur async (Promise.resolve() ne suffit PAS)
  expect(states.map((s) => s.state)).toEqual(['streaming', 'idle'])
})
```

> Notes d'implémentation, calquées sur `session-stream.test.ts` :
> - **Drain :** utiliser le `tick()`/`Bun.sleep(0)` du fichier (chercher `tick` / `Bun.sleep`), PAS `Promise.resolve()` — un seul microtask capture `['streaming']` et rate `'idle'`.
> - **SDK factice :** scripter les `turns` avec un `{ type: 'turn_done' }` (le mock ne l'émet jamais seul). N'inventer aucune API SDK — réutiliser le stub (`sdk-client.mock.ts`).
> - **Construction :** `import { SessionStream } from './session-stream'` et instancier à la main pour passer `onStatusChange` (le registre ne l'expose pas). La couverture registre passe par Task 3.

- [ ] **Step 2: Lancer le test → échec**

Run: `bun test apps/server/src/stream/session-stream.test.ts`
Expected: FAIL (`onStatusChange` inconnu / aucune transition capturée).

- [ ] **Step 3: Implémenter**

Dans `SessionStreamParams` (ligne ~10) :

```ts
  /** Notifié à CHAQUE transition d'état (démarrage de tour inclus) — alimente le status hub. */
  onStatusChange?: (sessionId: string, state: 'idle' | 'streaming' | 'error') => void
```

Dans les champs de classe et le constructeur, mémoriser l'option :

```ts
  private readonly onStatusChange?: (sessionId: string, state: 'idle' | 'streaming' | 'error') => void
  // …dans le destructuring du constructeur : { id, projectId, data, sdk, onRekey, onStatusChange }
  this.onStatusChange = onStatusChange
```

Ajouter le setter centralisé et un getter, près de `snapshot()` :

```ts
/** État live courant — lu par le registre pour le snapshot du hub. */
get currentState(): 'idle' | 'streaming' | 'error' {
  return this.state
}

/** Unique point de mutation de `state` : notifie le hub à chaque transition. */
private setState(next: 'idle' | 'streaming' | 'error'): void {
  this.state = next
  this.onStatusChange?.(this.sessionId(), next)
}
```

Remplacer **chaque** `this.state = '…'` par `this.setState('…')` :
- ligne ~102 (`error`, projet inconnu),
- ligne ~116 (`streaming`, démarrage de tour),
- ligne ~157 (`error`, catch),
- ligne ~170 (`idle`, settle du `finally`),
- handler `turn_done` (`idle`),
- handler `turn_error` (`error`).

Dans `materializeDraft` (après `this.onRekey?.(…)`, l'id résolu change), ré-émettre l'état courant sous le NOUVEL id pour que le hub bascule le vert du draft vers l'id SDK :

```ts
// Ré-émet sous l'id SDK. NB : l'émission `streaming` sous l'id DRAFT (ligne 116) n'est
// pas rétractée → une entrée fantôme `draftId → streaming` peut rester dans `statuses`
// côté client. Inoffensif : le remap `mapping` retire le draft de la liste de sessions,
// donc cette entrée n'est jamais rendue ni ne transite vers `waiting` ; toute nouvelle
// connexion au hub snapshot le registre re-keyé proprement.
this.onStatusChange?.(sdkSessionId, this.state)
```

(La déclaration du champ `private state` ligne 34 reste `= 'idle'` : l'init n'émet rien, c'est voulu — pas d'`onStatusChange` avant qu'un abonné existe.)

> **Type partagé (cohérence) :** typer `onStatusChange`, `setState` et `currentState` avec le `SessionState` de `@atelier/shared` (`import type { SessionState } from '@atelier/shared'`) plutôt que de ré-inliner `'idle' | 'streaming' | 'error'`. Idem pour `publishStatus` en Task 3.

- [ ] **Step 4: Lancer les tests → succès**

Run: `bun test apps/server/src/stream/session-stream.test.ts`
Expected: PASS (le nouveau test + tous les existants — les broadcasts `status` par socket sont inchangés).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/stream/session-stream.ts apps/server/src/stream/session-stream.test.ts
git commit -m "feat(server): SessionStream.setState émet les transitions (hook status hub)"
```

---

### Task 3: `SessionStreamRegistry` — sinks de statut, snapshot, broadcast

**Files:**
- Modify: `apps/server/src/stream/session-stream.ts` (classe `SessionStreamRegistry`, bas du fichier)
- Test: `apps/server/src/stream/session-stream.test.ts`

- [ ] **Step 1: Écrire le test qui échoue**

```ts
it('le hub envoie un snapshot à la connexion puis diffuse les transitions', async () => {
  // registry = new SessionStreamRegistry(data, sdk) — comme les tests existants
  // 1) créer un stream et le mettre en streaming AVANT la connexion du sink hub
  const s = registry.get('s1', projectId)
  s.onMessage(JSON.stringify({ type: 'user_message', text: 'hi' })) // → streaming
  const seen: Array<{ sessionId: string; state: string }> = []
  registry.onStatusConnect((e) => seen.push({ sessionId: e.sessionId, state: e.state }))
  // snapshot initial : s1 déjà streaming
  expect(seen).toContainEqual({ sessionId: 's1', state: 'streaming' })
  await /* drain du tour */ Promise.resolve()
  // transition diffusée : s1 → idle
  expect(seen).toContainEqual({ sessionId: 's1', state: 'idle' })
})

it('onStatusClose retire le sink', () => {
  const seen: unknown[] = []
  const sink = (e: { sessionId: string }) => seen.push(e)
  registry.onStatusConnect(sink)
  const before = seen.length
  registry.onStatusClose(sink)
  registry.get('s2', projectId).onMessage(JSON.stringify({ type: 'user_message', text: 'x' }))
  expect(seen.length).toBe(before) // plus rien après close (hors snapshot déjà reçu)
})
```

- [ ] **Step 2: Lancer le test → échec**

Run: `bun test apps/server/src/stream/session-stream.test.ts`
Expected: FAIL (`onStatusConnect` inconnu).

- [ ] **Step 3: Implémenter**

Importer le type en tête de fichier :

```ts
import type { PermissionRequest, ServerEvent, SessionStatusEvent } from '@atelier/shared'
```

Dans `SessionStreamRegistry`, ajouter les sinks + méthodes, et câbler `onStatusChange` lors de la création d'un stream :

```ts
  private readonly statusSinks = new Set<(event: SessionStatusEvent) => void>()

  /** Abonne un sink au flux d'état global : snapshot immédiat de toutes les sessions vivantes, puis transitions. */
  onStatusConnect(send: (event: SessionStatusEvent) => void): void {
    this.statusSinks.add(send)
    for (const [sessionId, stream] of this.streams) {
      send({ type: 'session_status', sessionId, state: stream.currentState })
    }
  }

  onStatusClose(send: (event: SessionStatusEvent) => void): void {
    this.statusSinks.delete(send)
  }

  private publishStatus(sessionId: string, state: 'idle' | 'streaming' | 'error'): void {
    const event: SessionStatusEvent = { type: 'session_status', sessionId, state }
    for (const send of this.statusSinks) send(event)
  }
```

Dans `get()`, à la création du `new SessionStream({ … })`, ajouter :

```ts
        onStatusChange: (sessionId, state) => this.publishStatus(sessionId, state),
```

(Les clés de `this.streams` sont l'id résolu — le snapshot les émet directement. Le remap draft→réel est déjà couvert : `materializeDraft` ré-émet sous l'id SDK via `onStatusChange`.)

- [ ] **Step 4: Lancer les tests → succès**

Run: `bun test apps/server/src/stream/session-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/stream/session-stream.ts apps/server/src/stream/session-stream.test.ts
git commit -m "feat(server): status hub sur SessionStreamRegistry (snapshot + broadcast)"
```

---

### Task 4: Route WS `/api/sessions-status`

**Files:**
- Modify: `apps/server/src/app.ts`
- Test: (couvert par les tests d'intégration existants si présents ; sinon, vérif manuelle décrite ci-dessous — la logique est testée en Task 3, ici ce n'est que de la glue)

**Choix du chemin :** `/api/sessions-status` (PAS `/api/sessions/status` : ce dernier entrerait en collision avec un éventuel `GET /sessions/:id`). Aucun paramètre de route.

- [ ] **Step 1: Implémenter la route**

Dans `app.ts`, juste après le bloc `upgradeWebSocket` de `/sessions/:id/stream` (avant `app.route('/api', api)`), ajouter :

```ts
  // Status hub (spec 2026-08-02) : flux d'état de TOUTES les sessions, receive-only.
  // Canal séparé du socket de session (single-socket) pour piloter les pastilles
  // des sessions de fond. La glue est minimale — toute la logique est dans le registre.
  api.get(
    '/sessions-status',
    upgradeWebSocket(() => {
      let sink: ((event: SessionStatusEvent) => void) | null = null
      return {
        onOpen(_evt, ws) {
          sink = (event) => ws.send(JSON.stringify(event))
          streams.onStatusConnect(sink)
        },
        onClose() {
          if (sink) streams.onStatusClose(sink)
        },
      }
    })
  )
```

Ajouter l'import du type en tête de `app.ts` :

```ts
import type { ServerEvent, SessionStatusEvent } from '@atelier/shared'
```

- [ ] **Step 2: Vérifier la compilation + toute la suite serveur**

Run: `bun test apps/server`
Expected: PASS (aucune régression ; la route est de la glue autour du registre déjà testé).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/app.ts
git commit -m "feat(server): route WS /api/sessions-status (glue du status hub)"
```

---

## Chunk 2: Client — abonnement + store

### Task 5: `SessionStatusStore` (statuses / waiting / transitions / focus)

**Files:**
- Create: `apps/web/src/state/session-status-store.ts`
- Test: `apps/web/src/state/session-status-store.test.ts`

**Règles (spec §Décisions 3, 3bis, 5) :**
- `statuses: Map<id, SessionState>` — dernier état connu.
- `waiting: Set<id>` — complétions non acquittées.
- Sur `session_status` : `prev = statuses.get(id)` ; `statuses.set(id, state)`. Si `prev === 'streaming'` **et** `state !== 'streaming'` (donc `idle` **ou** `error`) **et** `id !== activeSessionId` → `waiting.add(id)`. Si `state === 'streaming'` → `waiting.delete(id)`.
- `setActive(id)` : mémorise l'id focalisé **et** `waiting.delete(id)` (vidage au focus).
- Snapshot stable pour `useSyncExternalStore` : renvoyer un objet mémorisé, recréé seulement à la mutation.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
import { describe, expect, it } from 'bun:test'
import { SessionStatusStore } from './session-status-store'

const ev = (sessionId: string, state: 'idle' | 'streaming' | 'error') => ({ type: 'session_status' as const, sessionId, state })

describe('SessionStatusStore', () => {
  it('streaming → statuses=streaming, pas de waiting', () => {
    const s = new SessionStatusStore()
    s.handle(ev('a', 'streaming'))
    expect(s.getSnapshot().statuses.get('a')).toBe('streaming')
    expect(s.getSnapshot().waiting.has('a')).toBe(false)
  })

  it('streaming → idle hors focus ⇒ waiting', () => {
    const s = new SessionStatusStore()
    s.handle(ev('a', 'streaming'))
    s.handle(ev('a', 'idle'))
    expect(s.getSnapshot().waiting.has('a')).toBe(true)
  })

  it('streaming → error hors focus ⇒ waiting (règle 3bis)', () => {
    const s = new SessionStatusStore()
    s.handle(ev('a', 'streaming'))
    s.handle(ev('a', 'error'))
    expect(s.getSnapshot().waiting.has('a')).toBe(true)
  })

  it('snapshot initial de sessions déjà idle ⇒ jamais waiting (pas de transition depuis streaming)', () => {
    const s = new SessionStatusStore()
    s.handle(ev('a', 'idle'))
    s.handle(ev('b', 'idle'))
    expect(s.getSnapshot().waiting.size).toBe(0)
  })

  it('→ idle SUR la session focalisée ⇒ pas de waiting', () => {
    const s = new SessionStatusStore()
    s.setActive('a')
    s.handle(ev('a', 'streaming'))
    s.handle(ev('a', 'idle'))
    expect(s.getSnapshot().waiting.has('a')).toBe(false)
  })

  it('→ streaming vide le waiting (le vert prime)', () => {
    const s = new SessionStatusStore()
    s.handle(ev('a', 'streaming'))
    s.handle(ev('a', 'idle'))
    s.handle(ev('a', 'streaming'))
    expect(s.getSnapshot().waiting.has('a')).toBe(false)
  })

  it('setActive vide le waiting de la session focalisée', () => {
    const s = new SessionStatusStore()
    s.handle(ev('a', 'streaming'))
    s.handle(ev('a', 'idle'))
    s.setActive('a')
    expect(s.getSnapshot().waiting.has('a')).toBe(false)
  })

  it('getSnapshot est stable tant que rien ne change (useSyncExternalStore)', () => {
    const s = new SessionStatusStore()
    const first = s.getSnapshot()
    expect(s.getSnapshot()).toBe(first)
    s.handle(ev('a', 'streaming'))
    expect(s.getSnapshot()).not.toBe(first)
  })

  it('notifie les abonnés à chaque mutation', () => {
    const s = new SessionStatusStore()
    let n = 0
    s.subscribe(() => { n++ })
    s.handle(ev('a', 'streaming'))
    expect(n).toBe(1)
  })
})
```

- [ ] **Step 2: Lancer → échec**

Run: `bun test apps/web/src/state/session-status-store.test.ts`
Expected: FAIL (module absent).

- [ ] **Step 3: Implémenter**

```ts
import type { SessionState, SessionStatusEvent } from '@atelier/shared'

export type SessionStatusSnapshot = {
  statuses: ReadonlyMap<string, SessionState>
  waiting: ReadonlySet<string>
}

/**
 * Source externe des pastilles (spec 2026-08-02). Le bleu est dérivé d'une
 * TRANSITION `streaming → (idle|error)` hors session focalisée — jamais d'un état
 * absolu, pour que le snapshot initial (sessions déjà idle) n'allume rien.
 */
export class SessionStatusStore {
  private statuses = new Map<string, SessionState>()
  private waiting = new Set<string>()
  private activeSessionId: string | null = null
  private snapshot: SessionStatusSnapshot = { statuses: this.statuses, waiting: this.waiting }
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SessionStatusSnapshot => this.snapshot

  handle(event: SessionStatusEvent): void {
    const { sessionId, state } = event
    const prev = this.statuses.get(sessionId)
    // Aucun changement d'état → aucune mutation, snapshot stable. Sûr même pour un
    // 'streaming' répété : une session dans `waiting` a toujours statuses=idle|error
    // (jamais streaming), donc ce retour anticipé ne peut pas sauter un `waiting.delete`.
    if (prev === state) return
    this.statuses = new Map(this.statuses).set(sessionId, state)
    let waiting = this.waiting
    if (state === 'streaming') {
      if (waiting.has(sessionId)) { waiting = new Set(waiting); waiting.delete(sessionId) }
    } else if (prev === 'streaming' && sessionId !== this.activeSessionId) {
      waiting = new Set(waiting).add(sessionId)
    }
    this.waiting = waiting
    this.commit()
  }

  setActive(sessionId: string | null): void {
    const changed = sessionId !== null && this.waiting.has(sessionId)
    this.activeSessionId = sessionId
    if (changed) {
      const waiting = new Set(this.waiting)
      waiting.delete(sessionId as string)
      this.waiting = waiting
      this.commit()
    }
  }

  private commit(): void {
    this.snapshot = { statuses: this.statuses, waiting: this.waiting }
    for (const listener of this.listeners) listener()
  }
}
```

> Note : `handle` recrée `statuses`/`waiting` seulement à la mutation → `getSnapshot` reste référentiellement stable entre les rendus (exigence `useSyncExternalStore`).

- [ ] **Step 4: Lancer → succès**

Run: `bun test apps/web/src/state/session-status-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/state/session-status-store.ts apps/web/src/state/session-status-store.test.ts
git commit -m "feat(web): SessionStatusStore (dérivation vert/bleu par transition)"
```

---

### Task 6: `StatusSocket` (WS receive-only auto-reconnectant)

**Files:**
- Create: `apps/web/src/api/status-socket.ts`
- Test: `apps/web/src/api/status-socket.test.ts`

**Réutilise** les types `SocketLike`, `SocketFactory`, `Schedule` de `./ws` (mêmes patrons de reconnexion). Receive-only (pas d'outbox). À la reconnexion, le serveur renvoie le snapshot complet → l'état se soigne tout seul (aucune logique de resync côté client).

- [ ] **Step 1: Écrire le test qui échoue**

```ts
import { describe, expect, it } from 'bun:test'
import { StatusSocket } from './status-socket'
import type { SocketLike } from './ws'

function fakeSocket() {
  const s: SocketLike & { emitOpen: () => void; emitMessage: (d: unknown) => void; emitClose: () => void; closed: boolean } = {
    onopen: null, onmessage: null, onclose: null, closed: false,
    send() {}, close() { this.closed = true },
    emitOpen() { this.onopen?.() },
    emitMessage(d) { this.onmessage?.({ data: JSON.stringify(d) }) },
    emitClose() { this.onclose?.() },
  }
  return s
}

describe('StatusSocket', () => {
  it('parse et transmet les session_status', () => {
    const sock = fakeSocket()
    const seen: unknown[] = []
    new StatusSocket((e) => seen.push(e), { createSocket: () => sock, schedule: (fn) => { void fn; return () => {} } })
    sock.emitOpen()
    sock.emitMessage({ type: 'session_status', sessionId: 'a', state: 'streaming' })
    sock.emitMessage({ type: 'garbage' })
    expect(seen).toEqual([{ type: 'session_status', sessionId: 'a', state: 'streaming' }])
  })

  it('se reconnecte après une fermeture non voulue', () => {
    let built = 0
    const socks = [fakeSocket(), fakeSocket()]
    const run: Array<() => void> = []
    new StatusSocket(() => {}, { createSocket: () => socks[built++], schedule: (fn) => { run.push(fn); return () => {} } })
    socks[0].emitOpen()
    socks[0].emitClose()      // drop → planifie une reconnexion
    run.forEach((fn) => fn()) // exécute le timer
    expect(built).toBe(2)
  })
})
```

- [ ] **Step 2: Lancer → échec**

Run: `bun test apps/web/src/api/status-socket.test.ts`
Expected: FAIL (module absent).

- [ ] **Step 3: Implémenter**

```ts
import { parseSessionStatus, type SessionStatusEvent } from '@atelier/shared'
import { getToken } from './client'
import type { Schedule, SocketFactory, SocketLike } from './ws'

const INITIAL_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 4000

const browserSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike
const timeoutSchedule: Schedule = (fn, delayMs) => {
  const id = setTimeout(fn, delayMs)
  return () => clearTimeout(id)
}

/**
 * WS receive-only vers /api/sessions-status. Auto-reconnexion (250ms→4s).
 * À chaque (re)connexion le serveur renvoie le snapshot complet, donc aucune
 * logique de resync ici. `close()` stoppe la reconnexion (démontage React).
 */
export class StatusSocket {
  private readonly url: string
  private readonly createSocket: SocketFactory
  private readonly schedule: Schedule
  private socket: SocketLike | null = null
  private backoffMs = INITIAL_BACKOFF_MS
  private closedByApp = false
  private cancelReconnect: (() => void) | null = null

  constructor(
    private readonly onEvent: (event: SessionStatusEvent) => void,
    options: { createSocket?: SocketFactory; schedule?: Schedule } = {}
  ) {
    this.createSocket = options.createSocket ?? browserSocketFactory
    this.schedule = options.schedule ?? timeoutSchedule
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    this.url = `${scheme}://${location.host}/api/sessions-status?token=${encodeURIComponent(getToken())}`
    this.connect()
  }

  close(): void {
    this.closedByApp = true
    this.cancelReconnect?.()
    this.cancelReconnect = null
    this.socket?.close()
  }

  private connect(): void {
    const socket = this.createSocket(this.url)
    this.socket = socket
    socket.onopen = () => {
      if (socket !== this.socket) return
      this.backoffMs = INITIAL_BACKOFF_MS
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      const parsed = parseSessionStatus(event.data)
      if (parsed !== null) this.onEvent(parsed)
    }
    socket.onclose = () => {
      if (socket !== this.socket) return
      if (this.closedByApp) return
      this.cancelReconnect = this.schedule(() => {
        this.cancelReconnect = null
        this.connect()
      }, this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
    }
  }
}
```

> **`location`/`getToken` dans les tests :** le constructeur construit l'URL (`location.protocol`, `location.host`, `getToken()`) dès `new StatusSocket(...)`, MÊME avec `createSocket` injecté — le test instancie bien la vraie classe. Ça passe parce que `bunfig.toml` précharge `apps/web/test-setup.ts` (`GlobalRegistrator.register()`, happy-dom) qui fournit `location` et `getToken` globalement. Précédent direct : `apps/web/src/api/ws.test.ts` instancie `new SessionSocket('s1','p1',{...})` sur le même patron et est vert. Aucune action requise — juste ne pas croire que l'URL n'est « pas exécutée ».

- [ ] **Step 4: Lancer → succès**

Run: `bun test apps/web/src/api/status-socket.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/status-socket.ts apps/web/src/api/status-socket.test.ts
git commit -m "feat(web): StatusSocket receive-only auto-reconnectant"
```

---

### Task 7: Câblage `App` — instancier, ouvrir/fermer, exposer, focus

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Instancier le store (stable pour la durée de vie du composant)**

Près de la création du `controller` (haut du composant `App`), ajouter — même patron `useMemo` que `controller` (évite d'allouer un store jeté à chaque rendu) :

```tsx
const statusStore = useMemo(() => new SessionStatusStore(), [])
```

Imports en tête de fichier :

```tsx
import { SessionStatusStore } from './state/session-status-store'
import { StatusSocket } from './api/status-socket'
```

- [ ] **Step 2: Ouvrir le socket au montage, le fermer au démontage**

```tsx
useEffect(() => {
  const socket = new StatusSocket((event) => statusStore.handle(event))
  return () => socket.close()
}, [statusStore])
```

- [ ] **Step 3: Lire le snapshot via `useSyncExternalStore`**

```tsx
const sessionStatuses = useSyncExternalStore(statusStore.subscribe, statusStore.getSnapshot)
```

- [ ] **Step 4: Synchroniser la session focalisée (vidage du bleu au focus)**

```tsx
useEffect(() => {
  statusStore.setActive(selected?.sessionId ?? null)
}, [selected, statusStore])
```

- [ ] **Step 5: Committer les parties autonomes (store + socket + effets)**

Les Steps 1-4 (import, `useMemo`, `useEffect` d'ouverture, `useSyncExternalStore`, `setActive`) ne touchent PAS le contrat de props de `SessionSidebar` — `App.tsx` compile et `App.test.tsx` reste vert. Committer ce lot :

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): App abonne le status hub (store + socket + focus)"
```

Run: `bun test apps/web/src/App.test.tsx`
Expected: PASS (aucune régression — la sidebar reçoit encore ses anciennes props).

- [ ] **Step 6: Passer `statuses`/`waiting` à la sidebar (à committer AVEC Task 8)**

Dans le JSX `<SessionSidebar … />` (ouverture vers la ligne 364), ajouter :

```tsx
          statuses={sessionStatuses.statuses}
          waiting={sessionStatuses.waiting}
```

(`streamingSessionId={…}` (vers la ligne 372) reste **inchangé** — il porte toujours le vert optimiste de la session active. Les numéros de ligne ont dérivé avec les commits slash-commands : se fier au texte d'ancrage, pas au numéro.)

⚠️ **Ces props n'existent sur `SessionSidebarProps` qu'après Task 8** : ce Step SEUL ne typecheck pas. NE PAS committer ni lancer `bun test` ici — enchaîner Task 8, qui committe `App.tsx` + le composant + son test en un seul lot cohérent.

---

## Chunk 3: UI — pastille

### Task 8: `SessionDotState = 'waiting'` + `dotState` + props sidebar

**Files:**
- Modify: `apps/web/src/components/SessionListItem.tsx`
- Modify: `apps/web/src/components/SessionSidebar.tsx`
- Modify: `apps/web/src/components/SessionSidebar.test.tsx` (le fichier EXISTE — 234 lignes)

⚠️ **Contraintes du fichier de test existant** (`SessionSidebar.test.tsx`), à respecter pour ne pas casser la suite :
1. Il a déjà un helper LOCAL `function dotState(name: string)` (ligne ~70) qui lit `data-state` sur le DOM. **Ne PAS importer un `dotState` du composant** (collision de nom). On garde `dotState` **interne** au composant (non exporté) et on teste par le RENDU, avec le helper DOM existant.
2. Le helper `renderSidebar` (lignes ~44-58) construit un `SessionSidebarProps` complet. Comme on ajoute des props **requises** `statuses`/`waiting`, il faut leur donner un défaut dans `renderSidebar`, sinon TOUS les tests existants cessent de compiler et `SessionList` appelle `.get`/`.has` sur `undefined`.
3. Les sessions factices existantes sont `realSession` (id `s1`, `messageCount 5`) et `draftSession` (id `d1`, draft). Réutiliser ces constantes — pas de factory `sess()`.

- [ ] **Step 1: Écrire les tests qui échouent**

(a) Ajouter les défauts dans `renderSidebar` (après `streamingSessionId: null,`) :

```tsx
    statuses: new Map(),
    waiting: new Set(),
```

(b) Ajouter, dans le `describe('SessionSidebar sessions', …)`, des assertions de rendu réutilisant le helper DOM `dotState(name)` et `realSession` (`s1`) :

```tsx
  test('vert (run) quand le hub signale streaming pour la session', () => {
    renderSidebar({ statuses: new Map([['s1', 'streaming']]) })
    expect(dotState('Refresh token expiré')).toBe('run')
  })

  test('bleu (waiting) quand la session est en attente hors focus', () => {
    // NB : `dotState` ignore volontairement le focus — le vidage au focus vit dans
    // le store (setActive), pas ici. Le défaut activeSessionId='s1' n'affecte donc rien.
    renderSidebar({ waiting: new Set(['s1']) })
    expect(dotState('Refresh token expiré')).toBe('waiting')
  })

  test('le vert prime le bleu (priorité run > waiting)', () => {
    renderSidebar({ statuses: new Map([['s1', 'streaming']]), waiting: new Set(['s1']) })
    expect(dotState('Refresh token expiré')).toBe('run')
  })
```

(Le cas `streamingSessionId: 's1'` → `run` et les cas `done`/`idle` par défaut sont déjà couverts par le test existant lignes 75-86 — inchangés.)

- [ ] **Step 2: Lancer → échec**

Run: `bun test apps/web/src/components/SessionSidebar.test.tsx`
Expected: FAIL (type `'waiting'` inexistant ; `dotState` du composant ignore `statuses`/`waiting` ; les nouveaux `data-state` ne sortent pas).

- [ ] **Step 3: Implémenter**

Dans `SessionListItem.tsx`, étendre le type et son docblock :

```ts
/**
 * Sidebar state dots (spec 2026-08-02) :
 * - run: la session stream (vert) — hub ou vert optimiste de la session active
 * - waiting: un tour vient de finir/échouer hors focus, en attente (bleu)
 * - idle: rien encore — drafts et sessions vides (faible, plein)
 * - done: historique, pas de tour en cours (contour)
 */
export type SessionDotState = 'run' | 'waiting' | 'idle' | 'done'
```

Dans `SessionSidebar.tsx` : importer `SessionState`, étendre `SessionSidebarProps`, threader dans `SessionList`, réécrire `dotState` (**interne, NON exporté** — pas de collision avec le helper de test) :

```ts
import type { ProjectSummary, SessionState, SessionSummary } from '@atelier/shared'

// dans SessionSidebarProps :
  /** État live par session (hub) — vert pour 'streaming'. */
  statuses: ReadonlyMap<string, SessionState>
  /** Sessions ayant fini/échoué hors focus, en attente de l'utilisateur — bleu. */
  waiting: ReadonlySet<string>
```

```tsx
// dans SessionList({ …, streamingSessionId, statuses, waiting, … }) : passer les maps à dotState :
        state={dotState(session, streamingSessionId, statuses, waiting)}
```

```ts
function dotState(
  session: SessionSummary,
  streamingSessionId: string | null,
  statuses: ReadonlyMap<string, SessionState>,
  waiting: ReadonlySet<string>,
): SessionDotState {
  // vert : hub dit streaming OU la session active stream de façon optimiste
  if (statuses.get(session.id) === 'streaming' || session.id === streamingSessionId) return 'run'
  if (waiting.has(session.id)) return 'waiting'
  if (session.isDraft || session.messageCount === 0) return 'idle'
  return 'done'
}
```

> `SessionList` reçoit tout `SessionSidebarProps` (spread `{...props}` depuis `SessionSidebar`), donc `statuses`/`waiting` y arrivent déjà — il suffit de les ajouter au destructuring de `SessionList` (ligne ~128).

- [ ] **Step 4: Lancer → succès**

Run: `bun test apps/web/src/components/SessionSidebar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit (inclut le JSX du Step 6 de Task 7 — un seul lot qui typecheck)**

```bash
git add apps/web/src/components/SessionListItem.tsx apps/web/src/components/SessionSidebar.tsx apps/web/src/components/SessionSidebar.test.tsx apps/web/src/App.tsx
git commit -m "feat(web): pastille 'waiting' (bleu) + dotState vert>bleu>idle>done"
```

---

### Task 9: CSS de la pastille bleue

**Files:**
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Ajouter la variante**

Après `.dot[data-state='done'] { … }` (ligne ~212) :

```css
  .dot[data-state='waiting'] { background: var(--color-blue); }
```

(`--color-blue` existe déjà dans la palette. Le bleu est **statique** : ne PAS l'ajouter au bloc `@media (prefers-reduced-motion: no-preference)` du pulse, réservé à `run`.)

- [ ] **Step 2: Vérification visuelle rapide (facultatif, hors serveur 4517)**

Pas de test unitaire CSS. Vérifier au besoin dans un build web (`bun run build:web`) — sans lancer de serveur sur 4517 (voir memory coordination). Le rendu `data-state="waiting"` est déjà couvert par les tests de la Task 8.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/styles.css
git commit -m "style(web): pastille bleue pour l'état 'waiting'"
```

---

### Task 10: Suite complète + revue finale

- [ ] **Step 1: Lancer toute la suite**

Run: `bun test`
Expected: PASS (tous les tests verts, aucune régression sur les 428+ existants).

- [ ] **Step 2: Vérifier le flux bout-en-bout (intentions, spec §Flux de données)**

Relire mentalement contre la spec : (1) session de fond qui démarre → vert ; (2) `turn_done`/`turn_error` hors focus → bleu ; (3) focus → bleu vidé ; (4) snapshot initial de sessions idle → aucun bleu ; (5) hub déconnecté → repli silencieux sur `streamingSessionId` (session active toujours verte, aucune bannière).

- [ ] **Step 3: Commit final si nécessaire**

```bash
git add -A && git commit -m "test: suite complète verte pour les pastilles d'état"
```

---

## Plan Review Loop

Après chaque chunk, dispatcher un plan-document-reviewer (contexte précis : contenu du chunk + chemin de la spec `docs/specs/2026-08-02-session-status-dots-design.md`), corriger jusqu'à ✅, puis chunk suivant. Max 5 itérations par chunk, sinon remonter à l'humain.

## Execution Handoff

Plan sauvegardé dans `docs/plans/2026-08-02-session-status-dots.md`. Exécuter via **superpowers:subagent-driven-development** (sous-agents disponibles) : un sous-agent frais par tâche + revue deux étages, dans un worktree `.worktrees/status-dots`.
