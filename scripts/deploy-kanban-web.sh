#!/usr/bin/env bash
#
# deploy-kanban-web.sh — sobe o MKS Kanban WEB (container único: backend
# NestJS servindo o React em /, API /api/v1, WS /socket.io) e ALINHA o auth
# com o MakeStudio (SSO).
#
# SSO: o kanban passa a validar o JWT da CONTA gptapi (HS256) setando
#   LOCAL_JWT_SECRET = hex(AUTH_JWT_SECRET do gptapi)
# A chave HMAC fica idêntica à do gptapi → o token da conta (passado pelo
# iframe via postMessage) autentica direto, sem segundo login. O login próprio
# do kanban (SEED_ADMIN) também continua, pois assina com a MESMA chave.
#
# Rebuilda a imagem (frontend novo) e re-sobe o container PRESERVANDO o DB
# (postgres externo) e o env atual (DATABASE_URL/JWT_SECRET/SEED_*).
#
# Uso: bash scripts/deploy-kanban-web.sh [host] [backend_container]
#   host              (default root@zielinski.dev.br)
#   backend_container (default zielinski-backend) — de onde lê AUTH_JWT_SECRET
#                     (/app/config/.env, via docker exec)
#
# On-prem (amanhã): bash scripts/deploy-kanban-web.sh root@192.168.100.29 <backend_container>
set -euo pipefail

HOST="${1:-root@zielinski.dev.br}"
BACKEND_CONTAINER="${2:-zielinski-backend}"
REMOTE_DIR="/opt/zielinski/kanban"
IMAGE="mks-kanban:latest"
CONTAINER="mks-kanban"
NETWORK="zielinski-network"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[kanban-deploy] 1/4 — rsync source -> $HOST:$REMOTE_DIR"
ssh "$HOST" "mkdir -p $REMOTE_DIR"
rsync -az --delete \
  --exclude node_modules --exclude .git \
  --exclude 'frontend/dist' --exclude 'backend/dist' \
  frontend backend Dockerfile "$HOST:$REMOTE_DIR/"

echo "[kanban-deploy] 2/4 — docker build (frontend novo embarcado)"
ssh "$HOST" "cd $REMOTE_DIR && docker build -t $IMAGE ."

echo "[kanban-deploy] 3/4 — env (preserva atual + LOCAL_JWT_SECRET alinhado) + re-sobe"
ssh "$HOST" "BACKEND_CONTAINER='$BACKEND_CONTAINER' CONTAINER='$CONTAINER' NETWORK='$NETWORK' IMAGE='$IMAGE' bash -s" <<'REMOTE'
set -euo pipefail
ENVFILE="$(mktemp)"; trap 'rm -f "$ENVFILE"' EXIT
# Preserva o env do container atual (DATABASE_URL, JWT_SECRET, SEED_*, etc).
docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^(JWT_SECRET|SEED_ADMIN_EMAIL|SEED_ADMIN_PASSWORD|NODE_ENV|PORT|DB_DRIVER|DATABASE_URL|FRONTEND_DIST)=' \
  > "$ENVFILE"
# AUTH_JWT_SECRET do gptapi (lê /app/config/.env do container backend) -> hex
# (chave HMAC compartilhada p/ SSO).
AUTH="$(docker exec "$BACKEND_CONTAINER" cat /app/config/.env 2>/dev/null | grep -E '^AUTH_JWT_SECRET=' | head -1 | cut -d= -f2- | tr -d '\r' | sed -E 's/^"(.*)"$/\1/')"
if [ -z "$AUTH" ]; then echo "[remote] ERRO: AUTH_JWT_SECRET vazio em $BACKEND_CONTAINER:/app/config/.env"; exit 1; fi
# hex dos BYTES utf8 do secret (== Buffer.from(AUTH,'utf8').toString('hex')).
# od é puro-shell (o host do VPS não tem node).
HEX="$(printf '%s' "$AUTH" | od -An -v -tx1 | tr -d ' \n')"
echo "LOCAL_JWT_SECRET=$HEX" >> "$ENVFILE"
echo "[remote] env keys: $(cut -d= -f1 "$ENVFILE" | sort | tr '\n' ' ')"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --network "$NETWORK" --restart unless-stopped \
  --env-file "$ENVFILE" "$IMAGE" >/dev/null
sleep 5
echo "[remote] logs:"; docker logs --tail 6 "$CONTAINER" 2>&1 || true
REMOTE

echo "[kanban-deploy] 4/4 — health público"
curl -sS -o /dev/null -w "  kanban https=%{http_code}\n" https://kanban.zielinski.dev.br/ || true
echo "[kanban-deploy] FIM."
