"""Persist representative model failures through the real task runtime."""
import json
import os
import tempfile
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.definitions import default_definition
from agent_framework.llm import CodexTransport,CursorTransport,QoderTransport,ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.runtime import CrashInjected
from agent_framework.web import Application,Handler,WebServer


CASES=[
 {'title':'模型提前结束','provider':'codex','code':'incomplete_model_turn','status':'FAILED','message':'模型连接在本轮完成前已结束。'},
 {'title':'运行时启动失败','provider':'cursor','code':'cursor_unavailable','status':'FAILED','message':'无法启动 Cursor。'},
 {'title':'需要登录运行时','provider':'qoder','code':'qoder_auth_required','status':'FAILED','message':'Qoder CLI 尚未登录'},
 {'title':'任务执行期限到期','provider':'codex','code':'task_deadline','status':'EXPIRED','message':'任务已超过执行期限'},
 {'title':'未知模型故障','provider':'codex','code':'future_provider_failure_v2','status':'FAILED','message':'本轮处理失败'},
 {'title':'需要补充运行材料','provider':'codex','code':None,'status':'WAITING_INPUT','message':'请补充 model_timeout 事件对应的运行时间。'}
]
calls={}
def generate(transport,prompt,*args):
    request=json.loads(prompt[prompt.index('\n{')+1:]);task=request['context']['task'];history=task['conversation_context'];root=history['task_id'];calls[root]=calls.get(root,0)+1
    case=next(c for c in CASES if c['title']==history['goal'])
    if history['turn']>1:
        value={'kind':'result','summary':'本轮已完成。','result':{'title':'重试结果','content':'已完成明确请求的重试。原失败记录继续保留。','citations':[],'limitations':[]}}
    elif case['code']:
        transport.progress({'kind':'answer_text','text':'已保存的公开片段：正在核对任务材料。','attempt':1})
        raise ModelError(case['code'])
    else:value={'kind':'request_input','summary':case['message'],'result':None}
    return json.dumps(value,ensure_ascii=False),{'usage':{'input_tokens':5,'output_tokens':5}}

class FailureMessageHandler(Handler):
    def dispatch(self,mutation=False):
        if urlsplit(self.path).path!='/__test/model-failure-messages':return super().dispatch(mutation)
        self.guard(mutation)
        if mutation:return self.reply(405,{'error':'GET required'})
        return self.reply(200,{'cases':CASES,'calls':calls,'review_run':review['run_id']})

if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='model-failure-messages-browser-',dir='/private/tmp')
    catalog={'models':[{'id':'failure-message-fixture','name':'Failure message fixture','efforts':['low']}],'source':'isolated fixture'}
    with patch.object(ModelCatalog,'list',return_value=catalog),patch.object(CodexTransport,'generate',generate),patch.object(CursorTransport,'generate',generate),patch.object(QoderTransport,'generate',generate):
        app=Application(root)
        review=app.create({'runtime':'mock','scenario':'crash-after-write','goal':'核对已写入但尚未确认的业务草稿','consent':True,'grant':True,'start':False})['run']
        runtime=app.runtime()
        try:runtime.run(review['run_id'])
        except CrashInjected:pass
        else:raise AssertionError('fixture must leave an unresolved write')
        with runtime.store.transaction() as db:db.execute('UPDATE runs SET lease_until=0 WHERE tenant_id=? AND id=?',(app.tenant,review['run_id']))
        lease=runtime.store.acquire(app.tenant,review['run_id'],10);state=runtime.store.load(app.tenant,review['run_id'])
        try:runtime.cognition_failed(state,lease,ModelError('task_deadline'))
        finally:runtime.store.release(state,lease)
        assert runtime.store.load(app.tenant,review['run_id'])['status']=='NEEDS_REVIEW'
        for case in CASES:
            provider=case['provider']
            agent=app.agents.save({'name':case['title']+'助手','description':'隔离的失败恢复验收','runtime':provider,'model':'failure-message-fixture',
                'options':{'timeout':60,'max_attempts':2,**({'reasoning_effort':'low'} if provider=='codex' else {})},'prompt':'按目标整理材料。','skills':[],'mcp_servers':[],
                'revision':0,'definition':default_definition(case['title']+'助手','general-assistant@1.0.0')})
            case['agent_id']=agent['id']
        server=WebServer(('127.0.0.1',int(os.environ.get('MODEL_FAILURE_PORT','8799'))),app);server.RequestHandlerClass=FailureMessageHandler
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
