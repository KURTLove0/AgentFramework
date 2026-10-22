"""Reproducible synthetic knowledge -> conversation -> Agent workflow -> recovery demo."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
import tempfile
import time
from uuid import uuid4

from .web import Application
from .definitions import default_definition
from .knowledge_hub import hub
from .workflow_chat import WorkflowChat
from .contracts import digest


def main(argv=None):
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=Path('.agent-data/workflow-review'));parser.add_argument('--live-codex',action='store_true');parser.add_argument('--model')
    args=parser.parse_args(argv);root=args.output.resolve()/('workflow-'+uuid4().hex[:10]);root.mkdir(parents=True)
    app=Application(root/'data',lease_seconds=2,tool_timeout=.5);cases=[]
    def record(name,passed,**extra):
        cases.append({'case':name,'passed':bool(passed),**extra});print(('PASS ' if passed else 'FAIL ')+name,flush=True)
    def profile(name,domain):
        return app.agents.save({'name':name,'description':'固定模拟岗位','runtime':'mock','model':'builtin','options':{},'prompt':'仅使用模拟资料和工具，遵守独立验收。','skills':[],'mcp_servers':[],'revision':0,'definition':default_definition(name,domain)})
    qa=profile('规范检索岗位','knowledge-answer@1.0.0');review=profile('变更评估岗位','change-assessment@2.0.0')
    lib=app.library();access=app.library_access();asset=lib.create(access,{'title':'模拟流程规范','content':{'text':'失败测试判 HIGH，否则有依赖判 MEDIUM，无依赖判 LOW。草稿需六个章节，独立回读 DRAFT、版本、正文和摘要；不明写入按原幂等键核对。'}})
    lib.transition(access,asset['ref'],'REVIEW');lib.transition(access,asset['ref'],'PUBLISHED')
    record('four-module-library',len(hub(app)['capabilities'])==6 and hub(app)['counts']['knowledge']==1)
    chat=WorkflowChat(app);reply=chat.reply({'agent_id':qa['id'],'message':'先规范检索岗位，再变更评估岗位'})
    reply=chat.reply({'id':reply['id'],'revision':reply['revision'],'agent_id':qa['id'],'message':'名称改为模拟交易评估工作流'})
    record('conversation-proposes-without-execution',len(reply['proposal']['nodes'])==2 and not app.workflows().list() and not app.runs()['runs'],conversation_id=reply['id'])
    flows=app.workflows();w=flows.save(reply['proposal']|{'revision':0});nodes=w['nodes'];write_node=nodes[1]['id']
    s=flows.start(w['id'],{'revision':w['revision'],'grant':False,'scenarios':{write_node:'response-lost'},'request_id':'demo-auth-and-lost'})
    r=flows.execute(s['id']);record('authorization-stops-write-node',r['status']=='WAITING_AUTH' and not app.runtime().external.stats(app.tenant,r['nodes'][write_node]['run_id'])['drafts'])
    flows.grant(r['id'],write_node);r=flows.execute(r['id']);child=r['nodes'][write_node]['run_id'];stats=app.runtime().external.stats(app.tenant,child)
    record('response-lost-verified-one-draft',r['status']=='SUCCEEDED' and len(stats['drafts'])==stats['calls']['report.draft.create@1.0.0']==1,run_id=r['id'],child=child)
    downstream=app.runtime().store.result(app.tenant,child)
    record('upstream-artifact-delivered-with-hash',bool(downstream['task']['workflow_inputs']) and downstream['task']['workflow_inputs'][0]['content_hash']==digest(downstream['task']['workflow_inputs'][0]['artifact']))
    crashed=flows.start(w['id'],{'revision':w['revision'],'grant':True,'scenarios':{write_node:'crash-after-write'},'request_id':'demo-restart'})
    before=flows.execute(crashed['id']);child=before['nodes'][write_node]['run_id'];snapshot=app.runtime().store.load(app.tenant,child)['snapshot'];app.close();time.sleep(2.1)
    app=Application(root/'data',lease_seconds=2,tool_timeout=.5);flows=app.workflows();after=flows.execute(crashed['id']);stats=app.runtime().external.stats(app.tenant,child)
    record('restart-resumes-same-task-one-draft',before['status']=='INTERRUPTED' and after['status']=='SUCCEEDED' and child==after['nodes'][write_node]['run_id'] and len(stats['drafts'])==stats['calls']['report.draft.create@1.0.0']==1 and app.runtime().store.load(app.tenant,child)['snapshot']==snapshot,run_id=after['id'],child=child)
    if args.live_codex:
        from .llm import CodexConfig
        config=CodexConfig.local(**({'model':args.model} if args.model else {}),timeout=180,max_attempts=1,reasoning_effort='low')
        model=app.models.require('codex',config.model);efforts=model.get('efforts',[])
        effort='low' if 'low' in efforts else model.get('default_effort','medium')
        p={'name':'模拟流程设计 Agent','description':'只设计固定模拟流程；不执行业务','runtime':'codex','model':config.model,'options':{'timeout':180,'max_attempts':1,'reasoning_effort':effort},'prompt':'你是模拟流程设计助理。识别用户要求的执行岗位与依赖，提供清晰、可审查的流程提案。','skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('模拟流程设计 Agent')}
        designer=app.agents.save(p)
        started=time.time()
        try:
            response=WorkflowChat(app).reply({'agent_id':designer['id'],'message':'请创建“模拟规范查询与评估”工作流：先由规范检索岗位查询风险与草稿验收规范，再将结果传给变更评估岗位完成变更评估。执行节点只用这两个岗位；你仅负责设计，不作为执行节点。仅使用固定模拟上下文，不要运行工作流。','consent':True})
            (root/'live-conversation.json').write_text(json.dumps(response,ensure_ascii=False,indent=2)+'\n')
            proposal=response['proposal'];ids={n['agent_id'] for n in proposal['nodes']} if proposal else set()
            record('live-codex-agent-structured-proposal',ids=={qa['id'],review['id']} and any(n['depends_on'] for n in proposal['nodes']),model=config.model,elapsed_seconds=round(time.time()-started,2),conversation_id=response['id'],usage=response['usage'])
        except Exception as exc:
            record('live-codex-agent-structured-proposal',False,model=config.model,error=str(exc),elapsed_seconds=round(time.time()-started,2))
    result={'verified_at':datetime.now(timezone.utc).isoformat(),'scope':'fixed synthetic context; simulated business tools','passed':sum(c['passed'] for c in cases),'total':len(cases),'cases':cases,'data_dir':str(root/'data')}
    (root/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print('summary='+str(root/'summary.json'),flush=True);app.close()
    return 0 if result['passed']==result['total'] else 1


if __name__=='__main__':raise SystemExit(main())
