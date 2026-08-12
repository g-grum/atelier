# Mentions de fichiers (@) dans le composer

**Date** : 2026-08-12
**Statut** : validé

## Objectif

Permettre de référencer les fichiers et dossiers du projet courant depuis le champ de saisie du chat en tapant `@` : un popover d'autocomplétion fuzzy s'ouvre, la sélection insère le chemin relatif dans le texte. Le prompt part inchangé (string) ; l'agent lit les fichiers mentionnés via ses outils.

## Non-objectifs

- Pas d'injection du contenu des fichiers côté serveur (l'agent lit lui-même).
- Pas de changement du protocole WS (`ClientMessage` inchangé).
- Pas de recherche côté serveur (`?q=`) : le filtrage fuzzy est client.

## Architecture

### 1. Serveur — endpoint de listing

`apps/server/src/files/files-routes.ts`, monté dans `app.ts` à côté de `commandsRoutes`.

- `GET /api/projects/:id/files`
- Résout le projet via `data.get().projects.find(...)` ; 404 `{ error: 'unknown project' }` si absent.
- Énumération : `git ls-files -z --cached --others --exclude-standard` exécuté avec `cwd = project.path` (respecte `.gitignore`, inclut les fichiers non suivis ; `-z` + split sur NUL pour éviter le C-quoting des chemins accentués). Fallback si la commande échoue (pas un repo git) : parcours `Bun.Glob('**/*')` en excluant `.git/`, `node_modules/`, `dist*/`.
- Dossiers : dérivés des chemins de fichiers **avant troncature** (ensemble des parents), pas de listing séparé.
- Réponse : `{ files: string[], dirs: string[] }` — chemins relatifs POSIX, triés, plafonnés à 20 000 entrées au total (troncature silencieuse au-delà, fichiers prioritaires).

### 2. Client API

- `apps/web/src/api/backend.ts` : `listFiles(projectId): Promise<{ files: string[]; dirs: string[] }>` via le helper `request()` de `client.ts`. Le backend fixture (mode démo) renvoie `{ files: [], dirs: [] }`.
- `App.tsx` : `filesQuery` (react-query), clé `['files', projectId]`, `staleTime: 30_000`, activée quand une session avec projet est ouverte. La réponse est fusionnée (mémoïsée dans `App.tsx`) en `{ path, dir }[]` avant d'être passée au `Composer` en prop `files`.

### 3. Logique pure — `apps/web/src/lib/file-mentions.ts`

Module sans dépendance UI, miroir de `slash-commands.ts` :

- `mentionPrefix(text: string, caret: number): string | null` — retourne le token après un `@` situé avant le caret, si ce `@` est en début de texte ou précédé d'un espace/retour ligne (évite les emails `a@b`). Le token s'arrête au caret et ne contient pas d'espace. `null` sinon. Limitation connue et assumée : les chemins contenant des espaces peuvent être insérés mais ne re-matchent pas si le caret y revient.
- `matchFiles(entries: { path: string; dir: boolean }[], prefix: string): Entry[]` — fuzzy par paliers comme `matchCommands` : préfixe exact > sous-chaîne > sous-séquence ; match sur le chemin complet avec bonus sur le nom de base. Limité à ~15 résultats. Les dossiers sont affichés avec `/` final.
- `completeMention(text: string, caret: number, path: string, dir: boolean): { text: string; caret: number }` — remplace le token `@…` par `@path` ; ajoute un espace après un fichier, un `/` final sans espace après un dossier (pour pouvoir continuer à taper dedans).

### 4. Composer — popover

`apps/web/src/components/Composer.tsx` :

- Nouvelle prop `files`.
- Second popover, même mécanique que celui des slash commands : état actif dérivé de `mentionPrefix(text, caret)`, navigation ↑↓, validation Enter/Tab, fermeture Esc, `dismissed` réinitialisé quand le préfixe change, sélection souris via `onMouseDown`.
- Priorité : si les deux popovers pourraient s'ouvrir (impossible en pratique, `/` exige la position 0), le popover commandes gagne.
- Factorisation : uniquement si triviale (ex. petit helper de navigation clavier partagé) ; sinon duplication assumée.

## Flux de données

```
@ tapé → mentionPrefix() → filesQuery (cache 30s) → matchFiles() → popover
sélection → completeMention() → texte "@chemin" → onSend inchangé → WS user_message → runTurn
```

## Gestion d'erreurs

- Endpoint en échec ou requête en cours : popover simplement absent, aucune erreur bloquante dans le composer.
- Projet non-git : fallback glob ; si le fallback échoue aussi, réponse `{ files: [], dirs: [] }`.
- Repo énorme : plafond 20k entrées côté serveur, 15 résultats côté client.

## Tests

- **`file-mentions.test.ts`** : `mentionPrefix` (début de texte, milieu après espace, email ignoré, caret au milieu d'un token, multi-lignes) ; `matchFiles` (paliers, dossiers, limite) ; `completeMention` (fichier + espace, dossier + `/`, remplacement au caret).
- **`files-routes.test.ts`** : projet inconnu → 404 ; repo git fixture → fichiers `.gitignore` exclus, non-suivis inclus ; dossiers dérivés corrects ; répertoire non-git → fallback.
- **Composer** : test existant étendu — ouverture du popover sur `@`, complétion clavier.
