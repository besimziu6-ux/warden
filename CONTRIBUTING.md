# Contributing to game-panel

Thanks for helping out. This guide covers the local setup, test loop, and
what a good pull request looks like.

## Setup

Requirements: Node 20+, Docker (only needed to run real game containers;
the backend falls back to a mock driver without it).

```sh
bash scripts/install.sh --check
bash scripts/install.sh --dry-run
npm test --prefix backend
```

Full install (needs Docker):

```sh
bash scripts/install.sh
ADMIN_USERNAME=admin ADMIN_PASSWORD='<strong-password>' npm run create-admin --prefix backend
docker compose up -d
```

## Running the backend

```sh
npm start --prefix backend
```

The panel serves the static frontend from `frontend/` and the API from `/api/*`.
Health check: `GET /health`.

## Tests

Backend tests use the Node built-in runner (`node:test`, no extra deps):

```sh
npm test --prefix backend
```

Suites live in `backend/test/`:

- `safepath.test.js` — file-manager path jail stays inside `data/servers/<id>`
- `eggs.test.js` — the 7 game eggs keep their pinned images and valid ports
- `auth.test.js` — bearer-token parsing, JWT round-trip, `requireAuth`/`requireAdmin`
- `lifecycle.test.js` — container state machine against the docker mock
  (`DOCKER_MOCK=1`, in-memory only, no files written)

Add or update tests with any behavior change. All 23+ assertions must pass
before opening a PR.

## Style

- Plain CommonJS (`require`/`module.exports`), 2-space indent.
- Early returns for validation; route handlers answer `{ error }` JSON.
- No new runtime dependencies for tests; `node:test` + `node:assert/strict` only.
- Never commit `data/`, `.env`, logs, or backups. `data/` is gitignored on purpose.
- Never commit real passwords, tokens, or password hashes. Use placeholders
  such as `<strong-password>` in docs and examples.

## Pull requests

1. Keep the change scoped; one topic per PR.
2. Update `README.md` and `openapi.json` when you change the API.
3. Run `npm test --prefix backend` and `bash scripts/install.sh --check`;
   paste both results into the PR description.
4. Small, reviewable diffs beat large rewrites.
