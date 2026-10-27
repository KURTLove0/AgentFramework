"""Exercise the real JSON-RPC pipe lifecycle without a model or external tools."""
import json
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from agent_framework.llm import CodexTransport,CodexConfig,ModelError
from agent_framework.model_execution import SCHEMA

SCRIPT=r'''
import sys,json,time
def emit(message):print(json.dumps(message),flush=True)
def notify(method,params):emit({'method':method,'params':{'threadId':'thread-1',**params}})
raw=json.dumps({'kind':'result','summary':'公开摘要','result':{'title':'建议','content':'第一段建议。\n第二段建议。'+'持续展开内容。'*15,'citations':[],'limitations':[]}},ensure_ascii=False)
for line in sys.stdin:
 request=json.loads(line);method=request['method']
 if method=='initialize':emit({'id':request['id'],'result':{}})
 elif method=='thread/start':emit({'id':request['id'],'result':{'thread':{'id':'thread-1'}}})
 elif method=='turn/start':
  emit({'id':request['id'],'result':{'turn':{'id':'turn-1'}}})
  notify('turn/started',{})
  notify('item/reasoning/textDelta',{'itemId':'private','delta':'PRIVATE_CODEX_REASONING'})
  notify('item/reasoning/summaryTextDelta',{'itemId':'summary','summaryIndex':0,'delta':'正在整理'})
  notify('item/reasoning/summaryTextDelta',{'itemId':'summary','summaryIndex':0,'delta':'建议。'})
  notify('item/started',{'item':{'id':'answer','type':'agentMessage','phase':'final_answer','text':''}})
  for n in range(0,len(raw),5):
   notify('item/agentMessage/delta',{'itemId':'answer','delta':raw[n:n+5]});time.sleep(.015)
  notify('item/completed',{'item':{'id':'answer','type':'agentMessage','phase':'final_answer','text':raw}})
  notify('thread/tokenUsage/updated',{'tokenUsage':{'total':{'inputTokens':20,'outputTokens':30}}})
  notify('turn/completed',{'turn':{'status':'completed'}})
'''


class CodexStreamTests(unittest.TestCase):
    def generate(self,script=SCRIPT,cancel=None,timeout=3):
        original=subprocess.Popen;self.process=None;self.command=None
        def launch(command,**kwargs):
            self.command=command;self.process=original([sys.executable,'-u','-c',script],**kwargs);return self.process
        self.updates=[];self.running=[];transport=CodexTransport();transport.stream_output=True;transport.should_cancel=cancel
        transport.progress=lambda data:(self.updates.append(data),self.running.append(self.process.poll()))
        with patch('agent_framework.codex_stream.subprocess.Popen',launch):
            return transport.generate('Synthetic bounded task.',SCHEMA,CodexConfig('fixture-model',timeout=3),timeout)
    def test_rpc_streams_public_summary_and_body_before_completion_and_keeps_boundaries(self):
        text,meta=self.generate();self.assertEqual(json.loads(text)['result']['content'],'第一段建议。\n第二段建议。'+'持续展开内容。'*15)
        self.assertEqual(meta['usage'],{'input_tokens':20,'output_tokens':30});self.assertIn('mcp_servers={}',self.command)
        self.assertIn('features.shell_tool=false',self.command);self.assertIn('features.hooks=false',self.command)
        self.assertGreater(len([u for u in self.updates if u['kind']=='answer_text']),1);self.assertTrue(all(p is None for p in self.running))
        self.assertNotIn('PRIVATE_CODEX',json.dumps(self.updates));self.assertIsNotNone(self.process.poll())
    def test_unexpected_tool_items_and_missing_usage_fail_closed(self):
        bad=SCRIPT.replace("notify('turn/started',{})","notify('item/started',{'item':{'type':'commandExecution'}})")
        with self.assertRaisesRegex(ModelError,'unexpected_model_item_commandExecution'):self.generate(bad)
        no_usage=SCRIPT.replace("notify('thread/tokenUsage/updated',{'tokenUsage':{'total':{'inputTokens':20,'outputTokens':30}}})",'pass')
        with self.assertRaisesRegex(ModelError,'invalid_model_usage'):self.generate(no_usage)
    def test_cancel_or_timeout_closes_both_pipes_and_terminates_child(self):
        for cancel in (None,lambda:True):
            start=time.monotonic()
            with self.assertRaisesRegex(ModelError,'task_cancelled' if cancel else 'model_timeout'):
                self.generate('import time;time.sleep(10)',cancel=cancel,timeout=.12)
            self.assertLess(time.monotonic()-start,2);self.assertIsNotNone(self.process.poll())


if __name__=='__main__':unittest.main()
