# Moat frontend

Independent React + TypeScript + Vite application. The original React app in
`demo/homepage/` and the team lead's implementation remain intact. This package
can install, test and build without reading `demo/`.

## Local development

Use a Node version supported by Vite 8 (Node 20.19+ or 22.12+).

```sh
cd frontend
npm ci
npm run dev
```

Open http://127.0.0.1:5174/. The port is strict so the origin does not silently
change. Run the existing demo backend on port 8787 for legacy pages and API calls.
The homepage itself needs no backend to render or copy the sandbox commands.
To use another backend, set `MOAT_BACKEND_ORIGIN` in `frontend/.env.local`.
Only the Vite server reads this value; it is not a client-side credential.

```sh
npm run typecheck
npm test
npm run build
npm run test:integration
npm run preview
```

Preview listens at http://127.0.0.1:4174/. `test:integration` requires the build
and exercises dev and preview against an isolated local HTTP fixture. It tests
request/response forwarding, not the backend's payment decisions.

## Structure

```text
frontend/
  src/app/                 # React bootstrap and application composition
  src/components/layout/   # reusable React layout components, including Footer
  src/pages/Compare/       # existing React comparison route
  compare/index.html      # production Compare document entry
  src/pages/Home/          # approved page and its presentation components
  src/features/sandbox/    # curl example, agent URLs and clipboard behavior
  src/styles/              # pinned shared tokens/styles + page-specific CSS
  src/tests/               # content, clipboard and shared-navigation tests
    fixtures/              # immutable approved HTML and provenance hashes
  public/shared/           # unchanged classic navigation and trail scripts
  public/                  # frontend favicon and cursor
  scripts/                 # dev/preview proxy integration verification
  dist/                    # generated production output, ignored by Git
```

`src/components/layout/Navbar.tsx` and `src/components/layout/Footer.tsx` are
the shared React layout components. The React application manages `/` and the
native `/compare` page; `/#api` is the homepage's `#api` section rather than a
separate document.

## Shared code and authentication

`src/styles/shared.css`, `public/shared/app.js`, `public/shared/trail.js`, the
favicon and cursor are explicitly pinned copies of the existing shared assets.
Their source paths and SHA-256 values are in
`src/tests/fixtures/provenance.json`; tests reject unintended snapshot drift.
The application never imports files from `demo/` at build or runtime.

The React `Navbar` owns navigation, the mobile menu and the `moat.admin`
localStorage label on React routes. The dashboard (`src/pages/Dashboard`) signs
in with the same `moat.admin` slot, so the site and the workspace agree. The pinned `public/shared/app.js` remains a tested
compatibility snapshot; it is not loaded by either React HTML entry. Legacy
pages request `/app.js` from the backend through the proxy.

All CTA paths remain unchanged. Vite development and preview proxy these routes
to the existing backend:

| Paths | Owner |
| --- | --- |
| `/v1/*`, `/mcp` and `/mcp/*` | Existing backend APIs |
| `/tests`, `/status` (also `.html`) | Existing demo pages during staged migration |
| `/app.css`, `/app.js`, `/footer.css`, `/footer.js`, `/trail.js` | Assets used by those legacy pages |
| `/`, `/index.html`, `/compare`, `/docs`, `/team`, `/dashboard`, `/shared/*`, `/assets/*`, `/console-assets/*`, favicon/cursor | This frontend |

Query strings such as `/tests?run=1` and fragments such as
`/dashboard#pane-playground` are preserved. Proxying keeps legacy navigation and
React on one browser origin, so they see the same localStorage. A workspace saved
on port 8787, port 5173, or `localhost` is **not** automatically available at
`127.0.0.1:5174`: browser storage is origin-specific. No tokens are copied.

## Page ownership and footer boundary

| Route | Owner | React footer |
| --- | --- | --- |
| `/` and `/#api` | `frontend/` | Shared `src/components/layout/Footer.tsx` |
| `/compare` | `frontend/src/pages/Compare/Compare.tsx` | Shared React Navbar/Footer |
| `/dashboard` (and the old `/dashboard.html`) | `frontend/src/pages/Dashboard/Dashboard.tsx` | None: the workspace has its own header |
| `/tests` | `demo/public/tests.html` | Shared legacy footer via `footer.js`/`footer.css` |
| `/status` | `demo/public/status.html` | Shared legacy footer via `footer.js`/`footer.css` |

The independent frontend does not replace remaining legacy documents with
placeholders. Compare is now a native React entry and is no longer proxied to
the legacy server, and so is the Dashboard. Tests and Status remain staged legacy
dependencies until their page-specific API/authentication behavior is migrated.
No Moat-owned LinkedIn, WhatsApp, or email account was present in the
repository. The footer therefore links only to the verified official LinkedIn
and WhatsApp domains; the Email glyph is visibly marked unavailable rather than
inventing a contact address.

## Production boundary

`npm run build` emits only `frontend/dist/`. It does not copy legacy pages or
write to `demo/public`. Vite's dev/preview proxies are not part of the static
bundle. Production hosting must serve the frontend at `/` and route the legacy
paths/assets and API paths above to the existing demo service on the same origin.
That server/deployment integration is intentionally not implemented here.

The original external Ubuntu/Ubuntu Mono font links and fallback fonts remain.
The sandbox agent links still contain the current origin; an external hosted
agent cannot reach a developer's loopback server. Use an approved reachable
environment for that workflow; this task creates no tunnel or deployment.

## Approved baseline and verification

`src/tests/fixtures/approved-home.html` is an unchanged snapshot of
`demo/public/index.html` taken for this migration. Do not edit it to make a test
pass. A future approved baseline update must include its origin/hash and a
reviewed intentional UI change. Tests retain the original section, content and
CTA assertions, plus immutable asset and shared-navigation checks.

See `DESIGN.md` for the architectural decisions behind the approved layout.

## Known limitations

- **Live sandbox** requires the Rust gateway/backend services to be running.
- **Production routing** requires same-origin serving of React pages, legacy
  pages, and API paths; that deployment integration is not implemented here.
- **External fonts** (Ubuntu/Ubuntu Mono via Google Fonts) require network access.
- **Hosted agents** cannot reach a developer's loopback server; use a reachable
  environment when testing sandbox agent links end-to-end.
- **Compare footer** Product links are same-document anchors; changing
  destinations or routing behaviour is outside this cleanup scope.
- **Social links** are generic official sites only; an Email address was not
  present in the repository, so the glyph is visibly marked unavailable.
- **Disk space**: the full build, `npm ci`, and Vite caches require adequate
  free space on the working drive. Watch for low-disk errors during npm or tsc.

The original React directory can be considered for removal only after production
routing and backend integration are verified and its owner approves removal.
