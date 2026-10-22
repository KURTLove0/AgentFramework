"""Materialize only the MCP endpoints explicitly enabled by a frozen Agent profile."""
from copy import deepcopy
import os


def enabled_servers(profile):
    return [s for s in (profile or {}).get('mcp_servers',[]) if s['enabled']]


def codex_mcp_args(profile):
    import json
    flags=[]
    for server in enabled_servers(profile):
        name=server['name']
        values={'enabled':True,'required':True,'enabled_tools':server['tools'],'startup_timeout_sec':15,'tool_timeout_sec':30}
        if server['transport']=='stdio':values.update(command=server['command'],args=server['args'],env_vars=server['env_vars'])
        else:
            values['url']=server['url']
            if server['bearer_env']:values['bearer_token_env_var']=server['bearer_env']
        for field,value in values.items():
            # JSON scalars/arrays are valid for these TOML value types. Tables use dotted keys.
            flags+=['-c',f'mcp_servers.{name}.{field}='+json.dumps(value,ensure_ascii=False)]
    return flags


def cursor_mcp_config(profile, policy, inherited):
    import sys
    servers={name:{'disabled':True,'command':sys.executable,'args':['-c','pass']} for name in inherited}
    config=deepcopy(policy)
    active=enabled_servers(profile)
    if active:
        config['permissions']['deny']=[x for x in config['permissions']['deny'] if x!='Mcp(*:*)']
        config['permissions']['allow']=[f"Mcp({s['name']}:{tool})" for s in active for tool in s['tools']]
    for server in active:
        value={'disabled':False,'autoApprove':server['tools']}
        if server['transport']=='stdio':
            value.update(command=server['command'],args=server['args'],env={key:os.environ[key] for key in server['env_vars'] if key in os.environ})
        else:
            value['url']=server['url']
            if server['bearer_env']:
                token=os.environ.get(server['bearer_env'])
                if not token:raise ValueError('MCP 令牌环境变量未设置')
                value['headers']={'Authorization':'Bearer '+token}
        servers[server['name']]=value
    return {'mcpServers':servers},config


def allowed_mcp_call(item,profile,cursor=False):
    if cursor:
        tool_call=item.get('tool_call',{})
        if set(tool_call)!={'mcpToolCall'}:return None
        args=tool_call['mcpToolCall'].get('args',{})
        server=args.get('providerIdentifier') or args.get('server')
        tool=args.get('toolName') or args.get('name')
    else:
        if item.get('type')!='mcp_tool_call':return None
        server,tool=item.get('server'),item.get('tool')
    if any(s['name']==server and tool in s['tools'] for s in enabled_servers(profile)):
        return {'server':server,'tool':tool}
    return None
