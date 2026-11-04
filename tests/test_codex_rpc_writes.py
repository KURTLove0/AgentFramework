"""Real RPC input backpressure must not disable execution fences."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_framework.llm import CodexConfig,CodexTransport,ModelError
from agent_framework.model_execution import SCHEMA
from agent_framework.contracts import LeaseLost


HANDSHAKE=r'''
import json,sys,time
from pathlib import Path
def emit(value):print(json.dumps(value),flush=True)
request=json.loads(sys.stdin.readline());emit({'id':request['id'],'result':{}})
assert json.loads(sys.stdin.readline())['method']=='initialized'
request=json.loads(sys.stdin.readline());assert request['method']=='thread/start'
emit({'id':request['id'],'result':{'thread':{'id':'thread-1'}}})
Path(sys.argv[1]).write_text('ready')
'''


class CodexRPCWriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='codex-rpc-write-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.ready=Path(self.tmp.name)/'ready';self.children=[]

    def generate(self,script,cancel=None,timeout=3,prompt=None):
        original=subprocess.Popen
        def launch(command,**kwargs):
            child=original([sys.executable,'-u','-c',script,str(self.ready)],**kwargs)
            self.children.append(child);return child
        transport=CodexTransport();transport.stream_output=True;transport.should_cancel=cancel
        self.started=time.monotonic()
        with patch('agent_framework.codex_stream.subprocess.Popen',launch):
            return transport.generate(prompt or '材料😀'*100000,SCHEMA,CodexConfig('fixture',timeout=timeout),timeout)

    def assert_closed(self):
        self.assertTrue(self.ready.exists(),'RPC handshake must complete before the input stalls')
        self.assertLess(time.monotonic()-self.started,1.5)
        self.assertIsNotNone(self.children[0].poll())
        self.assertTrue(all(pipe.closed for pipe in (self.children[0].stdin,self.children[0].stdout,self.children[0].stderr)))

    def test_stop_interrupts_a_blocked_turn_start_write(self):
        with self.assertRaisesRegex(ModelError,'task_cancelled'):
            self.generate(HANDSHAKE+'time.sleep(2.2)',cancel=lambda:self.ready.exists() and time.monotonic()-self.started>.15)
        self.assert_closed()

    def test_timeout_covers_a_blocked_turn_start_write(self):
        with self.assertRaisesRegex(ModelError,'model_timeout'):
            self.generate(HANDSHAKE+'time.sleep(2.2)',timeout=.25)
        self.assert_closed()

    def test_lease_error_is_preserved_while_input_is_blocked(self):
        failure=LeaseLost('replacement owns the task')
        def cancel():
            if self.ready.exists() and time.monotonic()-self.started>.15:raise failure
            return False
        with self.assertRaises(LeaseLost) as caught:self.generate(HANDSHAKE+'time.sleep(2.2)',cancel=cancel)
        self.assertIs(caught.exception,failure);self.assert_closed()

    def test_slow_reader_receives_one_complete_unicode_frame_in_order(self):
        prompt='材料😀\n引号"\\制表\t'*9000
        script=HANDSHAKE+r'''
import hashlib
chunks=[]
while True:
 chunk=sys.stdin.buffer.read1(4093);chunks.append(chunk);time.sleep(.001)
 if chunk.endswith(b'\n'):break
request=json.loads(b''.join(chunks))
assert request['method']=='turn/start' and request['params']['threadId']=='thread-1'
assert request['params']['outputSchema']['type']=='object'
answer=json.dumps({'hash':hashlib.sha256(request['params']['input'][0]['text'].encode()).hexdigest()})
emit({'id':request['id'],'result':{}})
emit({'method':'item/completed','params':{'threadId':'thread-1','item':{'id':'answer','type':'agentMessage','phase':'final_answer','text':answer}}})
emit({'method':'thread/tokenUsage/updated','params':{'threadId':'thread-1','tokenUsage':{'total':{'inputTokens':2,'outputTokens':3}}}})
emit({'method':'turn/completed','params':{'threadId':'thread-1','turn':{'status':'completed'}}})
time.sleep(5)
'''
        answer,meta=self.generate(script,prompt=prompt)
        self.assertEqual(json.loads(answer)['hash'],hashlib.sha256(prompt.encode()).hexdigest())
        self.assertEqual(meta['usage'],{'input_tokens':2,'output_tokens':3});self.assert_closed()

    def test_closed_input_is_a_model_failure_and_reaps_the_child(self):
        with self.assertRaisesRegex(ModelError,'codex_input_failed'):
            self.generate(HANDSHAKE+'import os;os.close(0);time.sleep(2.2)')
        self.assert_closed()

    def test_existing_stop_prevents_the_first_rpc_frame(self):
        with self.assertRaisesRegex(ModelError,'task_cancelled'):
            self.generate(HANDSHAKE+'time.sleep(2.2)',cancel=lambda:True)
        self.assertFalse(self.ready.exists());self.assertIsNotNone(self.children[0].poll())
        self.assertTrue(all(pipe.closed for pipe in (self.children[0].stdin,self.children[0].stdout,self.children[0].stderr)))


if __name__=='__main__':unittest.main()
