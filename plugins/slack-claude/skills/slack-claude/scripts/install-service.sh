#!/usr/bin/env bash
# Install slack-claude as an always-on background service for the current user.
#   bash install-service.sh            install or update, then (re)start
#   bash install-service.sh status     show whether it is running
#   bash install-service.sh restart
#   bash install-service.sh uninstall
#
# macOS: a launchd LaunchAgent (KeepAlive, starts at login).
# Linux: a systemd --user unit (Restart=always). Run `loginctl enable-linger $USER`
#        once if the bot should keep running after you log out.
#
# The bot file is COPIED to $SLACK_CLAUDE_HOME/bot.mjs so the service does not point
# into a plugin cache directory that changes on every plugin update. Re-run this
# script after updating the plugin to pick up a new bot.mjs.
set -euo pipefail

HOME_DIR="${SLACK_CLAUDE_HOME:-$HOME/.slack-claude}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../bot.mjs"
BOT="$HOME_DIR/bot.mjs"
LABEL="com.slack-claude.bot"
ACTION="${1:-install}"

NODE_BIN="$(command -v node || true)"
CLAUDE_BIN="$(command -v claude || true)"
if [[ "$ACTION" == "install" ]]; then
  [[ -n "$NODE_BIN" ]] || { echo "node not found on PATH (need Node 22+)"; exit 1; }
  [[ -n "$CLAUDE_BIN" ]] || { echo "claude not found on PATH (install Claude Code, run \`claude\` once to log in)"; exit 1; }
  [[ -f "$HOME_DIR/config.json" ]] || { echo "no $HOME_DIR/config.json yet; create it first (see SKILL.md)"; exit 1; }
fi
# Services start with an almost empty PATH; carry the directories node and claude live in.
SERVICE_PATH="$(dirname "${NODE_BIN:-/usr/local/bin/node}"):$(dirname "${CLAUDE_BIN:-$HOME/.local/bin/claude}"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$HOME_DIR"

if [[ "$(uname)" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  DOMAIN="gui/$(id -u)"
  case "$ACTION" in
    install)
      cp "$SRC" "$BOT"
      mkdir -p "$HOME/Library/LaunchAgents"
      cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string>
    <string>$BOT</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$SERVICE_PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>SLACK_CLAUDE_HOME</key><string>$HOME_DIR</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$HOME_DIR/service.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/service.log</string>
</dict></plist>
EOF
      launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
      launchctl bootstrap "$DOMAIN" "$PLIST"
      launchctl kickstart -k "$DOMAIN/$LABEL"
      echo "installed $LABEL (launchd). Logs: $HOME_DIR/bot.log and $HOME_DIR/service.log"
      ;;
    status)
      launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state|pid" | head -3 || echo "not loaded"
      tail -n 5 "$HOME_DIR/bot.log" 2>/dev/null || true
      ;;
    restart) launchctl kickstart -k "$DOMAIN/$LABEL" && echo "restarted" ;;
    uninstall)
      launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
      rm -f "$PLIST"
      echo "removed $LABEL. Config and logs left in $HOME_DIR."
      ;;
    *) echo "usage: install-service.sh [install|status|restart|uninstall]"; exit 2 ;;
  esac
else
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT="$UNIT_DIR/slack-claude.service"
  case "$ACTION" in
    install)
      cp "$SRC" "$BOT"
      mkdir -p "$UNIT_DIR"
      cat > "$UNIT" <<EOF
[Unit]
Description=slack-claude: Slack bot that runs messages through Claude Code
After=network-online.target

[Service]
ExecStart=$NODE_BIN $BOT
WorkingDirectory=$HOME
Environment=PATH=$SERVICE_PATH
Environment=HOME=$HOME
Environment=SLACK_CLAUDE_HOME=$HOME_DIR
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable --now slack-claude.service
      systemctl --user restart slack-claude.service
      echo "installed slack-claude.service (systemd --user). Logs: $HOME_DIR/bot.log, journalctl --user -u slack-claude"
      echo "to keep it running after logout: loginctl enable-linger $USER"
      ;;
    status) systemctl --user status slack-claude.service --no-pager | head -5; tail -n 5 "$HOME_DIR/bot.log" 2>/dev/null || true ;;
    restart) systemctl --user restart slack-claude.service && echo "restarted" ;;
    uninstall)
      systemctl --user disable --now slack-claude.service 2>/dev/null || true
      rm -f "$UNIT"; systemctl --user daemon-reload
      echo "removed slack-claude.service. Config and logs left in $HOME_DIR."
      ;;
    *) echo "usage: install-service.sh [install|status|restart|uninstall]"; exit 2 ;;
  esac
fi
