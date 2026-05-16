#!/bin/sh
echo "[Agent] Starting..."

# Resolve script dir so this works on both Replit (/home/runner/workspace) and Render (/opt/render/project/src)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/multi_agent_system"

PORT=${PORT:-5000}

# Kill any process already holding the port (try multiple methods)
fuser -k ${PORT}/tcp 2>/dev/null || true
pkill -9 -f gunicorn 2>/dev/null || true
pkill -9 -f "python.*app.py" 2>/dev/null || true
sleep 1

# Use Replit's local gunicorn if present, otherwise use gunicorn on $PATH (Render/Heroku)
if [ -x "$SCRIPT_DIR/.pythonlibs/bin/gunicorn" ]; then
  GUNICORN="$SCRIPT_DIR/.pythonlibs/bin/gunicorn"
else
  GUNICORN="gunicorn"
fi

exec $GUNICORN \
  --bind 0.0.0.0:${PORT} \
  --workers 1 \
  --threads 8 \
  --timeout 600 \
  --graceful-timeout 30 \
  --keep-alive 65 \
  --worker-class gthread \
  app:app
