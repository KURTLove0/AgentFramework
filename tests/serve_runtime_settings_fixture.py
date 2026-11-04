"""Temporary runtime settings and synthetic model directory; no CLI execution."""
from copy import deepcopy
import os
import tempfile
from unittest.mock import patch

from agent_framework.model_catalog import ModelCatalog
from agent_framework.runtime_config import RuntimeConfiguration
from agent_framework.web import Application,WebServer
from tests.test_runtime_settings_recovery import SETTINGS


if __name__=='__main__':
    defaults=deepcopy(SETTINGS)
    for profile in defaults['profiles'].values():profile['model']='model-one'
    catalog={'models':[{'id':'model-one','name':'模型一','efforts':['low','medium','high'],'default_effort':'medium'},{'id':'model-two','name':'模型二','efforts':['low','high'],'default_effort':'low'}],'source':'isolated settings fixture','cached':False}
    with tempfile.TemporaryDirectory(prefix='runtime-settings-') as root,patch.object(RuntimeConfiguration,'defaults',lambda _:deepcopy(defaults)),patch.object(ModelCatalog,'list',return_value=catalog):
        app=Application(root);server=WebServer(('127.0.0.1',int(os.environ['RUNTIME_SETTINGS_PORT'])),app)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
