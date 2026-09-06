#!/usr/bin/env bash
# Event Console: resolve the installation relative to this script.
# Browser policies and existing browser profiles are never modified.
set -euo pipefail

CONSOLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONSOLE_PORT="${EVENT_CONSOLE_PORT:-4173}"
case "$CONSOLE_PORT" in
  ''|*[!0-9]*) echo 'EVENT_CONSOLE_PORT must be a number.' >&2; exit 1 ;;
esac
if [ "$CONSOLE_PORT" -lt 1024 ] || [ "$CONSOLE_PORT" -gt 65535 ]; then
  echo 'EVENT_CONSOLE_PORT must be between 1024 and 65535.' >&2
  exit 1
fi

for program in node npm curl; do
  command -v "$program" >/dev/null || { echo "Required command: $program" >&2; exit 1; }
done
cd "$CONSOLE_DIR"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error("Node.js 22.12+ required"); process.exit(1); }'

CONSOLE_URL="http://127.0.0.1:$CONSOLE_PORT"
if curl --fail --silent --max-time 2 "$CONSOLE_URL/" >/dev/null; then
  echo "Another application is using port $CONSOLE_PORT. Set EVENT_CONSOLE_PORT to a free port." >&2
  exit 1
else
  [ -d node_modules ] || npm ci
  npm run build
  CONSOLE_LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/event-console"
  mkdir -p "$CONSOLE_LOG_DIR"
  nohup npm start -- --port "$CONSOLE_PORT" >"$CONSOLE_LOG_DIR/server.log" 2>&1 &
  CONSOLE_SERVER_PID=$!
  CONSOLE_READY=0
  for ((attempt = 0; attempt < 80; attempt++)); do
    if curl --fail --silent --max-time 1 "$CONSOLE_URL/" >/dev/null; then CONSOLE_READY=1; break; fi
    kill -0 "$CONSOLE_SERVER_PID" 2>/dev/null || break
    sleep 0.25
  done
  if [ "$CONSOLE_READY" != 1 ]; then
    echo "Server failed to start. See $CONSOLE_LOG_DIR/server.log" >&2
    exit 1
  fi
fi

CONSOLE_CONTROL_URL="$CONSOLE_URL/control.html"
CONSOLE_DISPLAY_URL="$CONSOLE_URL/display.html"
if [ "$(uname -s)" = Darwin ]; then
  CONSOLE_CHROME_APP="${EVENT_CONSOLE_CHROME_APP:-/Applications/Google Chrome.app}"
  CONSOLE_CHROME_BIN="$CONSOLE_CHROME_APP/Contents/MacOS/Google Chrome"
  if [ -x "$CONSOLE_CHROME_BIN" ]; then
    open -a "$CONSOLE_CHROME_APP" "$CONSOLE_CONTROL_URL"
    "$CONSOLE_CHROME_BIN" --new-window "$CONSOLE_DISPLAY_URL" >/dev/null 2>&1 &
  else
    open "$CONSOLE_CONTROL_URL" "$CONSOLE_DISPLAY_URL"
  fi
else
  echo "Open both URLs in the same Chrome or Edge profile:"
  echo "$CONSOLE_CONTROL_URL"
  echo "$CONSOLE_DISPLAY_URL"
fi
echo '출력 창에서 한 번 클릭해 소리를 허용하세요. 두 창은 같은 브라우저 프로필을 사용하세요.'
