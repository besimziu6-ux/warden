# game-panel

Self-hosted game server panel. Create servers from per-game eggs, manage files,
watch the live console over WebSocket, handle players via RCON, and schedule
restarts and backups. Runs with Docker in production and degrades to a mock
driver for development without a Docker daemon.

## Features

- 7 pinned game eggs with sane defaults (see table below)
- JWT auth with `admin` / `user` roles; first registered user becomes admin
- Server lifecycle: create, start, stop, restart, kill (mock-backed without Docker)
- Per-container isolation: 2G RAM, 2 CPUs, 256 pids, non-privileged,
  `no-new-privileges`, `CapDrop=ALL`, user `1000:1000`, one `/data` bind per server
- File manager jailed to `data/servers/<id>` (browse, edit, mkdir, rename,
  delete, upload up to 20MB, download)
- Live console at `/ws/servers/:id/console` with history in `console.log`
- Player controls over RCON (`list`, `kick`, `ban`, `op`, `say`, raw `command`);
  mock player list when RCON is not configured
- Tarball backups (`POST /:id/backups`, restore, delete) plus cron schedules
  (`start`, `stop`, `restart`, `backup`, `command`) via `node-cron`
- Static dashboard in `frontend/` (server list, create wizard, manage view)
- One-command installer with `--check` and `--dry-run` modes

## Supported games

Source of truth: `backend/src/games/eggs.js`.

| Egg | Name | Image | Ports |
| --- | ---- | ----- | ----- |
| `minecraft-java` | Minecraft Java (Paper) | `itzg/minecraft-server:latest` | 25565/tcp |
| `minecraft-bedrock` | Minecraft Bedrock | `itzg/minecraft-bedrock-server:latest` | 19132/udp |
| `cs2` | Counter-Strike 2 | `joedwards32/cs2:latest` | 27015/tcp, 27015/udp |
| `rust` | Rust | `cm2network/rust:latest` | 28015/tcp, 28015/udp, 28016/tcp |
| `ark` | ARK: Survival Evolved | `hermsi/ark-server:latest` | 7777/udp, 7778/udp, 27015/tcp, 27015/udp |
| `valheim` | Valheim | `lloesche/valheim-server:latest` | 2456/tcp, 2456/udp, 2457/udp, 2458/udp |
| `terraria` | Terraria | `ryshe/terraria:latest` | 7777/tcp |

## Quick install

Requirements: Node 20+, Docker for real game containers (optional for a
mock-mode preview).

```sh
bash scripts/install.sh --check
bash scripts/install.sh --dry-run
npm test --prefix backend
```

Full install with Docker:

```sh
bash scripts/install.sh
ADMIN_USERNAME=admin ADMIN_PASSWORD='<strong-password>' npm run create-admin --prefix backend
docker compose up -d
```

Then open `http://localhost:3000` (or your `PORT`) and log in.

Manual alternative without Docker (mock mode):

```sh
cp .env.example .env
npm install --prefix backend
ADMIN_USERNAME=admin ADMIN_PASSWORD='<strong-password>' npm run create-admin --prefix backend
npm start --prefix backend
```

Config lives in `.env` (see `.env.example`): `PORT`, `JWT_SECRET` (generate
with `openssl rand -hex 32`), `JWT_EXPIRES`, `DATA_ROOT`. Never commit `.env`
or anything under `data/`; both are gitignored.

## API docs

Full machine-readable spec: [`openapi.json`](openapi.json). Auth is a
`Bearer` JWT from `/api/auth/*` (`Authorization: Bearer <token>`).

Auth:

- `POST /api/auth/register` `{ username, password }` → `{ token, user }`
- `POST /api/auth/login` `{ username, password }` → `{ token, user }`
- `GET /api/auth/me` → current user
- `GET /api/users` (admin) → user list

Servers and lifecycle:

- `GET /api/games` → egg list
- `GET /api/servers`, `POST /api/servers` `{ game, name, env? }`
- `GET /api/servers/:id`
- `POST /api/servers/:id/start|stop|restart|kill`

Files (all require auth, jailed to the server root):

- `GET /api/servers/:id/files?path=<rel>`
- `GET /api/servers/:id/files/download?path=<file>`
- `PUT /api/servers/:id/files` `{ path, content }`
- `POST /api/servers/:id/files/mkdir` `{ path }`
- `POST /api/servers/:id/files/delete` `{ path }`
- `POST /api/servers/:id/files/rename` `{ from, to }`
- `POST /api/servers/:id/files/upload?path=<dir>` (multipart, field `file`)

Players (RCON or mock):

- `GET /api/servers/:id/players`
- `POST /api/servers/:id/players/kick|ban` `{ player, reason? }`
- `POST /api/servers/:id/players/op` `{ player }`
- `POST /api/servers/:id/players/say` `{ message }`
- `POST /api/servers/:id/players/command` `{ command }`

Backups and schedules:

- `GET /api/servers/:id/backups`, `POST /api/servers/:id/backups` `{ name? }`
- `POST /api/servers/:id/backups/:backupId/restore`
- `DELETE /api/servers/:id/backups/:backupId`
- `GET /api/servers/:id/schedules`, `POST /api/servers/:id/schedules`
  `{ cron, action: start|stop|restart|backup|command, payload?, enabled? }`
- `DELETE /api/servers/:id/schedules/:scheduleId`
- `GET /health` → `{ ok, mock, time }`

WebSocket console:

```text
GET /ws/servers/:id/console?token=<jwt>
```

Send a command line (plain text or `{ "command": "..." }`); the server streams
console lines back and persists history to `data/servers/<id>/console.log`.
Without a Docker container attached, the backend emits mock ticks.

Example:

```sh
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<strong-password>"}' | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).token)')
curl -s localhost:3000/api/games -H "Authorization: Bearer $TOKEN" | head -c 300
curl -s -X POST localhost:3000/api/servers \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"game":"minecraft-java","name":"my-server"}'
```

## Layout

```text
backend/src/index.js        express app + static frontend
backend/src/games/eggs.js   the 7 pinned game eggs
backend/src/lib/docker.js   dockerode driver + mock fallback + limits
backend/src/lib/auth.js     JWT auth middleware
backend/src/routes/         auth, servers, files, players, backups, schedules, console
backend/test/               node:test suites (npm test)
frontend/                   static dashboard (index, manage)
scripts/install.sh          installer (--check / --dry-run / install)
docker-compose.yml          panel service (binds data/ + docker.sock)
openapi.json                REST + WS spec
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm test --prefix backend` and
`bash scripts/install.sh --check` before every PR.

## License

MIT — see [LICENSE](LICENSE).
