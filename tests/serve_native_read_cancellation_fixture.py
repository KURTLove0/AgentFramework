"""Disposable native read barriers; real stop journal, library and read proxy."""
import json
import os
import tempfile
import threading
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.contracts import PolicyDenied
from agent_framework.definitions import default_definition
from agent_framework.gateway import Gateway
from agent_framework.knowledge import Library
from agent_framework.llm import CodexTransport,ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.read_proxy import ReadCapabilityProxy
from agent_framework.web import Application,Handler,WebServer


records={}

def wait(record):
    record['entered'].set()
    if not record['release'].wait(35):raise ModelError('model_timeout')


def generate(transport,prompt,*args):
    request=json.loads(prompt[prompt.index('\n{')+1:]);task=request['context']['task'];history=task['conversation_context']
    if history['turn']>1:
        result={'title':'后续回复','content':'已继续处理明确排队的消息。','citations':[],'limitations':[]}
    else:
        record={'task_id':history['task_id'],'mode':'before' if '开始前' in task['goal'] else 'during',
            'entered':threading.Event(),'release':threading.Event(),'adapter_calls':0,'delivered':False,'rejection':None}
        records[history['task_id']]=record
        if transport.progress:transport.progress({'kind':'answer_text','text':'已保留的片段：正在核对资料。','attempt':1})
        if record['mode']=='before':wait(record)
        token=transport.governed_profile['mcp_servers'][0]['args'][-1]
        try:
            output=ReadCapabilityProxy(root).call(token,'knowledge_search',{'project_id':app.workspace['project_id'],'query':'nativecancelfixturetoken'})
            record['delivered']=True
            result={'title':'读取结果','content':output['data']['hits'][0]['title'],'citations':[],'limitations':[]}
        except PolicyDenied as exc:
            record['rejection']=type(exc).__name__
            # Simulate a CLI failing as its tool session is stopped; Runtime must
            # resolve the saved cancellation rather than report a model failure.
            raise ModelError('model_process_failed') from exc
    return json.dumps({'kind':'result','summary':'已处理本轮。','result':result},ensure_ascii=False),{'usage':{'input_tokens':5,'output_tokens':5}}


original_invoke=Gateway.invoke
def invoke(gateway,state,action):
    result=original_invoke(gateway,state,action)
    record=records.get(state['run_id'])
    if record and action['tool_ref']=='knowledge.search@1.0.0':
        record['adapter_calls']+=1
        if record['mode']=='during':wait(record)
    return result


class NativeStopHandler(Handler):
    def dispatch(self,mutation=False):
        path=urlsplit(self.path).path
        if path not in ('/__test/native-stop-state','/__test/native-stop-release'):return super().dispatch(mutation)
        self.guard(mutation)
        if path.endswith('state') and not mutation:
            return self.reply(200,{'agent_id':agent['id'],'records':[
                {k:v for k,v in r.items() if k not in ('entered','release')}|{'entered':r['entered'].is_set()} for r in records.values()]})
        if path.endswith('release') and mutation:
            data=self.read_json_body(path);record=records[data['task_id']];record['release'].set()
            return self.reply(200,{'ok':True})
        return self.reply(405,{'error':'method not allowed'})


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='native-stop-browser-',dir='/private/tmp')
    catalog={'models':[{'id':'native-stop-fixture','name':'Native stop fixture','efforts':['low']}],'source':'isolated fixture'}
    with patch.object(ModelCatalog,'list',return_value=catalog),patch.object(CodexTransport,'generate',generate),patch.object(Gateway,'invoke',invoke):
        app=Application(root);library=Library(app.control_store)
        source=library.create(app.library_access(),{'kind':'KNOWLEDGE','title':'nativecancelfixturetoken','content':{'text':'Synthetic late read body.'}})
        library.transition(app.library_access(),source['ref'],'REVIEW');library.transition(app.library_access(),source['ref'],'PUBLISHED')
        definition=default_definition('原生读取停止助手','general-assistant@1.0.0');definition['native_read_refs']=['knowledge.search@1.0.0']
        agent=app.agents.save({'name':'原生读取停止助手','description':'隔离停止验收','runtime':'codex','model':'native-stop-fixture',
            'options':{'timeout':60,'max_attempts':1,'reasoning_effort':'low'},'prompt':'按目标处理。','skills':[],'mcp_servers':[],'revision':0,'definition':definition})
        server=WebServer(('127.0.0.1',int(os.environ.get('NATIVE_STOP_PORT','8799'))),app);server.RequestHandlerClass=NativeStopHandler
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:
            for record in records.values():record['release'].set()
            server.server_close();app.close()
