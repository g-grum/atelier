# Charte graphique v5 — « Sombre apaisé » + mode clair

**Date** : 2026-07-24 · **Statut** : validé (brainstorm avec Germain, compagnon visuel)
**Portée** : refonte **visuelle uniquement**. La structure (layout 3 zones, composants, dashboard de widgets) ne change pas.

## Contexte et problème

La charte v4.2 (navy profond, 8 accents néon saturés, glows en gradient radial, texte 13px) est jugée « difficilement digeste et dure à suivre ». Diagnostic partagé : trop de couleurs saturées en concurrence, contrastes insuffisants, décor (glows, gradients) qui parasite le contenu.

## Décisions (validées une à une)

| Sujet | Décision |
|---|---|
| Direction | **Sombre apaisé** : gris neutres quasi-noirs (fini le navy), un seul accent, zéro glow/gradient décoratif |
| Modes | Dark **et** light ; **toggle manuel uniquement** (Atelier ignore le système), ☀︎/☾ en topbar, choix persisté |
| Couleur fonctionnelle | Minimale et désaturée (option B) : la couleur **signale**, ne décore jamais |
| Ambre | Réservé **exclusivement** aux demandes de permission (règle v4.2 conservée) |
| Structure | Inchangée — mêmes composants, mêmes noms de classes CSS |
| Logo | Conservé tel quel dans ce scope (variante neutralisée = follow-up optionnel) |

## Tokens

| Rôle | Dark (défaut) | Light |
|---|---|---|
| ground | `#101014` | `#fafafa` |
| surface | `#16161c` | `#ffffff` |
| surface-2 | `#1e1e26` | `#f1f1f3` |
| line | `#2e2e36` | `#e4e4e7` |
| line-soft | `#26262c` | `#ececef` |
| text | `#f2f2f6` | `#18181b` |
| muted | `#a0a0aa` | `#71717a` |
| faint | `#6e6e78` | `#a1a1aa` |
| **accent** (primary, ring, liens, focus) | `#7a9fff` | `#3b63e0` |
| success | `#57c98a` | `#16a34a` |
| error | `#f0705f` | `#dc2626` |
| **amber (permissions uniquement)** | `#d9a03f` | `#b45309` |

S'y ajoutent : un token sémantique `--color-mauve` (verbe Edit/Write, état merged) et les 5 slots projet (voir « Code couleur fonctionnel »). Les valeurs exactes peuvent être affinées au mockup (contraste AA obligatoire) ; les rôles et la règle « un seul accent » sont fermes.

**Supprimés** : magenta, teal, blue, violet comme accents UI (les *noms* de tokens survivent comme slots projet, cf. « Code couleur fonctionnel » — ne pas les supprimer du `@theme`) ; gradients radiaux du `body` ; glows ; gradient cyan→indigo→magenta de la barre d'usage (remplacé par un remplissage accent uni, qui passe à l'ambre puis au rouge près des seuils).

## Code couleur fonctionnel (résiduel, désaturé)

- **Projets** : rotation de 5 teintes sourdes (bleu-gris, terracotta, sauge, mauve, sable). Visibles uniquement sur la pastille 8 px et le liseré de sidebar.
  **Compatibilité disque — zéro migration** : `Project.color` persiste des *noms* de tokens (`cyan`/`magenta`/`violet`/`mint`/`teal`, cf. `COLOR_PALETTE` dans `settings-routes.ts`). Ces 5 noms de tokens sont **conservés** et deviennent les slots d'identité projet : leurs *valeurs* sont remplacées par les 5 teintes sourdes (`cyan`→bleu-gris, `magenta`→terracotta, `mint`→sauge, `violet`→mauve, `teal`→sable). `COLOR_PALETTE` et les données existantes ne bougent pas. Tout usage **non-projet** de ces tokens dans les recettes CSS est re-câblé vers les tokens sémantiques (accent, success…) lors de la transcription.
- **Tools** : seul le **verbe** du tool call est coloré — Bash = accent, Edit/Write = mauve sourd, Read/autres = muted. Le reste du chip en neutre.
- **États** : running = success, merged = mauve sourd, erreur = error — sur points/badges uniquement, jamais en aplat de fond.

## Typographie & densité

- Base `13.5px / 1.6` (contre `13px / 1.5`) ; texte assistant à `15px` en zone de lecture.
- Polices inchangées : SF Pro (sans), SF Mono (mono).
- Espacement vertical entre messages légèrement augmenté.
- Contrastes vérifiés AA dans les deux modes (texte normal ≥ 4.5:1, muted ≥ 3:1 sur les tailles concernées).

## Mécanisme de thème

- `data-theme="light"` posé sur `<html>` ; **absent = dark** (défaut et rétrocompat).
- Les tokens `@theme` de `styles.css` pointent vers des variables CSS commutées par ce sélecteur ; `color-scheme` suit le mode.
- Aucun composant ne référence une couleur en dur : tout passe par les tokens (les recettes qui embarquent des `rgba()` en dur sont réécrites vers les tokens).
- Pas de flash au démarrage : `localStorage` sert de **cache du dernier thème connu** ; un script inline dans `index.html` pose `data-theme` avant le mount React. La préférence serveur reste la source de vérité (le cache est resynchronisé à chaque fetch des préférences et à chaque bascule). Premier lancement (cache vide) = dark. Si la préférence serveur diverge du cache (changée fenêtre fermée), le thème bascule une fois juste après le mount — comportement **attendu**, pas un bug.

## Toggle & persistance

- Bouton ☀︎/☾ dans la Topbar (à côté du model-chip). Bascule optimiste immédiate.
- `Preferences.theme?: 'dark' | 'light'` dans `@atelier/shared` — clé absente = dark (le deep-merge existant de `app-data` gère la rétrocompat disque).
- Écriture via la route settings existante (`PATCH /preferences`). Également modifiable depuis SettingsPanel.
- **Electron** : la couleur de fond de la `BrowserWindow` (`main.ts`, aujourd'hui `#0c101c` en dur) suit le thème persisté — `main.ts` lit directement le JSON app-data au boot (la fenêtre est créée avant que le serveur ne réponde), fallback dark si absent/illisible. Livraison desktop = `bun run package:mac` + relance ⌘Q (déploiement 3 étages).

## Process de livraison (mockup-first)

1. **`docs/mockups/v5.0.html`** : mockup complet (même structure DOM/classes que v4.2, nouvelle charte, les deux modes + toggle fonctionnel dans le mockup), produit avec le skill `frontend-design`. **Validation par Germain dans le navigateur avant tout code app.**
2. Transcription dans `apps/web/src/styles.css` : bloc `@theme` + recettes `@layer components`, mêmes noms de classes (la structure TSX ne bouge pas), mapping shadcn re-câblé.
3. Toggle : Topbar + SettingsPanel + préférence serveur + fond BrowserWindow.
4. v5.0.html devient la source de vérité visuelle (remplace v4.2 dans ce rôle ; v4.2 reste dans le repo comme historique).

## Tests

- La suite existante : les noms de classes ne changent pas → impact attendu minime ; les assertions qui vérifient des couleurs en dur sont mises à jour.
- Nouveaux : préférence `theme` (store deep-merge + `PATCH /preferences`), composant toggle (bascule + persistance + resync localStorage), application du `data-theme` avant mount (script inline, cache vide = dark).

## Risques & suivis

- **Risque** : dérive visuelle entre mockup v5 et transcription → parade : revue côte à côte mockup/app avant merge.
- **Risque** : contrastes light mode sur les teintes sourdes → parade : vérification AA systématique au mockup.
- **Follow-up optionnel** (hors scope) : variante neutralisée du logo (`assets/logo.svg` + `make:icons`).
- **Follow-up existant renforcé** : le rendu markdown du texte assistant (déjà dans la liste v0.2) contribuera aussi à la lisibilité — hors scope ici.
