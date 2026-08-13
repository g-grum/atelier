# Upload d'image dans le composer

**Date** : 2026-08-13
**Statut** : validé

## Objectif

Permettre d'ajouter une image dans le composer (coller, glisser-déposer, bouton parcourir). L'image est uploadée dans un dossier scratch du projet ; une référence `@chemin` est insérée dans le texte. L'agent lit l'image via son outil Read (qui ingère les images) — l'image entre ainsi dans son contexte. Pas de changement du protocole WebSocket.

## Non-objectifs

- Pas de vrai multimodal (blocs `image` en base64 vers le SDK) — approche B, évolution future.
- Pas de Files API Anthropic (upload cloud) — inadapté à un agent local qui lit le FS.
- Pas de miniature/prévisualisation riche dans le composer en V1 (juste la référence texte + état d'upload).
- L'image uploadée est git-ignorée (`.atelier/*`), donc **non listée par le popover `@`** (`git ls-files --exclude-standard`) : une image n'est pas ré-mentionnable via `@` plus tard. Acceptable — l'insertion est directe.
- Le `.atelier/` projet-level (scratch uploads) est distinct du `~/.atelier/` HOME (app-data du serveur) — aucun conflit de scope.

## Note permission

Lire l'image passe par le flux de permission Read de l'agent : sur une session sans règle « toujours autoriser Read », un prompt de permission apparaîtra avant que l'agent ne voie l'image. Comportement attendu, pas un bug.

## Architecture

### 1. Serveur — endpoint d'upload

`apps/server/src/uploads/uploads-routes.ts`, monté dans `app.ts` à côté de `filesRoutes`.

- `POST /api/projects/:id/uploads` — multipart/form-data, champ `file`.
- Résout le projet via `data.get().projects.find(...)` ; 404 `{ error: 'Not found' }` si absent (motif `commands-routes.ts` / `files-routes.ts`).
- **Validation** :
  - Type MIME dans `{ image/png, image/jpeg, image/gif, image/webp }` — sinon 400 `{ error: 'Type de fichier non supporté' }`.
  - Taille ≤ 10 Mo — sinon 400 `{ error: 'Image trop volumineuse (max 10 Mo)' }`.
  - Champ `file` absent/vide — 400 `{ error: 'Aucun fichier' }`.
- **Écriture** : `<project.path>/.atelier/uploads/<uuid>.<ext>` (mkdir récursif au besoin). L'extension dérive du MIME (`extensionForMime`), pas du nom de fichier client (évite le path traversal via nom).
- **Auto-ignore git** : le serveur garantit un fichier `<project.path>/.atelier/.gitignore` contenant `*` (créé une fois s'il manque). Le dossier scratch s'auto-ignore ; on ne modifie jamais le `.gitignore` racine du projet.
- Réponse : `{ path: ".atelier/uploads/<uuid>.png" }` — chemin relatif POSIX, prêt à être référencé par `@`.

### 2. Logique pure — `apps/server/src/uploads/image-uploads.ts`

Fonctions pures, testables sans I/O :
- `ALLOWED_IMAGE_MIME: Record<string, string>` — MIME → extension (`image/png` → `png`, `image/jpeg` → `jpg`, `image/gif` → `gif`, `image/webp` → `webp`).
- `extensionForMime(mime: string): string | null` — extension ou `null` si non supporté.
- `MAX_IMAGE_BYTES = 10 * 1024 * 1024`.

La route consomme ces helpers ; le nommage `<uuid>` utilise `crypto.randomUUID()`.

### 3. Client API

- `apps/web/src/api/client.ts` : `uploadImage(projectId, file: File): Promise<{ path: string }>` — `fetch` multipart dédié (le helper `request()` sérialise du JSON ; l'upload utilise `FormData` + le même header `Authorization: Bearer`, sans `Content-Type` — le navigateur pose le boundary). Sur `!response.ok`, réplique l'extraction `{ error }` de `request()` (client.ts) et lève `ApiError(status, message FR)`.
- `apps/web/src/api/backend.ts` : `Backend.uploadImage` (type), `realBackend.uploadImage = client.uploadImage`, fixture `uploadImage: async () => ({ path: '.atelier/uploads/demo.png' })`.

### 4. Composer — trois entrées + insertion

`apps/web/src/components/Composer.tsx`, nouvelle prop `onUploadImage: (file: File) => Promise<{ path: string }>` (câblée depuis `App.tsx` sur `backend.uploadImage(projectId, …)`).

- **Coller** (`onPaste`) : détecte les items image du presse-papier (`event.clipboardData.items`), `preventDefault`, upload le premier item image.
- **Glisser-déposer** (`onDragOver`/`onDrop`) : `preventDefault`, upload le premier `file` image de `dataTransfer.files`.
- **Bouton parcourir** : bouton image dans la barre du composer + `<input type="file" accept="image/*" hidden>` déclenché au clic ; upload le fichier choisi.
- **Insertion** : à la réussite, insère `@<path> ` dans le texte à la position du caret via un helper `insertMention(text, caret, path)` dans `file-mentions.ts`. Contrairement à `completeMention` (qui tranche un `@` déjà tapé), l'upload n'a pas de `@` préexistant : le helper **préfixe un espace** si le caractère juste avant le caret n'est ni un blanc ni le début du texte, sinon la mention `@path` collée à un mot (`voici@.atelier/…`) violerait la règle « `@` précédé d'un blanc » de `mentionPrefix` et casserait la cohérence @-mentions. Suffixe : un espace après le chemin. Le caret se repositionne après la référence.
- **État d'upload** : un indicateur léger « Envoi de l'image… » pendant la requête ; désactive un second upload concurrent (drapeau `uploading`).
- **Erreurs** : type/taille/réseau → message inline non bloquant (réutilise le style d'erreur existant si présent, sinon un petit texte sous le composer) ; le brouillon est conservé.

### 5. Envoi

Inchangé : le texte contenant `@.atelier/uploads/…` part par `user_message` sur le WS ; l'agent lit l'image via Read.

## Flux de données

```
coller / drop / parcourir → File → onUploadImage → POST /uploads (multipart)
  → serveur écrit .atelier/uploads/<uuid>.png → { path }
  → insertMention insère "@path " dans le texte → onSend (WS) inchangé → Read
```

## Gestion d'erreurs

- Projet inconnu → 404. Type/taille invalides → 400 message FR affiché inline.
- Upload en échec (réseau) : message inline, brouillon conservé, pas de crash.
- Upload concurrent : bloqué tant que `uploading` est vrai.
- Nettoyage des fichiers scratch : hors périmètre V1 (les images restent sous `.atelier/uploads/`, git-ignorées).

## Tests

- **`file-mentions.test.ts`** (étendu) : `insertMention` — espace de tête ajouté après un mot non-blanc, pas ajouté en début de texte ni après un blanc ; suffixe espace ; caret repositionné.
- **`image-uploads.test.ts`** : `extensionForMime` (chaque MIME supporté, `null` sur inconnu), constantes.
- **`uploads-routes.test.ts`** : projet inconnu → 404 ; PNG valide → 200 `{ path }`, fichier écrit sous `.atelier/uploads/`, `.atelier/.gitignore` créé avec `*` ; MIME non supporté → 400 ; taille > 10 Mo → 400 ; champ `file` absent → 400. (AppData sur tmpdir jetable, motif `files-routes.test.ts`.)
- **Composer** (`Composer.test.tsx` étendu) : coller une image → `onUploadImage` appelé, `@path` inséré ; bouton parcourir → upload ; erreur d'upload → message inline, brouillon conservé ; upload concurrent bloqué. (Fichier/presse-papier simulés via `File`/`DataTransfer` factices ou stubs d'événements.)
