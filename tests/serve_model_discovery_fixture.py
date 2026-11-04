"""Real discovery pipeline with disposable local CLI stand-ins, never real models."""
from copy import deepcopy
import json
import os
import subprocess
import sys
import tempfile
import threading
from unittest.mock import patch

from agent_framework.llm import qoder_command
from agent_framework.runtime_config import RuntimeConfiguration
from agent_framework.web import Application,WebServer
from tests.test_runtime_settings_recovery import SETTINGS


RPC='''import json,sys,time
for line in sys.stdin:
 request=json.loads(line)
 if 'id' not in request:continue
 result={} if request['method']=='initialize' else {'data':[{'id':'model-one','displayName':'模型一','supportedReasoningEfforts':[{'reasoningEffort':'medium'}]},{'id':'model-two','displayName':'模型二','supportedReasoningEfforts':[{'reasoningEffort':'high'}]}],'nextCursor':None}
 print(json.dumps({'id':request['id'],'result':result}),flush=True)
'''
SLOW="import json,time\nwhile True:\n print(json.dumps({'method':'status','params':{}}),flush=True);time.sleep(.005)"


if __name__=='__main__':
    defaults=deepcopy(SETTINGS)
    for profile in defaults['profiles'].values():profile['model']='model-one'
    original=subprocess.Popen;calls={};lock=threading.Lock();children=[]
    def launch(command,**kwargs):
        if command[:3]==['codex','app-server','--stdio']:provider='codex'
        elif command==['cursor-agent','models']:provider='cursor'
        elif command[0]==qoder_command() and '--list-models' in command:provider='qoder'
        else:return original(command,**kwargs)
        with lock:
            calls[provider]=calls.get(provider,0)+1;count=calls[provider]
        script=SLOW if provider=='codex' and count in (1,3) else RPC if provider=='codex' else "print('model-one - 模型一\\nmodel-two - 模型二')"
        child=original([sys.executable,'-u','-c',script],**kwargs);children.append(child);return child
    with tempfile.TemporaryDirectory(prefix='model-discovery-browser-') as root,patch.object(RuntimeConfiguration,'defaults',lambda _:deepcopy(defaults)),patch('agent_framework.model_discovery.subprocess.Popen',launch),patch('agent_framework.model_discovery.QUERY_TIMEOUT',1.5):
        app=Application(root);server=WebServer(('127.0.0.1',int(os.environ['MODEL_DISCOVERY_PORT'])),app)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:
            server.server_close();app.close()
            from agent_framework.processes import stop_process_group
            for child in children:stop_process_group(child)
