"""Disposable UI fixture. No real CLI/model or business writes are invoked."""
import json
from pathlib import Path
import tempfile
import os
import time
from unittest.mock import patch

from agent_framework.llm import CodexTransport,CursorTransport,QoderTransport,ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.model_stream import PublicProgress
from agent_framework.web import Application,WebServer


def generate(transport,prompt,schema,config,timeout):
    request=json.loads(prompt[prompt.index('\n{')+1:])
    if request['phase']!='execute':raise AssertionError('normal tasks must use execute')
    goal=request['context']['task']['goal']
    progress=PublicProgress('fixture',getattr(transport,'progress',None) or (lambda data:None))
    progress.feed({'type':'turn.started'})
    progress.feed({'type':'item.started','item':{'type':'reasoning','text':'PRIVATE_RUNTIME_REASONING_SENTINEL'}})
    progress.feed({'type':'reasoning_summary','summary':'已识别任务要求，正在整理可直接使用的内容。'})
    for n in range(60 if "慢速" in goal else 30):
        if callable(getattr(transport,'should_cancel',None)) and transport.should_cancel():raise ModelError('task_cancelled')
        time.sleep(.1)
    if '超时验证' in goal:raise ModelError('model_timeout')
    if '信息缺口' in goal:result={'kind':'request_input','summary':'请补充客户的问题和期望回复时间。','result':None}
    else:
        result={'kind':'result','summary':'已按任务要求完成交付，未执行外部写入。',
                'result':{'title':'本次任务结果','content':'您好，感谢您的反馈。\n我们将在周五前回复处理进展。\n\n任务目标：'+goal+'\n\n<img src=x onerror="window.__runtimeXss=1">',
                          'citations':[],'limitations':[]}}
    history=request['context']['task'].get('conversation_context')
    if history and history.get('messages') and result['kind']=='result':
        result['result']['content']='已按你的补充继续修改。\n\n原任务：'+history['goal']+'\n本轮要求：'+goal+'\n已有对话：'+str(len(history['messages']))+' 条。\n\n上一轮内容：'+next((m['content'][:180] for m in reversed(history['messages']) if m['role']=='assistant'),'')
    progress.feed({'type':'turn.completed'})
    return json.dumps(result,ensure_ascii=False),{'usage':{'input_tokens':100,'output_tokens':40}}


if __name__=='__main__':
    root=os.environ.get('AGENT_CONVERSATION_TEST_DIR') or tempfile.mkdtemp(prefix='model-runtime-browser-',dir='/private/tmp')
    catalog={'models':[{'id':'visible-fixture','name':'Visible fixture','efforts':['low','medium'],'default_effort':'low'}],
             'source':'isolated fixture','cached':False}
    with patch.object(ModelCatalog,'list',return_value=catalog),patch.object(CodexTransport,'generate',generate),patch.object(CursorTransport,'generate',generate),patch.object(QoderTransport,'generate',generate):
        app=Application(root)
        server=WebServer(('127.0.0.1',int(os.environ.get('TASK_CHAT_PORT','8799'))),app)
        print('Fixture data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
