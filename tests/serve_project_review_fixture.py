"""Isolated project journeys. All model responses are synthetic, data is temporary."""
import json
import os
import tempfile
import time
from unittest.mock import patch

from agent_framework.llm import CodexTransport,CursorTransport,QoderTransport,ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.model_stream import PublicProgress
from agent_framework.web import Application,WebServer


def generate(transport,prompt,schema,config,timeout):
    request=json.loads(prompt[prompt.index('\n{')+1:])
    if request['phase']!='execute':raise AssertionError('Normal tasks must execute directly')
    task=request['context']['task'];goal=task['goal'];history=task.get('conversation_context') or {}
    progress=PublicProgress('fixture',getattr(transport,'progress',None) or (lambda data:None))
    progress.feed({'type':'turn.started'})
    progress.feed({'type':'reasoning_summary_delta','item_id':'summary','delta':'正在核对任务目标和已提供的资料。'})
    for _ in range(8):
        if callable(getattr(transport,'should_cancel',None)) and transport.should_cancel():raise ModelError('task_cancelled')
        time.sleep(.1)
    if '确认会议时间' in goal and not history.get('messages'):
        value={'kind':'request_input','summary':'会议安排在什么时候？','result':None}
    else:
        content='已完成：'+goal
        if history.get('messages'):content+='\n已有对话：'+str(len(history['messages']))+' 条。'
        for item in task.get('workflow_inputs',[]):content+='\n上游结果：'+item['artifact']['content']
        value={'kind':'result','summary':'已按目标整理本轮结果。','result':{'title':'本轮结果','content':content,'citations':[],'limitations':[]}}
    raw=json.dumps(value,ensure_ascii=False)
    progress.feed({'type':'agent_message_delta','item_id':'answer','delta':raw});progress.flush()
    return raw,{'usage':{'input_tokens':30,'output_tokens':20}}


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='project-review-browser-',dir='/private/tmp')
    catalog={'models':[{'id':'review-model','name':'Review fixture','efforts':['low'],'default_effort':'low'}],'source':'isolated fixture','cached':False}
    with patch.object(ModelCatalog,'list',return_value=catalog),patch.object(CodexTransport,'generate',generate),patch.object(CursorTransport,'generate',generate),patch.object(QoderTransport,'generate',generate):
        app=Application(root);server=WebServer(('127.0.0.1',int(os.environ.get('PROJECT_REVIEW_PORT','8799'))),app)
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
