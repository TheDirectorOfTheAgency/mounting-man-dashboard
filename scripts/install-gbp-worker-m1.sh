#!/bin/bash
set -euo pipefail
umask 077

LABEL="com.themountingman.gbp-worker"
HOME_DIR="${INSTALL_POST_GBP_HOME_DIR:-/Users/thedirector}"
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
LAST_BACKUP=""

usage() {
  printf '%s\n' "Usage: $0 [--install|--rollback|--check-session|--dry-run|--heartbeat]"
}

run_installed() {
  local mode="$1" python_path worker_path
  if [[ ! -f "$PLIST_DEST" ]]; then
    printf '%s\n' "GBP worker is not installed" >&2
    exit 2
  fi
  python_path="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$PLIST_DEST" 2>/dev/null || true)"
  worker_path="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$PLIST_DEST" 2>/dev/null || true)"
  if [[ ! -x "$python_path" || ! -f "$worker_path" ]]; then
    printf '%s\n' "GBP worker is not installed" >&2
    exit 2
  fi
  if [[ "$mode" == "--check-session" ]]; then
    "$python_path" "$worker_path" "$mode" --surface update --headless
    exec "$python_path" "$worker_path" "$mode" --surface photos --headless
  fi
  exec "$python_path" "$worker_path" "$mode" --headless
}

backup_current() {
  LAST_BACKUP=""
  if [[ ! -f "$PLIST_DEST" ]]; then
    return
  fi
  local stamp backup old_worker
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  backup="$STATE_DIR/backups/$stamp"
  LAST_BACKUP="$backup"
  mkdir -p "$backup"
  cp "$PLIST_DEST" "$backup/$LABEL.plist"
  old_worker="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$PLIST_DEST" 2>/dev/null || true)"
  if [[ -n "$old_worker" && -f "$old_worker" ]]; then
    cp "$old_worker" "$backup/gbp_worker.py"
    printf '%s\n' "$old_worker" > "$backup/original-worker-path"
  fi
  chmod -R go-rwx "$backup"
}

restore_backup() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  if [[ -n "$LAST_BACKUP" && -f "$LAST_BACKUP/$LABEL.plist" ]]; then
    if [[ -f "$LAST_BACKUP/original-worker-path" && -f "$LAST_BACKUP/gbp_worker.py" ]]; then
      local old_worker
      IFS= read -r old_worker < "$LAST_BACKUP/original-worker-path"
      mkdir -p "$(dirname "$old_worker")"
      install -m 0755 "$LAST_BACKUP/gbp_worker.py" "$old_worker"
    fi
    install -m 0644 "$LAST_BACKUP/$LABEL.plist" "$PLIST_DEST"
    launchctl bootstrap "$DOMAIN" "$PLIST_DEST" >/dev/null 2>&1 || true
  else
    rm -f "$PLIST_DEST"
  fi
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

  mkdir -p "$APP_DIR" "$STATE_DIR/artifacts" "$STATE_DIR/backups" "$SECRET_DIR" "$(dirname "$PLIST_DEST")"
  chmod 0700 "$APP_DIR" "$STATE_DIR" "$STATE_DIR/artifacts" "$STATE_DIR/backups" "$SECRET_DIR"
  chmod 0600 "$SESSION_FILE"

  local env_path worker_secret build_sha release_dir staging_dir candidate_plist
  build_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  if [[ ! "$build_sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s\n' "GBP worker installation requires a committed 40-hex Git revision" >&2
    exit 2
  fi
  if ! git -C "$REPO_ROOT" diff --quiet HEAD -- m1/gbp-worker scripts/install-gbp-worker-m1.sh; then
    printf '%s\n' "GBP worker source must match the committed revision before installation" >&2
    exit 2
  fi
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

  release_dir="$APP_DIR/releases/$build_sha"
  staging_dir="$APP_DIR/releases/.$build_sha.staging.$$"
  candidate_plist="$STATE_DIR/$LABEL.$$.candidate.plist"
  if [[ ! -f "$release_dir/.ready" ]]; then
    rm -rf "$staging_dir"
    mkdir -p "$staging_dir"
    chmod 0700 "$staging_dir"
    uv venv --python 3.12 "$staging_dir/venv"
    uv pip install --python "$staging_dir/venv/bin/python" --require-hashes -r "$REQUIREMENTS_SRC"
    install -m 0755 "$WORKER_SRC" "$staging_dir/gbp_worker.py"
    : > "$staging_dir/.ready"
    chmod 0600 "$staging_dir/.ready"
    rm -rf "$release_dir"
    mv "$staging_dir" "$release_dir"
  fi
  install -m 0644 "$PLIST_SRC" "$candidate_plist"
  /usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $release_dir/venv/bin/python" "$candidate_plist"
  /usr/libexec/PlistBuddy -c "Set :ProgramArguments:1 $release_dir/gbp_worker.py" "$candidate_plist"
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:HOME $HOME_DIR" "$candidate_plist"
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:INSTALL_POST_GBP_SECRET_FILE $SECRET_FILE" "$candidate_plist"
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:INSTALL_POST_GBP_STORAGE_STATE $SESSION_FILE" "$candidate_plist"
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:INSTALL_POST_GBP_ARTIFACT_DIR $STATE_DIR/artifacts" "$candidate_plist"
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:INSTALL_POST_GBP_BUILD_SHA $build_sha" "$candidate_plist"
  /usr/libexec/PlistBuddy -c "Set :StandardOutPath $STATE_DIR/worker.log" "$candidate_plist"
  /usr/libexec/PlistBuddy -c "Set :StandardErrorPath $STATE_DIR/worker.error.log" "$candidate_plist"
  plutil -lint "$candidate_plist" >/dev/null

  backup_current
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  if ! install -m 0644 "$candidate_plist" "$PLIST_DEST"; then
    restore_backup
    rm -f "$candidate_plist"
    printf '%s\n' "GBP worker activation failed; prior installation restored" >&2
    exit 2
  fi
  if ! launchctl bootstrap "$DOMAIN" "$PLIST_DEST"; then
    restore_backup
    rm -f "$candidate_plist"
    printf '%s\n' "GBP worker launchd bootstrap failed; prior installation restored" >&2
    exit 2
  fi
  rm -f "$candidate_plist"
  printf '%s\n' "GBP worker installed; RunAtLoad is disabled and no manual publish was started"
}

mode="${1:---install}"
case "$mode" in
  --install) install_worker ;;
  --rollback) rollback ;;
  --check-session) run_installed --check-session ;;
  --dry-run) run_installed --dry-run ;;
  --heartbeat) run_installed --heartbeat ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
