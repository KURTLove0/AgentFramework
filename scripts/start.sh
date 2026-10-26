#!/bin/sh
# Use the same data directory and tenant when restarting or upgrading.
set -eu
RELEASE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
AGENT_VENV_DIR=${AGENT_VENV_DIR:-"$RELEASE_ROOT/.venv"}
if [ ! -x "$AGENT_VENV_DIR/bin/python" ]; then
  echo "请先运行 sh scripts/install.sh（或设置 AGENT_VENV_DIR）。" >&2
  exit 1
fi
exec "$AGENT_VENV_DIR/bin/python" -m agent_framework \
  --data-dir "${AGENT_DATA_DIR:-$RELEASE_ROOT/.agent-data}" \
  --tenant "${AGENT_TENANT:-local}" \
  serve --host 127.0.0.1 --port "${AGENT_PORT:-8787}" \
  --principal "${AGENT_PRINCIPAL:-local-user}"
