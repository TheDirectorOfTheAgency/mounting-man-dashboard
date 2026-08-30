#!/bin/bash
set -euo pipefail
umask 077

LABEL="com.themountingman.gbp-worker"
HOME_DIR="/Users/thedirector"
APP_DIR="$HOME_DIR/.local/share/themountingman/gbp-worker"
STATE_DIR="$HOME_DIR/.local/state/themountingman/gbp-worker"
SECRET_DIR="$HOME_DIR/.config/themountingman/gbp-worker"
SECRET_FILE="$SECRET_DIR/worker-secret"
SESSION_FILE="$HOME_DIR/.hermes/credentials/gbp-playwright-session/storage_state.json"
PLIST_DEST="$HOME_DIR/Library/LaunchAgents/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_SRC="$REPO_ROOT/m1/gbp-worker/gbp_worker.py"
PLIST_SRC="$REPO_ROOT/m1/gbp-worker/$LABEL.plist"
REQUIREMENTS_SRC="$REPO_ROOT/m1/gbp-worker/requirements.txt"
DOMAIN="gui/$(id -u)"

usage() {
  printf '%s\n' "Usage: $0 [--install|--rollback|--check-session|--dry-run]"
}

run_installed() {
  local mode="$1"
  if [[ ! -x "$APP_DIR/venv/bin/python" || ! -f "$APP_DIR/gbp_worker.py" ]]; then
    printf '%s\n' "GBP worker is not installed" >&2
    exit 2
  fi
  exec "$APP_DIR/venv/bin/python" "$APP_DIR/gbp_worker.py" "$mode" --headless
}

backup_current() {
  if [[ ! -f "$PLIST_DEST" ]]; then
    return
  fi
  local stamp backup old_worker
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$STATE_DIR/backups/$stamp"
  mkdir -p "$backup"
  cp "$PLIST_DEST" "$backup/$LABEL.plist"
  old_worker="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$PLIST_DEST" 2>/dev/null || true)"
  if [[ -n "$old_worker" && -f "$old_worker" ]]; then
    cp "$old_worker" "$backup/gbp_worker.py"
    printf '%s\n' "$old_worker" > "$backup/original-worker-path"
  fi
  chmod -R go-rwx "$backup"
}

rollback() {
  local backup old_worker
  backup="$(ls -1dt "$STATE_DIR"/backups/* 2>/dev/null | head -n 1 || true)"
  if [[ -z "$backup" || ! -f "$backup/$LABEL.plist" ]]; then
    printf '%s\n' "No GBP worker backup is available" >&2
    exit 2
  fi
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  if [[ -f "$backup/original-worker-path" && -f "$backup/gbp_worker.py" ]]; then
    IFS= read -r old_worker < "$backup/original-worker-path"
    mkdir -p "$(dirname "$old_worker")"
    install -m 0755 "$backup/gbp_worker.py" "$old_worker"
  fi
  install -m 0644 "$backup/$LABEL.plist" "$PLIST_DEST"
  launchctl bootstrap "$DOMAIN" "$PLIST_DEST"
  printf '%s\n' "GBP worker rollback restored"
}

install_worker() {
  for required in "$WORKER_SRC" "$PLIST_SRC" "$REQUIREMENTS_SRC" "$SESSION_FILE"; do
    if [[ ! -f "$required" ]]; then
      printf '%s\n' "Required GBP worker input is missing" >&2
      exit 2
    fi
  done
  if ! command -v uv >/dev/null 2>&1; then
    printf '%s\n' "uv is required" >&2
    exit 2
  fi
  if ! command -v hermes >/dev/null 2>&1; then
    printf '%s\n' "Hermes CLI is required" >&2
    exit 2
  fi

  backup_current
  mkdir -p "$APP_DIR" "$STATE_DIR/artifacts" "$STATE_DIR/backups" "$SECRET_DIR" "$(dirname "$PLIST_DEST")"
  chmod 0700 "$APP_DIR" "$STATE_DIR" "$STATE_DIR/artifacts" "$STATE_DIR/backups" "$SECRET_DIR"
  chmod 0600 "$SESSION_FILE"

  local env_path worker_secret
  env_path="$(hermes config env-path | tail -n 1)"
  worker_secret="$(ENV_PATH="$env_path" python3 - <<'PY'
import os
from pathlib import Path
key = "INSTALL_POST_GBP_" + "WORKER_SECRET"
for line in Path(os.environ["ENV_PATH"]).read_text(encoding="utf-8").splitlines():
    if line.startswith(key + "="):
        value = line.partition("=")[2].strip()
        if len(value) >= 24 and not any(ch.isspace() for ch in value):
            print(value, end="")
            raise SystemExit(0)
raise SystemExit(2)
PY
  )"
  if [[ ${#worker_secret} -lt 24 ]]; then
    printf '%s\n' "Canonical GBP worker credential is unavailable" >&2
    exit 2
  fi
  printf '%s\n' "$worker_secret" > "$SECRET_FILE"
  chmod 0600 "$SECRET_FILE"
  unset worker_secret

  uv venv --python 3.12 "$APP_DIR/venv"
  uv pip install --python "$APP_DIR/venv/bin/python" --require-hashes -r "$REQUIREMENTS_SRC"
  install -m 0755 "$WORKER_SRC" "$APP_DIR/gbp_worker.py"
  install -m 0644 "$PLIST_SRC" "$PLIST_DEST"

  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST_DEST"
  printf '%s\n' "GBP worker installed; RunAtLoad is disabled and no manual publish was started"
}

mode="${1:---install}"
case "$mode" in
  --install) install_worker ;;
  --rollback) rollback ;;
  --check-session) run_installed --check-session ;;
  --dry-run) run_installed --dry-run ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
