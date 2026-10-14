#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Fins Trade — one-shot setup for macOS (Mac Studio / Apple Silicon)
#
#  Native install (no Docker VM → lower idle power):
#    Homebrew → Node 22, PostgreSQL 16, Redis → .env → DB schema
#    → launchd agent (auto start, auto restart) → no-sleep power settings
#    → log rotation.
#
#  Safe to re-run: every step is idempotent.
#    ./scripts/mac-setup.sh                 interactive
#    ./scripts/mac-setup.sh --yes           accept defaults, ask nothing
#    ./scripts/mac-setup.sh --no-power      skip pmset (sleep) changes
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.finstrade.bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$ROOT/logs"
ENV_FILE="$ROOT/.env"
NODE_FORMULA="node@22"
PG_FORMULA="postgresql@16"
ASSUME_YES=0
DO_POWER=1

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --no-power) DO_POWER=0 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
ok()   { printf '   ✓ %s\n' "$*"; }
warn() { printf '   ! %s\n' "$*"; }
die()  { printf '\n✗ %s\n' "$*" >&2; exit 1; }

ask() { # ask "Question" default → echoes answer
  local q="$1" def="${2:-}" ans
  if [ "$ASSUME_YES" = 1 ]; then echo "$def"; return; fi
  read -r -p "   $q " ans </dev/tty || true
  echo "${ans:-$def}"
}

env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | sed -E "s/^$1=//; s/[[:space:]]+#.*$//; s/^\"//; s/\"$//" || true; }
env_set() { # env_set KEY VALUE (BSD sed compatible)
  local key="$1" val="$2" esc
  esc=$(printf '%s' "$val" | sed -e 's/[\/&|]/\\&/g')
  if grep -qE "^$key=" "$ENV_FILE"; then
    sed -i '' -E "s|^$key=.*|$key=\"$esc\"|" "$ENV_FILE"
  else
    printf '%s="%s"\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

# ── 0. Sanity ────────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || die "Script ini khusus macOS."
[ "$(uname -m)" = "arm64" ] || warn "Bukan Apple Silicon — tetap jalan, tapi belum diuji."
bold "Fins Trade setup → $ROOT"

# ── 1. Homebrew ──────────────────────────────────────────────────────────────
step "1/8 Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  else
    warn "Homebrew belum ada — menginstall (akan minta password Mac kamu)…"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
fi
ok "brew $(brew --version | head -1 | awk '{print $2}')"

# ── 2. Node, PostgreSQL, Redis ───────────────────────────────────────────────
step "2/8 Node.js, PostgreSQL, Redis"
for f in "$NODE_FORMULA" "$PG_FORMULA" redis; do
  if brew list --versions "$f" >/dev/null 2>&1; then ok "$f sudah terinstall"; else brew install "$f"; fi
done
NODE_BIN="$(brew --prefix "$NODE_FORMULA")/bin"
PG_BIN="$(brew --prefix "$PG_FORMULA")/bin"
export PATH="$NODE_BIN:$PG_BIN:$PATH"
ok "node $(node -v), npm $(npm -v)"

# brew services = launchd agents → start at login, restart on crash
brew services start "$PG_FORMULA" >/dev/null 2>&1 || brew services restart "$PG_FORMULA"
brew services start redis >/dev/null 2>&1 || brew services restart redis
printf '   menunggu PostgreSQL'
for _ in $(seq 1 30); do pg_isready -q -h 127.0.0.1 && break; printf '.'; sleep 1; done; echo
pg_isready -q -h 127.0.0.1 || die "PostgreSQL tidak bisa start — cek: brew services list"
createdb -h 127.0.0.1 whalebot 2>/dev/null && ok "database whalebot dibuat" || ok "database whalebot sudah ada"
redis-cli ping >/dev/null 2>&1 && ok "redis jalan" || die "Redis tidak merespon — cek: brew services list"

# ── 3. .env ──────────────────────────────────────────────────────────────────
step "3/8 Konfigurasi .env"
if [ ! -f "$ENV_FILE" ]; then cp "$ROOT/.env.example" "$ENV_FILE"; ok ".env dibuat dari .env.example"; fi
chmod 600 "$ENV_FILE"
env_set NODE_ENV production
env_set DATABASE_URL "postgresql://$USER@127.0.0.1:5432/whalebot?schema=public"
env_set REDIS_URL "redis://127.0.0.1:6379"
[ -n "$(env_get PAPER_TRADING)" ] || env_set PAPER_TRADING true

if [ -z "$(env_get TELEGRAM_BOT_TOKEN)" ]; then
  tok=$(ask "Telegram bot token (Enter = lewati, bisa diisi nanti di cockpit):" "")
  if [ -n "$tok" ]; then
    env_set TELEGRAM_BOT_TOKEN "$tok"
    chat=$(ask "Telegram chat ID:" "")
    [ -n "$chat" ] && env_set TELEGRAM_CHAT_ID "$chat" && env_set TELEGRAM_ADMIN_IDS "$(ask "Telegram admin user ID [$chat]:" "$chat")"
  fi
fi
if [ -z "$(env_get HELIUS_API_KEY)" ]; then
  hk=$(ask "Helius API key gratis (Enter = pakai RPC publik):" "")
  [ -n "$hk" ] && env_set HELIUS_API_KEY "$hk"
fi

PORT="$(env_get PORT)"; PORT="${PORT:-3000}"
if [ -z "$(env_get COCKPIT_PASSWORD)" ]; then
  lan=$(ask "Buka cockpit dari PC/HP lain di jaringan rumah? [y/N]:" "n")
  case "$lan" in
    y|Y|yes)
      env_set HOST 0.0.0.0
      env_set COCKPIT_PASSWORD "$(openssl rand -hex 12)"
      ok "akses LAN aktif (password disimpan di .env)" ;;
    *) env_set HOST 127.0.0.1; ok "cockpit hanya bisa dibuka dari Mac ini" ;;
  esac
fi

# ── 4. Dependencies & schema ─────────────────────────────────────────────────
step "4/8 npm install & database schema"
cd "$ROOT"
npm ci --no-audit --no-fund
npx prisma db push --skip-generate >/dev/null && npx prisma generate >/dev/null
ok "schema siap"

# ── 5. launchd agent ─────────────────────────────────────────────────────────
step "5/8 Service 24/7 (launchd)"
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN/node</string>
    <string>$ROOT/node_modules/tsx/dist/cli.mjs</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_BIN:$PG_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LOG_FILE</key><string>$LOG_DIR/fins.log</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>$LOG_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/launchd.err.log</string>
</dict>
</plist>
PLIST_EOF
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
printf '   menunggu cockpit'
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; printf '.'; sleep 1; done; echo
if curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok "bot jalan (auto-start saat login, auto-restart kalau crash)"
else warn "bot belum merespon — lihat: tail -50 $LOG_DIR/fins.log $LOG_DIR/launchd.err.log"; fi

# ── 6. Power: never sleep, restart after power loss ──────────────────────────
step "6/8 Power settings (butuh password admin)"
if [ "$DO_POWER" = 1 ]; then
  p=$(ask "Set Mac agar tidak pernah sleep & nyala sendiri setelah listrik padam? [Y/n]:" "y")
  case "$p" in
    n|N|no) warn "dilewati — Mac yang sleep = bot berhenti" ;;
    *)
      # Display may sleep (saves power); the system itself must not.
      sudo pmset -a sleep 0 disksleep 0 displaysleep 10 autorestart 1 womp 1 powernap 0
      ok "sleep off · display off setelah 10m · auto-restart setelah listrik padam" ;;
  esac
else
  warn "dilewati (--no-power)"
fi

# ── 7. Log rotation ──────────────────────────────────────────────────────────
step "7/8 Rotasi log (newsyslog)"
ROT_CONF="/etc/newsyslog.d/fins-trade.conf"
ROT_LINE="$LOG_DIR/fins.log  $USER:staff  644  7  10240  *  J  $LOG_DIR/fins.pid  1"
if [ "$(cat "$ROT_CONF" 2>/dev/null)" != "$ROT_LINE" ]; then
  r=$(ask "Pasang rotasi log (10MB × 7 file, butuh password admin)? [Y/n]:" "y")
  case "$r" in
    n|N|no) warn "dilewati — log akan terus membesar" ;;
    *) echo "$ROT_LINE" | sudo tee "$ROT_CONF" >/dev/null; ok "log dirotasi otomatis" ;;
  esac
else
  ok "sudah terpasang"
fi

# ── 8. Summary ───────────────────────────────────────────────────────────────
step "8/8 Selesai"
WALLET=$(npm run -s wallet 2>/dev/null | sed -n 's/^Trading wallet: //p' || true)
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
echo
bold "  Cockpit     : http://127.0.0.1:$PORT"
if [ "$(env_get HOST)" = "0.0.0.0" ] && [ -n "$LAN_IP" ]; then
  bold "  Dari PC lain: http://$LAN_IP:$PORT   (user: bebas, password: $(env_get COCKPIT_PASSWORD))"
fi
bold "  Wallet bot  : ${WALLET:-jalankan: npm run wallet}"
echo "  Mode        : $( [ "$(env_get PAPER_TRADING)" = "false" ] && echo LIVE || echo PAPER ) — ubah di cockpit → Settings"
echo "  Kontrol     : ./scripts/fins.sh status | logs | restart | stop | backup | update"
echo
warn "WAJIB backup: $ROOT/.secrets/master.key (tanpa ini wallet bot tidak bisa dibuka)."
warn "Agar bot jalan lagi setelah Mac restart tanpa kamu login: System Settings → Users & Groups → Automatically log in as $USER"
warn "  (opsi ini tidak tersedia kalau FileVault aktif — lihat setup.md bagian Mac Studio)."
