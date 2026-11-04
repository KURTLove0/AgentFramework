"""Temporary supported-value contract fixture; never invokes a model CLI."""
from copy import deepcopy
import os
import tempfile
from unittest.mock import patch

from agent_framework.model_catalog import ModelCatalog
from agent_framework.runtime_config import RuntimeConfiguration
from agent_framework.web import Application, WebServer
from tests.test_runtime_settings_recovery import SETTINGS

if __name__ == '__main__':
    defaults=deepcopy(SETTINGS)
    defaults['default_runtime']='codex'
    for profile in defaults['profiles'].values():profile['model']='model-one'
    defaults['profiles']['codex'].update(reasoning_effort='ultra',timeout=.5)
    defaults['profiles']['cursor']['timeout']=1.5
    defaults['profiles']['qoder']['timeout']=.125
    catalog={'models':[{'id':'model-one','name':'验收模型','efforts':['low','medium','high','ultra'],'default_effort':'medium'}],'source':'isolated supported-value fixture','cached':False}
    with tempfile.TemporaryDirectory(prefix='runtime-values-') as root,patch.object(RuntimeConfiguration,'defaults',lambda _:deepcopy(defaults)),patch.object(ModelCatalog,'list',return_value=catalog):
        app=Application(root);server=WebServer(('127.0.0.1',int(os.environ['RUNTIME_VALUES_PORT'])),app)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
