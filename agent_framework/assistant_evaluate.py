"""Reproducible assistant loop: knowledge -> role -> actions -> memory -> reviewed experience."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
from uuid import uuid4

from .cli import export_result
from .contracts import TaskContract,TOOLS
from .experience import ExperienceService
from .knowledge import Access,Library
from .memory import episodes
from .runtime import Runtime,legacy_registry_snapshot


def main(argv=None):
    parser=argparse.ArgumentParser(description='知识、记忆、经验、能力驱动助理的完整模拟验收')
    parser.add_argument('--output',type=Path,default=Path('.agent-data/assistant-review'))
    args=parser.parse_args(argv);root=args.output.resolve()/('assistant-'+uuid4().hex[:10]);root.mkdir(parents=True)
    runtime=Runtime(root/'data');library=Library(runtime.store);reviewer=Access('tenant-demo','kurt','project-demo',roles=('curator','reviewer'))
    service=ExperienceService(runtime.store);cases=[]
    def record(name,passed,**details):
        row={'case':name,'passed':bool(passed),**details};cases.append(row);print(('PASS ' if passed else 'FAIL ')+name,flush=True)
    def publish(payload):
        asset=library.create(reviewer,payload);library.transition(reviewer,asset['ref'],'REVIEW');return library.transition(reviewer,asset['ref'],'PUBLISHED')
    def run(name,**kwargs):
        state=runtime.submit(**kwargs);result=runtime.run(state['run_id']);export_result(runtime,result,root/name)
        return result,runtime.external.stats('tenant-demo',state['run_id'])
    draft=library.create(reviewer,{'kind':'KNOWLEDGE','title':'模拟发布前检查','content':{'text':'评估变更前核对依赖、测试和回滚证据；完成草稿需独立回读。'}})
    record('draft-is-not-context',draft['ref'] not in [a['ref'] for a in library.search(reviewer,'变更')['items']])
    library.transition(reviewer,draft['ref'],'REVIEW');guide=library.transition(reviewer,draft['ref'],'PUBLISHED')
    prefix=publish({'kind':'PREFERENCE','title':'模拟私有呈现偏好','content':{'report_title_prefix':'模拟知识驱动：'}})
    lost,stats=run('response-lost',scenario='response-lost')
    manifests=runtime.store.contexts('tenant-demo',lost['run_id'])
    selected={a['ref'] for m in manifests for a in m['selected']}
    record('knowledge-and-preference-affect-artifact',guide['ref'] in lost['report']['sections']['summary'] and lost['report']['title'].startswith('模拟知识驱动：') and prefix['ref'] in selected,run_id=lost['run_id'])
    record('response-lost-one-draft',lost['status']=='SUCCEEDED' and stats['calls'][TOOLS[2]]==1 and len(stats['drafts'])==1)
    record('episode-archived-once',len(episodes(runtime.store,reviewer))==1)
    candidate=next(a for a in service.list(reviewer) if lost['run_id'] in a['content']['supporting_runs'])
    record('candidate-is-not-context',candidate['ref'] not in [a['ref'] for a in library.search(reviewer,'幂等')['items']])
    evaluation=service.evaluate(reviewer,candidate['ref'])
    (root/'experience-evaluation.json').write_text(json.dumps(evaluation,ensure_ascii=False,indent=2)+'\n')
    record('offline-evaluation-with-counterexamples',evaluation['passed'] and evaluation['historical_write_replays']==0 and any(c['kind']=='counterexample' for c in evaluation['cases']),evaluation_id=evaluation['id'])
    service.publish(reviewer,candidate['ref'],evaluation['id'])
    follow,stats=run('learned-follow-up')
    follow_manifests=runtime.store.contexts('tenant-demo',follow['run_id'])
    record('published-experience-and-private-history-recalled',any(candidate['ref'] in text for text in follow['report']['limitations']) and any(i['kind']=='EPISODE' for m in follow_manifests for i in m['selected']))
    other,stats=run('another-principal',task=TaskContract(principal='another-user'))
    record('private-memory-and-experience-isolated',not other['report']['title'].startswith('模拟知识驱动：') and not any(candidate['ref'] in text for text in other['report']['limitations']) and not any(i['kind']=='EPISODE' for m in runtime.store.contexts('tenant-demo',other['run_id']) for i in m['selected']))
    library.transition(reviewer,candidate['ref'],'WITHDRAWN')
    withdrawn,_=run('experience-withdrawn')
    record('experience-withdrawal-affects-next-task',not any(candidate['ref'] in text for text in withdrawn['report']['limitations']))
    denied,stats=run('denied',scenario='denied')
    record('knowledge-does-not-grant-write',denied['status']=='WAITING_AUTH' and not stats['drafts'])
    tampered,stats=run('tampered',scenario='tampered-draft')
    record('experience-does-not-bypass-verifier',tampered['status']=='NEEDS_REVIEW' and len(stats['drafts'])==1)
    answer,stats=run('read-only-answer',task=TaskContract(domain_pack_ref='knowledge-answer@1.0.0',goal='变更评估风险和草稿验收规则是什么？'))
    record('second-domain-read-only-cited-answer',answer['status']=='SUCCEEDED' and all(c['passed'] for c in answer['checks'].values()) and stats=={'calls':{},'drafts':[]},run_id=answer['run_id'])
    ref=answer['report']['citations'][0]['asset_ref'];library.transition(reviewer,ref,'WITHDRAWN')
    record('withdrawn-source-not-searchable',ref not in [a['ref'] for a in library.search(reviewer,'变更')['items']])
    legacy_runtime=Runtime(root/'legacy');task=TaskContract();legacy_runtime.external.seed(task.to_dict());snapshot=legacy_registry_snapshot()
    state=legacy_runtime.store.create(task,snapshot,'response-lost');legacy=legacy_runtime.run(state['run_id'])
    record('legacy-snapshot-and-recovery-preserved',legacy['status']=='SUCCEEDED' and legacy['snapshot']==snapshot and legacy_runtime.external.stats('tenant-demo',state['run_id'])['calls'][TOOLS[2]]==1)
    summary={'generated_at':datetime.now(timezone.utc).isoformat(),'scope':'simulated knowledge and tools; deterministic cognition; isolated offline review',
             'passed':sum(c['passed'] for c in cases),'total':len(cases),'cases':cases}
    path=root/'summary.json';path.write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n');print('summary='+str(path))
    return 0 if summary['passed']==summary['total'] else 1


if __name__=='__main__':raise SystemExit(main())
