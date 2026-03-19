#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
ENV_FILE="$ROOT_DIR/.env.local"
ENV_EXAMPLE="$ROOT_DIR/.env.local.example"
BACKEND_LOG="$ROOT_DIR/.backend.dev.log"
FRONTEND_LOG="$ROOT_DIR/.frontend.dev.log"

BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

stop_existing_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Port $port is already in use. Stopping existing process(es): $pids"
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}

ensure_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo "Created $ENV_FILE from template."
    echo "Please edit OPENAI_API_KEY in $ENV_FILE and rerun."
    exit 1
  fi
}

load_env() {
  set -a
  source "$ENV_FILE"
  set +a
}

check_deps() {
  command -v python3 >/dev/null 2>&1 || { echo "python3 is required"; exit 1; }
  command -v npm >/dev/null 2>&1 || { echo "npm is required"; exit 1; }
  command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }
}

install_deps() {
  echo "Installing backend dependencies..."
  python3 -m pip install -r "$BACKEND_DIR/requirements.txt"
  echo "Installing frontend dependencies..."
  (cd "$FRONTEND_DIR" && npm install)
}

cleanup() {
  echo
  echo "Stopping local dev services..."
  if [[ -n "${BACK_PID:-}" ]]; then kill "$BACK_PID" 2>/dev/null || true; fi
  if [[ -n "${FRONT_PID:-}" ]]; then kill "$FRONT_PID" 2>/dev/null || true; fi
}

wait_for_backend() {
  echo "Waiting for backend on http://127.0.0.1:${BACKEND_PORT}/health ..."
  for _ in $(seq 1 40); do
    if curl -sS "http://127.0.0.1:${BACKEND_PORT}/health" >/dev/null 2>&1; then
      echo "Backend is ready."
      return 0
    fi
    sleep 0.5
  done
  echo "Backend failed to start. See $BACKEND_LOG"
  return 1
}

ensure_file
check_deps
load_env

stop_existing_port "$BACKEND_PORT"
stop_existing_port "$FRONTEND_PORT"

if [[ "${1:-}" == "--install" ]]; then
  install_deps
fi

if [[ -z "${OPENAI_API_KEY:-}" || "${OPENAI_API_KEY}" == "your-api-key" ]]; then
  echo "OPENAI_API_KEY is missing in $ENV_FILE"
  exit 1
fi

echo "Starting backend..."
OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://127.0.0.1:8317/v1}" \
OPENAI_API_KEY="$OPENAI_API_KEY" \
DEFAULT_MODEL_NAME="${DEFAULT_MODEL_NAME:-gpt-5.4}" \
uvicorn backend.app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" \
  >"$BACKEND_LOG" 2>&1 &
BACK_PID=$!

trap cleanup EXIT INT TERM

wait_for_backend

echo "Starting frontend..."
(
  cd "$FRONTEND_DIR"
  npm run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT"
) >"$FRONTEND_LOG" 2>&1 &
FRONT_PID=$!

echo
echo "Local dev started:"
echo "- Frontend: http://127.0.0.1:${FRONTEND_PORT}"
echo "- Backend:  http://127.0.0.1:${BACKEND_PORT}"
echo "- Logs:     $BACKEND_LOG, $FRONTEND_LOG"
echo
echo "Press Ctrl+C to stop both services."

wait "$FRONT_PID"
