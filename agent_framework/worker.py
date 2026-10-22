"""JSON-only subprocess adapter; no shell command supplied by a planner is executed."""

import argparse
import json
import sys

from .contracts import ToolFailure
from .mock_tools import MockSystem


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tool')
    parser.add_argument('--mcp', action='store_true')
    options = parser.parse_args()
    request_id = None
    try:
        request = json.load(sys.stdin)
        if options.mcp:
            if request.get('method') != 'tools/call' or request.get('jsonrpc') != '2.0':
                raise ValueError('unsupported MCP request')
            request_id = request['id']
            params = request['params']
            request = params['arguments']
            if params['name'] != request['tool_ref']:
                raise ValueError('MCP tool binding mismatch')
        if options.tool and options.tool != request['tool_ref']:
            raise ValueError('CLI tool binding mismatch')
        result = MockSystem(request["external_db"]).invoke(request["tool_ref"], request["args"], request["trusted"])
        response = {"ok": True, "result": result}
    except ToolFailure as exc:
        response = {"ok": False, "category": exc.category, "message": str(exc)}
    except Exception as exc:
        response = {"ok": False, "category": "invalid", "message": f"{type(exc).__name__}: {exc}"}
    if options.mcp:
        response = {'jsonrpc': '2.0', 'id': request_id, 'result': response}
    print(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    main()
