#!/bin/bash
# Fins Trade — service control for the macOS launchd install (see scripts/mac-setup.sh)
#   ./scripts/fins.sh status|start|stop|restart|logs|errors|backup|update|wallet|report|uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.finstrade.bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOG_DIR="$ROOT/logs"
PORT="$(grep -E '^PORT=' "$ROOT/.env" 2>/dev/null | sed -E 's/^PORT=//; s/"//g' || true)"; PORT="${PORT:-3000}"

[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
export PATH="$(brew --prefix node@22 2>/dev/null)/bin:$(brew --prefix postgresql@16 2>/dev/null)/bin:$PATH"

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

case "${1:-status}" in
  status)
    if loaded; then
      launchctl print "$DOMAIN/$LABEL" | grep -E '^[[:space:]]*(state|pid|last exit code|runs) =' | sed -E 's/^[[:space:]]*/  /'
    else
      echo "  service: tidak terpasang / berhenti"
    fi
    brew services list | grep -E 'postgresql|redis' | sed 's/^/  /'
    if curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      echo "  cockpit: OK → http://127.0.0.1:$PORT"
    else
      echo "  cockpit: tidak merespon"
    fi
    ;;
  start)   loaded || launchctl bootstrap "$DOMAIN" "$PLIST"; launchctl kickstart "$DOMAIN/$LABEL"; echo "started" ;;
  stop)    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; echo "stopped (posisi terbuka TIDAK dijaga selama bot mati)" ;;
  restart) if loaded; then launchctl kickstart -k "$DOMAIN/$LABEL"; else launchctl bootstrap "$DOMAIN" "$PLIST"; fi; echo "restarted" ;;
  logs)    tail -n 100 -f "$LOG_DIR/fins.log" ;;
  errors)  grep -E 'ERROR|FATAL|WARN' "$LOG_DIR/fins.log" | tail -n 50; tail -n 30 "$LOG_DIR/launchd.err.log" 2>/dev/null || true ;;
  backup)
    DEST="$HOME/fins-trade-backups/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$DEST"
    pg_dump -h 127.0.0.1 whalebot | gzip > "$DEST/whalebot.sql.gz"
    cp -R "$ROOT/.secrets" "$DEST/secrets"
    cp "$ROOT/.env" "$DEST/env"
    chmod -R go-rwx "$DEST"
    echo "backup → $DEST  (berisi master key wallet: simpan dengan aman, jangan diupload sembarangan)"
    ;;
  update)
    cd "$ROOT"
    git pull --ff-only
    npm ci --no-audit --no-fund
    npx prisma db push --skip-generate && npx prisma generate
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "updated & restarted"
    ;;
  wallet)  cd "$ROOT" && npm run -s wallet -- "${@:2}" ;;
  report)  cd "$ROOT" && npm run -s readiness ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "service dihapus. Data (DB, .secrets, .env) tidak disentuh."
    ;;
  *) sed -n '2,3p' "$0"; exit 1 ;;
esac
