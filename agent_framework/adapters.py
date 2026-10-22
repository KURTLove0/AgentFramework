"""Trusted argv builders for simulated business adapters; never shell=True.

The three protocols share the same simulated business system and semantics. No
user supplied command, URL, credential or model-generated shell is executed.
"""
import json
from pathlib import Path
import subprocess
import sys

from .contracts import ToolFailure, canonical


def invoke(adapter_ref, payload, timeout, write):
    command = [sys.executable, '-m', 'agent_framework.worker']
    if adapter_ref == 'mock-worker@1.0.0':
        request = payload
    elif adapter_ref == 'mock-cli@1.0.0':
        command += ['--tool', payload['tool_ref']]
        request = payload
    elif adapter_ref == 'mock-mcp@1.0.0':
        command += ['--mcp']
        request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                   'params': {'name': payload['tool_ref'], 'arguments': payload}}
    else:
        raise ToolFailure('denied', 'unregistered adapter')
    try:
        response = subprocess.run(command, input=canonical(request), text=True, capture_output=True,
                                  timeout=timeout, check=True, cwd=Path(__file__).resolve().parent.parent)
        data = json.loads(response.stdout)
        if adapter_ref == 'mock-mcp@1.0.0':
            if data.get('id') != 1 or data.get('jsonrpc') != '2.0':
                raise ValueError('invalid MCP envelope')
            data = data['result']
        if not isinstance(data, dict) or type(data.get('ok')) is not bool:
            raise ValueError('malformed worker response')
    except (subprocess.SubprocessError, json.JSONDecodeError, ValueError, KeyError) as exc:
        raise ToolFailure('unknown' if write else 'transient', f'worker response unavailable: {type(exc).__name__}') from exc
    if not data['ok']:
        category = data.get('category', 'unknown' if write else 'transient')
        if category not in {'unknown', 'transient', 'invalid', 'denied', 'precondition', 'conflict', 'not_found'}:
            category = 'unknown' if write else 'transient'
        raise ToolFailure(category, data.get('message', 'tool failed'))
    if 'result' not in data:
        raise ToolFailure('unknown' if write else 'invalid', 'worker result missing')
    return data['result']
