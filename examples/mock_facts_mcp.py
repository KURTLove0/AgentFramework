"""Read-only synthetic MCP server for the Agent configuration demo.

Run with an absolute path because CLI planners use a temporary working directory.
Optional --log records only protocol method/tool names, never request arguments.
"""
import argparse
import json
from pathlib import Path
import sys
import time


MARKER = 'SYNTHETIC-FACTS-V1'
TOOLS = [
    {'name': 'lookup', 'description': 'Read a fixed synthetic verification marker. No business or filesystem access.',
     'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
     'annotations': {'readOnlyHint': True, 'destructiveHint': False, 'openWorldHint': False}},
    {'name': 'unlisted', 'description': 'Synthetic tool used to verify native tool allowlisting; do not enable it.',
     'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
     'annotations': {'readOnlyHint': True, 'destructiveHint': False, 'openWorldHint': False}},
]


def serve(log=None):
    for line in sys.stdin:
        request = json.loads(line)
        method = request.get('method')
        if 'id' not in request:
            continue
        params = request.get('params', {})
        if method == 'initialize':
            result = {'protocolVersion': params.get('protocolVersion', '2024-11-05'),
                      'capabilities': {'tools': {'listChanged': False}},
                      'serverInfo': {'name': 'agent-framework-synthetic-facts', 'version': '1.0.0'}}
        elif method == 'ping':
            result = {}
        elif method == 'tools/list':
            result = {'tools': TOOLS}
        elif method == 'tools/call':
            name = params.get('name')
            if log:
                log.parent.mkdir(parents=True, exist_ok=True)
                with log.open('a') as output:
                    output.write(json.dumps({'time': time.time(), 'tool': name}) + '\n')
            if name == 'lookup' and not params.get('arguments'):
                result = {'content': [{'type': 'text', 'text': json.dumps({'marker': MARKER, 'scope': 'synthetic-only'})}], 'isError': False}
            else:
                result = {'content': [{'type': 'text', 'text': 'Tool is not part of the lookup demo.'}], 'isError': True}
        else:
            print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32601, 'message': 'Method not found'}}), flush=True)
            continue
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--log', type=Path)
    serve(parser.parse_args().log)
