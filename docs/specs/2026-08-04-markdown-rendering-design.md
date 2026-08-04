# Rendu markdown des messages assistant — design

**Date** : 2026-08-04 · **Statut** : validé par Germain

## Objectif

Les messages de Claude s'affichent en markdown rendu (titres, gras, listes, tables GFM, code coloré) au lieu de texte brut. Les messages utilisateur restent en texte brut (fidèle à claude.ai).

## Approche

`react-markdown` + `remark-gfm` + `rehype-highlight` (highlight.js). Sûr par défaut (HTML brut non rendu). Écartés : Shiki (intégration lourde), parsing maison (fragile).

## Composants

- **MessageItem** : `role === 'assistant'` → body rendu via `<Markdown>` avec classe `body markdown` ; user inchangé (`pre-wrap` brut).
- **CodeBlock** (`components={{ pre }}`) : wrapper des blocs de code avec bouton « Copier » (clipboard, feedback « Copié » ~2 s). Coloration hljs, thème clair/sombre via variables CSS (pas d'import de thème hljs tout fait — styles `.markdown .hljs-*` dans styles.css, tokens charte v5).
- **Styles** : `.msg .body.markdown` — espacement p/ul/ol/pre/blockquote, inline-code sur fond `surface-2`, tables bordées. `white-space` normal (le markdown gère les paragraphes).

## Streaming

Re-rendu à chaque delta ; markdown partiel toléré par react-markdown (dégradation propre). Pas de mémoïsation en v1.

## Tests

MessageItem.test.tsx : gras/titre/liste rendus en éléments HTML ; user NON transformé (`**` littéral) ; bloc de code → `<code class="language-x">` ; bouton copier écrit dans le clipboard (mock) et affiche le feedback.

## Hors périmètre

Markdown des messages user, mermaid, KaTeX, virtualisation, mémoïsation par blocs.
