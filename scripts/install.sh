#!/bin/sh
set -eu
RELEASE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
AGENT_VENV_DIR=${AGENT_VENV_DIR:-"$RELEASE_ROOT/.venv"}
"${PYTHON:-python3}" -c 'import sys; assert sys.version_info >= (3, 11), "需要 Python 3.11+"'
"${PYTHON:-python3}" -m venv "$AGENT_VENV_DIR"
# Both dependencies are listed in the bundle; the wheel never includes runtime data.
cd "$RELEASE_ROOT"
"$AGENT_VENV_DIR/bin/python" -m pip install -r "$RELEASE_ROOT/requirements.txt"
echo "安装完成。启动：sh scripts/start.sh"
