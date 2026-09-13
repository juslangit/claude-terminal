#!/usr/bin/env bash
# claude-terminal installer.
#
# Checks what is needed, starts the server at login, and — if Tailscale is
# present — puts it on your tailnet so your phone can reach it.
#
# Safe to run again: everything here is idempotent.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${CT_PORT:-4478}"
OS="$(uname -s)"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

say "claude-terminal"
echo

# --- what it needs ----------------------------------------------------------

command -v node >/dev/null 2>&1 || die "Node is not installed. Get it from https://nodejs.org (22 or newer)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node $NODE_MAJOR is too old — this needs 22 or newer."
ok "node $(node -v)"

if ! command -v tmux >/dev/null 2>&1; then
  warn "tmux is not installed, and this needs it."
  if command -v brew >/dev/null 2>&1; then
    read -r -p "  Install it with Homebrew now? [y/N] " reply
    [[ "$reply" =~ ^[Yy]$ ]] && brew install tmux || die "tmux is required."
  elif command -v apt-get >/dev/null 2>&1; then
    read -r -p "  Install it with apt now? [y/N] " reply
    [[ "$reply" =~ ^[Yy]$ ]] && sudo apt-get update && sudo apt-get install -y tmux || die "tmux is required."
  else
    die "Install tmux with your package manager, then run this again."
  fi
fi
ok "tmux $(tmux -V | awk '{print $2}')"

# A launchd or systemd job gets a bare PATH that does not include Homebrew, so
# the server would not find tmux even though it is installed right here. Carry
# this shell's PATH across, plus the directories the two binaries actually live
# in, so the service sees what you see.
SERVICE_PATH="$(dirname "$(command -v node)"):$(dirname "$(command -v tmux)"):$PATH"

mkdir -p "$ROOT/data"
chmod 700 "$ROOT/data"
ok "data directory ready"

# --- start it at login ------------------------------------------------------

case "$OS" in
Darwin)
  PLIST="$HOME/Library/LaunchAgents/com.claude-terminal.server.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claude-terminal.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$ROOT/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CT_PORT</key><string>$PORT</string>
    <key>PATH</key><string>$SERVICE_PATH</string>
  </dict>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/data/server.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/server.log</string>
</dict>
</plist>
PLIST_EOF
  launchctl bootout "gui/$(id -u)/com.claude-terminal.server" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  ok "starts at login (launchctl: com.claude-terminal.server)"
  ;;
Linux)
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    UNIT="$HOME/.config/systemd/user/claude-terminal.service"
    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=claude-terminal

[Service]
ExecStart=$(command -v node) $ROOT/server.mjs
WorkingDirectory=$ROOT
Environment=CT_PORT=$PORT
Environment=PATH=$SERVICE_PATH
Restart=always

[Install]
WantedBy=default.target
UNIT_EOF
    systemctl --user daemon-reload
    systemctl --user enable --now claude-terminal.service
    ok "starts at login (systemd: claude-terminal.service)"
  else
    warn "no systemd user session — start it yourself with: node $ROOT/server.mjs"
    warn "on WSL, add that to your shell profile."
  fi
  ;;
*)
  warn "unknown system '$OS' — start it yourself with: node $ROOT/server.mjs"
  ;;
esac

# wait for it to come up before reporting
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then break; fi
  sleep 0.25
done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null \
  && ok "server answering on http://127.0.0.1:$PORT" \
  || warn "server not answering yet — check $ROOT/data/server.log"

# --- reaching it from a phone ----------------------------------------------

echo
if command -v tailscale >/dev/null 2>&1; then
  if tailscale status >/dev/null 2>&1; then
    say "Putting it on your tailnet"
    if tailscale serve --bg "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
      URL="$(tailscale status --json 2>/dev/null | node -e '
        let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          try{const j=JSON.parse(s);const n=j.Self?.DNSName?.replace(/\.$/,"");
            if(n)console.log("https://"+n);}catch{}})' || true)"
      ok "served to your tailnet"
      [ -n "${URL:-}" ] && ok "open this on your phone: $URL"
    else
      warn "could not run 'tailscale serve' — run it yourself:"
      warn "  tailscale serve --bg http://127.0.0.1:$PORT"
    fi
  else
    warn "Tailscale is installed but this script could not talk to it."
    warn "Either it is not signed in (run 'tailscale up'), or it runs in userspace mode"
    warn "with its own socket, in which case serve it yourself:"
    warn "  tailscale serve --bg http://127.0.0.1:$PORT"
  fi
else
  warn "Tailscale is not installed — without it, this is only reachable on this computer."
  warn "Get it from https://tailscale.com/download, sign in on this computer and on your phone,"
  warn "then run this script again."
fi

echo
say "Done."
echo "  On your phone, open the URL above, then Share → Add to Home Screen."
echo "  Everything runs on this computer. Nothing is sent anywhere else."
