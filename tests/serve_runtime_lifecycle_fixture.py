"""Permit BFCache only for the synthetic HTML document; APIs stay no-store."""
import runpy
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.web import Handler


if __name__=='__main__':
    original=Handler.send_header
    def header(self,name,value):
        if name.lower()=='cache-control' and urlsplit(self.path).path in ('/','/index.html'):
            value='private, max-age=0'
        return original(self,name,value)
    with patch.object(Handler,'send_header',header):
        runpy.run_module('tests.serve_runtime_settings_fixture',run_name='__main__')
