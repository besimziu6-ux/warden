#!/usr/bin/env bash
# One-command installer for game-panel.
# Usage:
#   bash scripts/install.sh            # full install
#   bash scripts/install.sh --check    # verify setup without changing anything
#   bash scripts/install.sh --dry-run  # print what install would do
#   bash scripts/install.sh --help     # this help
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
ENV_FILE="$ROOT/.env"
ENV_EXAMPLE="$ROOT/.env.example"
COMPOSE_FILE="$ROOT/docker-compose.yml"

MODE="install"
for arg in "$@"; do
  case "$arg" in
    --check|--dry-run|-h|--help|help)
      case "$arg" in
        --check) MODE="check" ;;
        --dry-run) MODE="dry-run" ;;
        *) MODE="help" ;;
      esac
      ;;
    *) echo "unknown argument: $arg" >&2; echo "try: bash scripts/install.sh --help" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = "help" ]; then
  sed -n '2,10p' "$0"
  echo ""
  echo "Admin creation (after install):"
  echo "  ADMIN_USERNAME=admin ADMIN_PASSWORD='<strong-password>' npm run create-admin --prefix backend"
  echo "Then open http://localhost:3000 (or your PORT) and log in."
  exit 0
fi

DRY="$([ "$MODE" = "dry-run" ] && echo 1 || echo 0)"
CHECK="$([ "$MODE" = "check" ] && echo 1 || echo 0)"
PASS=0
FAIL=0

ok()   { echo "ok: $1"; PASS=$((PASS + 1)); }
warn() { echo "warn: $1"; }
fail() { echo "fail: $1"; FAIL=$((FAIL + 1)); }

node_major() {
  node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

egg_images() {
  if command -v node >/dev/null 2>&1 && [ -f "$BACKEND/src/games/eggs.js" ]; then
    node -e 'try { const m = require(process.argv[1]); console.log(Object.values(m.EGGS).map((e) => e.image).join("\n")); } catch (e) { process.exit(1); }' "$BACKEND/src/games/eggs.js" 2>/dev/null && return 0
  fi
  printf '%s\n' \
    "itzg/minecraft-server:latest" \
    "itzg/minecraft-bedrock-server:latest" \
    "joedwards32/cs2:latest" \
    "cm2network/rust:latest" \
    "hermsi/ark-server:latest" \
    "lloesche/valheim-server:latest" \
    "ryshe/terraria:latest"
}

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; return 0; fi
  if command -v node >/dev/null 2>&1; then node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'; return 0; fi
  tr -dc 'a-f0-9' < /dev/urandom | head -c 64; echo
}

check_compose() {
  if [ ! -f "$COMPOSE_FILE" ]; then fail "docker-compose.yml missing"; return 1; fi
  if docker compose version >/dev/null 2>&1; then
    if docker compose -f "$COMPOSE_FILE" config >/dev/null 2>&1; then ok "compose config validates"; return 0; fi
    fail "docker compose config failed"; return 1
  fi
  if docker-compose config >/dev/null 2>&1; then ok "compose config validates (docker-compose)"; return 0; fi
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' "$COMPOSE_FILE" 2>/dev/null; then
    ok "compose file parses as YAML (docker not present, full validation skipped)"; return 0
  fi
  if grep -q 'image: node:20' "$COMPOSE_FILE" && grep -q 'ports:' "$COMPOSE_FILE" && grep -q 'volumes:' "$COMPOSE_FILE"; then
    ok "compose file contains panel service, node 20, ports, volumes (basic check)"
    return 0
  fi
  fail "compose file failed basic sanity check"; return 1
}

if [ "$CHECK" = "1" ]; then
  echo "game-panel install check (no changes made)"
  [ -f "$ENV_EXAMPLE" ] && ok ".env.example exists" || fail ".env.example missing"
  [ -f "$COMPOSE_FILE" ] && ok "docker-compose.yml exists" || fail "docker-compose.yml missing"
  [ -f "$ROOT/docker/minecraft-java.Dockerfile" ] && ok "docker/minecraft-java.Dockerfile exists" || fail "example Dockerfile missing"
  [ -f "$BACKEND/scripts/create-admin.js" ] && ok "backend/scripts/create-admin.js exists" || fail "create-admin.js missing"
  [ -f "$BACKEND/package.json" ] && ok "backend/package.json exists" || fail "backend/package.json missing"

  if command -v node >/dev/null 2>&1; then
    MAJOR="$(node_major)"
    if [ "$MAJOR" -ge 20 ] 2>/dev/null; then ok "node $MAJOR detected (>= 20)"; else fail "node major version $MAJOR < 20"; fi
    if node --check "$BACKEND/src/lib/docker.js" 2>/dev/null; then ok "backend/src/lib/docker.js parses"; else fail "docker.js syntax error"; fi
    if node --check "$BACKEND/src/index.js" 2>/dev/null; then ok "backend/src/index.js parses"; else fail "index.js syntax error"; fi
    if node -e 'const d = require(process.argv[1]); const s = { id: "check", env: {} }; const l = d.limitsFor(s); if (l.User !== "1000:1000" || !l.Memory || !l.NanoCpus || !l.PidsLimit) { process.exit(1); }' "$BACKEND/src/lib/docker.js" 2>/dev/null; then
      ok "daemon limits enforced (memory, cpus, pids, user 1000:1000)"
    else
      fail "daemon limits missing in backend/src/lib/docker.js"
    fi
    if grep -q 'Privileged: false' "$BACKEND/src/lib/docker.js" 2>/dev/null; then ok "containers run non-privileged"; else fail "Privileged:false not found in docker.js"; fi
  else
    fail "node not found (need node 20+)"
  fi

  if command -v docker >/dev/null 2>&1; then
    ok "docker CLI present ($(docker --version 2>/dev/null | head -n1))"
  else
    echo "warn: docker not found; install will require it, check continues"
  fi

  check_compose || true

  echo ""
  echo "Pinned per-egg images (backend/src/games/eggs.js):"
  egg_images | sed 's/^/  - /' || true
  echo ""
  echo "Admin creation:"
  echo "  ADMIN_USERNAME=admin ADMIN_PASSWORD='<strong-password>' npm run create-admin --prefix backend"
  echo ""
  if [ "$FAIL" = "0" ]; then echo "check passed ($PASS ok)"; exit 0; fi
  echo "check failed: $FAIL problem(s)" >&2; exit 1
fi

# ---- install / dry-run ----
echo "game-panel installer"
echo "root: $ROOT"

if ! command -v node >/dev/null 2>&1; then echo "error: node not found; install node 20+ first" >&2; exit 1; fi
MAJOR="$(node_major)"
if [ "$MAJOR" -lt 20 ] 2>/dev/null; then echo "error: node $MAJOR found, need node 20+" >&2; exit 1; fi
echo "node $(node --version) detected"

if ! command -v docker >/dev/null 2>&1; then
  if [ "$DRY" = "1" ]; then
    echo "warn: docker not found (dry-run continues)"
  else
    echo "error: docker not found; install docker first" >&2; exit 1
  fi
else
  echo "docker detected: $(docker --version | head -n1)"
fi

if [ ! -f "$ENV_FILE" ]; then
  if [ "$DRY" = "1" ]; then
    echo "[dry-run] would create .env from .env.example with generated JWT_SECRET"
  else
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    if grep -q 'change-me' "$ENV_FILE"; then
      SECRET="$(gen_secret)"
      if command -v python3 >/dev/null 2>&1; then
        JWT_SECRET="$SECRET" python3 -c 'import os,re; p=os.environ; s=open("'"$ENV_FILE"'").read(); s=re.sub(r"^JWT_SECRET=.*$", "JWT_SECRET="+p["JWT_SECRET"], s, flags=re.M); open("'"$ENV_FILE"'","w").write(s)'
      else
        sed -i "s/^JWT_SECRET=.*$/JWT_SECRET=$SECRET/" "$ENV_FILE"
      fi
    fi
    echo "created $ENV_FILE (JWT_SECRET generated)"
  fi
else
  echo ".env already exists, leaving it alone"
fi

if [ -f "$BACKEND/package-lock.json" ]; then INSTALL_CMD="npm ci --prefix $BACKEND"; else INSTALL_CMD="npm install --prefix $BACKEND"; fi
if [ "$DRY" = "1" ]; then
  echo "[dry-run] would run: $INSTALL_CMD"
else
  echo "installing backend dependencies..."
  # shellcheck disable=SC2086
  $INSTALL_CMD
fi

echo "game images to pull:"
egg_images | sed 's/^/  - /'
if [ "$DRY" = "1" ]; then
  echo "[dry-run] would run: docker pull <each image above>"
else
  egg_images | while IFS= read -r img; do
    [ -n "$img" ] || continue
    echo "pulling $img..."
    docker pull "$img" || warn "failed to pull $img (continuing)"
  done
fi

if [ "$DRY" = "1" ]; then
  echo "[dry-run] would validate: docker compose -f $COMPOSE_FILE config"
else
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" config >/dev/null && echo "compose config validates"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$COMPOSE_FILE" config >/dev/null && echo "compose config validates"
  else
    warn "no compose plugin found; skipping compose validation"
  fi
fi

PORT_VAL="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tail -n1 || true)"
PORT_VAL="${PORT_VAL:-3000}"
echo ""
echo "done."
echo "Start the panel:  docker compose -f $COMPOSE_FILE up -d   (or: npm start --prefix $BACKEND)"
echo "Open:             http://localhost:$PORT_VAL"
echo "Create an admin:  ADMIN_USERNAME=admin ADMIN_PASSWORD='<strong-password>' npm run create-admin --prefix backend"
