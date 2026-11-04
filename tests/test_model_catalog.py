import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from agent_framework.model_catalog import ModelCatalog,ModelDiscoveryError


class ModelCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.catalog=ModelCatalog(self.tmp.name,'tenant-test')

    def test_cursor_cli_output_and_cache_are_authoritative(self):
        output='Available models\nauto - Auto (default)\nmodel-a - Model A\nmodel-b-high - Model B High\nTip: use --model <id>\n'
        with patch('agent_framework.model_catalog.run_directory_command',return_value=subprocess.CompletedProcess([],0,output,'')) as run:
            first=self.catalog.list('cursor');second=self.catalog.list('cursor')
            self.assertEqual(run.call_count,1)
            self.assertEqual(run.call_args.args[0],['cursor-agent','models'])
            self.assertEqual([m['id'] for m in first['models']],['model-a','model-b-high'])
            self.assertTrue(second['cached'])
            self.catalog.require('cursor','model-a')
            with self.assertRaises(ValueError):self.catalog.require('cursor','invented')
            self.catalog.list('cursor',True);self.assertEqual(run.call_count,2)
        other=ModelCatalog(self.tmp.name,'another')
        self.assertIsNone(other.cached('cursor'))

    def test_failed_cli_does_not_create_a_fake_list_or_replace_cache(self):
        with patch.object(ModelCatalog,'_cursor',return_value=[{'id':'real','name':'Real','efforts':[]}]):self.catalog.list('cursor')
        with patch.object(ModelCatalog,'_cursor',side_effect=subprocess.TimeoutExpired('cursor-agent',20)):
            with self.assertRaises(ModelDiscoveryError):self.catalog.list('cursor',True)
        self.assertEqual(self.catalog.cached('cursor')['models'][0]['id'],'real')
        with patch.object(ModelCatalog,'_codex',return_value=[]):
            with self.assertRaises(ModelDiscoveryError):self.catalog.list('codex')

    def test_codex_model_list_handshake_pagination_and_efforts(self):
        rows=[{'id':1,'result':{}},{'id':2,'result':{'data':[{'id':'model-a','model':'model-a','displayName':'A','supportedReasoningEfforts':[{'reasoningEffort':'high'}]}],'nextCursor':'page2'}},
              {'id':3,'result':{'data':[{'id':'model-b','model':'model-b','displayName':'B'}],'nextCursor':None}}]
        trace=Path(self.tmp.name)/'requests.jsonl';original=subprocess.Popen
        script='''import json,sys
rows=iter(%r)
for line in sys.stdin:
 with open(%r,'a') as trace:trace.write(line)
 request=json.loads(line)
 if 'id' in request:print(json.dumps(next(rows)),flush=True)
'''%(rows,str(trace))
        def launch(command,**kwargs):
            self.assertEqual(command[:3],['codex','app-server','--stdio'])
            return original([sys.executable,'-u','-c',script],**kwargs)
        with patch('agent_framework.model_discovery.subprocess.Popen',launch):
            models=self.catalog.list('codex')['models']
        self.assertEqual([m['id'] for m in models],['model-a','model-b'])
        self.assertEqual(models[0]['efforts'],['high'])
        sent=[json.loads(line) for line in trace.read_text().splitlines()]
        self.assertEqual([d['method'] for d in sent],['initialize','initialized','model/list','model/list'])
        self.assertEqual(sent[-1]['params']['cursor'],'page2')
        self.assertFalse(any(d['method'].startswith('thread/') for d in sent))

if __name__=='__main__':unittest.main()
