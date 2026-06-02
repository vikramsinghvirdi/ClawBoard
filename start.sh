#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# ClawBoard — Startup Script
# ═══════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.clawboard.pid"
LOG_FILE="$SCRIPT_DIR/clawboard.log"
PORT="${PORT:-52837}"

# Check if already running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if [[ "$OLD_PID" =~ ^[0-9]+$ ]] && [ "$OLD_PID" -gt 1 ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "🌌 ClawBoard is already running (PID: $OLD_PID)"
    echo "   http://127.0.0.1:$PORT"
    echo ""
    echo "   To stop: kill $OLD_PID"
    exit 0
  else
    rm -f "$PID_FILE"
  fi
fi

echo ""
echo "  🦀 Starting ClawBoard..."
echo "  ─────────────────────────"

# Start server in background
cd "$SCRIPT_DIR"
nohup node server.js > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

sleep 1

NEW_PID=$(cat "$PID_FILE")
if [[ "$NEW_PID" =~ ^[0-9]+$ ]] && [ "$NEW_PID" -gt 1 ] && kill -0 "$NEW_PID" 2>/dev/null; then
  echo "  ✅ ClawBoard running at http://127.0.0.1:$PORT"
  echo "  📋 Syncing with ~/.openclaw/workspace/KANBAN.md"
  echo "  📝 Log: $LOG_FILE"
  echo "  🛑 Stop: kill $NEW_PID"
  echo ""

  # Try to open in browser
  if command -v open &>/dev/null; then
    open "http://127.0.0.1:$PORT"
  fi
else
  echo "  ❌ Failed to start. Check $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
