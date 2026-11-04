"""Real version-probe pipe handling with disposable Python CLI substitutes."""
from copy import deepcopy
import os
import subprocess
import sys
import tempfile
import threading
from unittest.mock import patch

from agent_framework.model_catalog import ModelCatalog
from agent_framework.runtime_config import RuntimeConfiguration
from agent_framework.web import Application,WebServer
from tests.test_runtime_settings_recovery import SETTINGS

if __name__=='__main__':
    defaults=deepcopy(SETTINGS)
    for profile in defaults['profiles'].values():profile['model']='model-one'
    catalog={'models':[{'id':'model-one','name':'模型一','efforts':['low','medium','high'],'default_effort':'medium'}],'source':'isolated detection fixture','cached':False}
    original=subprocess.Popen;lock=threading.Lock();counts={}
    def launch(command,**kwargs):
        assert command[0] in ('codex','cursor-agent','qodercli') and command[1:]==['--version'],command
        with lock:
            counts[command[0]]=counts.get(command[0],0)+1;count=counts[command[0]]
        script='import time;time.sleep(15)' if command[0]=='codex' and count==1 else "import sys;assert sys.stdin.read()=='';print("+repr(command[0]+' Fixture '+str(count))+")"
        return original([sys.executable,'-u','-c',script],**kwargs)
    with tempfile.TemporaryDirectory(prefix='runtime-detection-') as root,patch.object(RuntimeConfiguration,'defaults',lambda _:deepcopy(defaults)),patch.object(ModelCatalog,'list',return_value=catalog),patch('agent_framework.runtime_config.shutil.which',return_value='/isolated/cli'),patch('agent_framework.runtime_detection.subprocess.Popen',launch),patch('agent_framework.runtime_detection.DETECTION_TIMEOUT',.8):
        app=Application(root);server=WebServer(('127.0.0.1',int(os.environ['RUNTIME_DETECTION_PORT'])),app)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
