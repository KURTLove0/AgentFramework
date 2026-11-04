"""A gated synthetic report exercises real persisted streaming and rendering."""
import json
import os
import tempfile
import threading
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.llm import CodexTransport
from agent_framework.model_catalog import ModelCatalog
from agent_framework.model_stream import PublicProgress
from agent_framework.web import Application, Handler, WebServer


CODE='  report = {"title": "<周报>", "path": "资料/报告", "notes": "'+('保留原始空格与文本。'*20)+'"}\n  print(report)\n'
PREFIX='# 项目交付报告\n\n本轮整理了 **任务进度** 与后续安排。\n\n| 项目 | 负责人 | 状态 | 验收说明 | 下次行动 | 资料链接 |\n| :--- | :--- | :---: | :--- | :--- | :--- |\n| 资料整理 | 产品团队 | 完成 | 核对了事实与来源版本 | 与使用方确认完整性 | [原始资料](https://example.com/source) |\n| 结果审阅 | 项目负责人 | 待确认 | 保留 A\\|B 两种解释和 `source\\|ref` 引用 | 补充尚未确认的信息 | [跟踪记录](https://example.com/tracking) |\n\n> 当前结论来自本轮资料。\n>\n> *适用范围*需要后续核对。\n\n3. 复核输出\n   - 检查数据来源\n   - 更新待确认项\n4. 确认下一步\n\n```python\n'+CODE
MIDDLE=PREFIX+'```\n\n后续补充已返回。\n\n'
REPORT=MIDDLE+'<script>window.modelScriptExecuted=true</script>\n\n![外部图示](https://example.com/tracking.png)\n\n[危险链接](javascript:alert%281%29)\n\n~~~text\n保留最后一块代码\n~~~\n'
gates=[threading.Event(),threading.Event()]
stage=0


def generate(transport,prompt,schema,config,timeout):
    global stage
    raw=json.dumps({'kind':'result','summary':'报告已整理','result':{'title':'项目交付报告','content':REPORT,'citations':[],'limitations':[]}},ensure_ascii=False)
    start=raw.index('"content": "')+len('"content": "')
    cuts=[start+len(json.dumps(prefix,ensure_ascii=False)[1:-1]) for prefix in (PREFIX,MIDDLE)]+[len(raw)]
    progress=PublicProgress('fixture',getattr(transport,'progress',None) or (lambda data:None))
    progress.feed({'type':'turn.started'});position=0
    for index,cut in enumerate(cuts):
        progress.feed({'type':'agent_message_delta','item_id':'report','delta':raw[position:cut]});progress.flush();position=cut;stage=index+1
        if index<2 and not gates[index].wait(120):raise RuntimeError('Markdown fixture gate was not released')
    return raw,{'usage':{'input_tokens':20,'output_tokens':400}}


class FixtureHandler(Handler):
    def dispatch(self,mutation=False):
        if urlsplit(self.path).path!='/__test/reply-report':return super().dispatch(mutation)
        self.guard(mutation)
        if mutation:
            data=self.read_json_body('/__test/reply-report')
            if set(data)!={'release'} or data['release'] not in (1,2):return self.reply(400,{'error':'invalid gate'})
            gates[data['release']-1].set()
        return self.reply(200,{'stage':stage,'report':REPORT,'code':CODE})


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='reply-markdown-browser-',dir='/private/tmp')
    catalog={'models':[{'id':'review-model','name':'Offline report fixture','efforts':['low'],'default_effort':'low'}],'source':'isolated fixture','cached':False}
    with patch.object(ModelCatalog,'list',return_value=catalog),patch.object(CodexTransport,'generate',generate):
        app=Application(root);server=WebServer(('127.0.0.1',int(os.environ['REPLY_MARKDOWN_PORT'])),app);server.RequestHandlerClass=FixtureHandler
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:
            for gate in gates:gate.set()
            server.server_close();app.close()
