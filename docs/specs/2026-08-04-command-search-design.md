# Recherche dans le popover de commandes — design

Date: 2026-08-04 · Statut: validé avec le propriétaire (Germain) en brainstorming.

## Problème

Le popover de slash commands (spec `2026-07-31-slash-commands-design.md`)
filtre par **préfixe strict** sur le nom et les alias
(`slash-commands.ts:18-23`) : `/plan` ne trouve pas `writing-plans`, `/diff`
ne trouve pas `code-review`. Et les descriptions sont tronquées sur une ligne
(`styles.css`, `.cmd-desc` : `white-space: nowrap` + ellipse), ce qui rend le
catalogue difficile à explorer.

Germain veut que **taper `/` dans le composer serve d'explorateur de
commandes** : retrouver une commande par ce qu'elle *fait*, pas seulement par
son nom, et lire sa description complète sans quitter le popover.

Alternatives écartées en brainstorming : widget dashboard dédié, palette ⌘K,
champ de recherche séparé dans le popover — le texte tapé après `/` **est**
déjà la requête ; toute autre surface serait redondante.

## Décisions

1. **Recherche par paliers, pas de fuzzy.** Sous-chaîne insensible à la casse,
   classée : P1 nom/alias *commence par* la requête, P2 nom/alias *contient*,
   P3 description *contient*. Le fuzzy (fzf-like) a été écarté : scoring à
   régler, résultats imprévisibles sur des descriptions longues, complexité
   disproportionnée pour ~40 commandes. Pas de surlignage des matchs (pourra
   s'ajouter plus tard).
2. **Signature de `matchCommands` inchangée.** La logique du Composer
   (`prefix → matches → popover`) ne bouge pas ; seul le classement interne
   change.
3. **Détail sur l'élément actif, en CSS seul.** La liste reste dense (une
   ligne par commande) ; l'item actif déplie sa description en `line-clamp`
   ~4 lignes. Pas de nouveau composant, pas de nouvel état React.
4. **Le survol souris rend actif.** Aujourd'hui `active` ne suit que le
   clavier ; le dépliage doit répondre aussi à la souris.
5. **Requête vide → catalogue complet, ordre d'origine** (comportement actuel
   conservé).
6. **Rien côté serveur.** Aucun changement de protocole, de sonde ni de
   routes. Feature 100 % web.

## 1. Recherche — `apps/web/src/lib/slash-commands.ts`

`matchCommands(commands, prefix)` garde sa signature
(`(readonly SlashCommandInfo[], string) → SlashCommandInfo[]`) et classe
chaque commande dans son **meilleur** palier :

- **P1** — `name` ou un alias commence par la requête (comportement actuel) ;
- **P2** — `name` ou un alias contient la requête ;
- **P3** — `description` contient la requête.

Règles :

- comparaison insensible à la casse (requête et champs passés en minuscules,
  comme aujourd'hui — **description comprise** pour P3) ;
- chaque commande apparaît **une seule fois**, dans son meilleur palier ;
- à l'intérieur d'un palier, l'**ordre d'origine** de la liste est préservé
  (tri stable — trois passes de `filter`, pas de `sort` avec score) ;
- requête vide : toutes les commandes matchent P1 (`startsWith('')` est
  toujours vrai) — l'ordre d'origine complet est donc conservé, sans cas
  spécial.

`commandPrefix` et `completeCommand` sont inchangées.

## 2. Détail sur l'élément actif — `Composer.tsx` + `styles.css`

**CSS** (`styles.css:356-361`) : `.cmd-desc` reste `nowrap` + ellipse par
défaut ; sur `li.active`, elle passe en

```css
.command-popover li.active .cmd-desc {
  white-space: normal;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
}
```

Le `li` reste en flex row `align-items: baseline` : la description multiligne
(`flex: 1; min-width: 0`) s'aligne sur sa première ligne, nom et hint restent
sur cette ligne.

**Composer** (`Composer.tsx:84-103`) : ajout de `onMouseMove` sur chaque `li`
→ `setActive(index)`. `onMouseMove` et non `onMouseEnter` : si la liste
défile sous un curseur immobile (navigation clavier), `onMouseEnter` se
déclencherait sur l'item qui passe sous le curseur et volerait la sélection
clavier ; `onMouseMove` n'active que lorsque la souris bouge réellement.
Le `scrollIntoView` de l'item actif existe déjà (`Composer.tsx:41-43`).

Interaction clavier/souris : les deux écrivent le même état `active` ; le
dernier geste gagne. Pas d'état séparé « hover ».

## 3. Tests

- `slash-commands.test.ts` : P2 (`plan` trouve `writing-plans`), P3 (`diff`
  trouve une commande dont seule la description contient `diff`), ordre
  P1 < P2 < P3, dédup (une commande matchant nom ET description n'apparaît
  qu'une fois, au palier nom), casse, requête vide → liste complète dans
  l'ordre d'origine, aucun match → `[]`.
- `Composer.test.tsx` : `mouseMove` sur un item le rend actif
  (`aria-selected`) ; la sélection clavier existante n'est pas cassée. Le
  rendu `line-clamp` n'est pas observable sous happy-dom — c'est la classe
  `active` (déjà testée pour le clavier) qui porte le dépliage, aucun test
  CSS supplémentaire.
- Vérification manuelle (vrai navigateur) : le dépliage de l'item actif
  change la hauteur de ligne — contrôler que `scrollIntoView({block:
  'nearest'})` reste confortable en navigation clavier, et que le nudge de
  défilement au survol d'un item partiellement visible ne gêne pas.

## 4. Gestion d'erreur

Aucun chemin nouveau : fonction pure sans I/O, dégradation identique à
l'existant (liste vide → popover fermé).
