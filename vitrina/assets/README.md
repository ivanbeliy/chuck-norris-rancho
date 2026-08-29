# Vendored browser assets

Served at `/_a/<file>` with a one-week immutable cache. Vendored on purpose —
not loaded from a CDN — so artifacts keep working offline, load fast over
Funnel, and never change under an old artifact when a CDN moves.

| File | What | Used by |
|---|---|---|
| `react.js` | React 18, production UMD build | `templates/react.html` |
| `react-dom.js` | ReactDOM 18, production UMD build | `templates/react.html` |
| `babel.js` | @babel/standalone 7 — compiles JSX in the browser | `templates/react.html` |
| `tailwind.js` | Tailwind CSS 3 Play CDN runtime (JIT in the browser) | `templates/react.html` |

To upgrade, drop in the new UMD build under the same file name and bump the
artifact CSP if a library starts needing a new source type.
