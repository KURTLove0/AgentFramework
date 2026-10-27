"""Offline evaluation and explicit review of experience candidates.

Evaluation uses separate temporary simulated systems. It never dispatches a
historical action, calls a model, or grants production authorization.
"""
import json
from copy import deepcopy
from pathlib import Path
import tempfile
import time
from uuid import uuid4

from .contracts import PolicyDenied, canonical, digest
from .definitions import DOMAIN, get_domain
from .knowledge import Library


class ExperienceService:
    def __init__(self, store):
        self.library=Library(store);self.store=self.library.store

    def list(self, access):
        assets=[a for a in self.library.list(access,include_unpublished=True) if a['kind']=='EXPERIENCE']
        with self.store.connect() as db:
            for asset in assets:
                row=db.execute('SELECT data FROM experience_evaluations WHERE tenant=? AND id=? AND version=? ORDER BY rowid DESC LIMIT 1',
                               (access.tenant,asset['id'],asset['version'])).fetchone()
                if row:
                    evaluation=json.loads(row[0]);asset['latest_evaluation']={k:evaluation[k] for k in ('id','passed','created_at')}
        return assets

    def evaluate(self, access, ref):
        if 'reviewer' not in access.roles:raise PolicyDenied('experience evaluation requires reviewer role')
        asset=self.library.get(access,ref,review=True)
        if asset['kind']!='EXPERIENCE' or asset['status'] not in {'CANDIDATE','EVALUATED'}:
            raise ValueError('experience is not an evaluable candidate')
        content=asset['content']
        if content['category'] not in {'uncertain-write','readback-integrity','evidence-first','task-delivery'}:
            raise ValueError('unregistered experience evaluation rubric')
        # Inspect the actual archived source and its frozen verification evidence.
        sources=[];source_states=[]
        with self.store.connect() as db:
            for run in content['supporting_runs']:
                row=db.execute('SELECT data FROM episodic_memories WHERE tenant=? AND run_id=? AND project=? AND environment=?',
                               (access.tenant,run,access.project,access.environment)).fetchone()
                if not row:raise PolicyDenied('source episode is unavailable in review scope')
                episode=json.loads(row[0])
                state=self.store.result(access.tenant,run)
                source_states.append(state)
                evidence=self.store.evidence(state)
                from .definitions import domain_for
                checks=domain_for(state['snapshot']).task_checks(state,evidence,store=self.store)
                recomputed=all(c['passed'] for c in checks.values())
                consistent=(state['status']!='SUCCEEDED' or recomputed) and episode['snapshot_hash']==state['snapshot']['hash']
                sources.append({'run_id':run,'episode_hash':digest(episode),'snapshot_hash':state['snapshot']['hash'],
                                'outcome':state['status'],'checks_recomputed':checks,'consistent':consistent})
        if content['category']=='task-delivery':
            cases=[]
            from .definitions import domain_for
            for state in source_states:
                if (state['task'].get('execution_mode') not in ('direct','conversation')
                    or state['task']['domain_pack_ref']!=content['conditions']['domain_pack_ref']):
                    raise PolicyDenied('experience source does not match normal task execution')
                domain=domain_for(state['snapshot'])
                for name,report,expected in (
                    ('complete-deliverable',{'title':'结构验证','content':'用于验证交付格式的本地内容。','citations':[],'limitations':[]},True),
                    ('empty-deliverable',{'title':'空内容','content':'','citations':[],'limitations':[]},False),
                    ('forged-citation',{'title':'伪造来源','content':'无依据的内容','citations':[{'asset_ref':'missing@1','content_hash':'missing','quote':'missing','evidence_ref':'missing'}],'limitations':[]},False)):
                    sample=deepcopy(state);sample['report']=report
                    checks=domain.task_checks(sample,{},store=self.store)
                    cases.append({'scenario':name,'kind':'support' if expected else 'counterexample','passed':all(c['passed'] for c in checks.values())==expected,
                                  'checks':{key:check['passed'] for key,check in checks.items()},'draft_count':0,'write_calls':0})
            return self._save_evaluation(access,asset,sources,cases,mode='local-deliverable-checks')
        from .runtime import Runtime
        from .contracts import TaskContract, TOOLS
        evaluation_domain=get_domain(content['conditions']['domain_pack_ref'])
        expected={'normal':'SUCCEEDED','response-lost':'SUCCEEDED','unverifiable':'NEEDS_REVIEW',
                  'tampered-draft':'NEEDS_REVIEW','denied':'WAITING_AUTH'}
        if evaluation_domain.ref=='knowledge-answer@1.0.0':
            expected={'normal':'SUCCEEDED','forged-answer':'FAILED','premature-finish':'NEEDS_REVIEW'}
        general=evaluation_domain.ref=='general-assistant@1.0.0'
        if general:
            expected={'normal':'SUCCEEDED','forged-citation':'FAILED','premature-finish':'NEEDS_REVIEW'}
        cases=[]
        with tempfile.TemporaryDirectory(prefix='experience-replay-') as directory:
            for scenario,status in expected.items():
                planner=None
                read_only=general or evaluation_domain.ref=='knowledge-answer@1.0.0'
                if general and scenario!='normal':
                    from .domains.general_assistant import GeneralPlanner
                    from .contracts import Decision
                    class GeneralCounterexample(GeneralPlanner):
                        def compose(self,context):
                            report=super().compose(context)
                            report['citations']=[{'asset_ref':'invented@1','evidence_ref':'invented','content_hash':'invented','quote':'invented'}]
                            return report
                        def decide(self,context):
                            return Decision('request_finish','未交付内容却申请完成') if scenario=='premature-finish' else super().decide(context)
                    planner=GeneralCounterexample()
                elif read_only and scenario!='normal':
                    from .domains.knowledge_answer import KnowledgePlanner
                    from .contracts import Decision
                    class Counterexample(KnowledgePlanner):
                        def compose(self,context):
                            report=super().compose(context);report['answer']='没有资料支持的结论';return report
                        def decide(self,context):
                            return Decision('request_finish','未读取资料却申请完成') if scenario=='premature-finish' else super().decide(context)
                    planner=Counterexample()
                runtime=Runtime(Path(directory)/scenario,planner=planner)
                state=runtime.submit(TaskContract(principal='offline-review',domain_pack_ref=evaluation_domain.ref),scenario='normal' if read_only else scenario)
                result=runtime.run(state['run_id'])
                stats=runtime.external.stats(state['tenant_id'],state['run_id'])
                drafts=len(stats['drafts']);writes=stats['calls'].get(TOOLS[2],0)
                correct=(result['status']==status and drafts==(0 if read_only or scenario=='denied' else 1) and writes<=1)
                cases.append({'scenario':scenario,'status':result['status'],'draft_count':drafts,'write_calls':writes,
                              'passed':correct,'kind':'support' if scenario in ('normal','response-lost') else 'counterexample',
                              'checks':{key:value['passed'] for key,value in result['checks'].items()}})
        return self._save_evaluation(access,asset,sources,cases)

    def _save_evaluation(self,access,asset,sources,cases,mode='isolated-mock-replay'):
        evaluation_domain=get_domain(asset['content']['conditions']['domain_pack_ref'])
        result={'id':'evaluation-'+uuid4().hex[:16],'ref':asset['ref'],'asset_hash':asset['content_hash'],
                'evaluator_ref':'experience-review@1.0.0','domain_hash':digest(evaluation_domain.descriptor()),'domain_ref':evaluation_domain.ref,
                'actor':access.principal,'created_at':time.time(),'sources':sources,'cases':cases,
                'passed':bool(sources) and all(s['consistent'] for s in sources) and all(c['passed'] for c in cases),
                'mode':mode,'live_model_calls':0,'historical_write_replays':0}
        with self.store.transaction() as db:
            cursor=db.execute("UPDATE asset_versions SET status='EVALUATED' WHERE tenant=? AND id=? AND version=? AND hash=? AND status IN ('CANDIDATE','EVALUATED')",
                              (access.tenant,asset['id'],asset['version'],asset['content_hash']))
            if cursor.rowcount!=1:raise ValueError('candidate changed during evaluation')
            db.execute('INSERT INTO experience_evaluations VALUES(?,?,?,?,?,?)',
                       (access.tenant,asset['id'],asset['version'],result['id'],asset['content_hash'],canonical(result)))
            db.execute('INSERT INTO asset_events VALUES(?,?,?,?,?,?,?)',
                       (access.tenant,asset['id'],asset['version'],time.time(),access.principal,'evaluated',canonical({'evaluation_id':result['id'],'passed':result['passed']})))
        return result

    def publish(self, access, ref, evaluation_id):
        with self.store.connect() as db:
            row=db.execute('SELECT data FROM experience_evaluations WHERE tenant=? AND evaluation_id=?',(access.tenant,evaluation_id)).fetchone()
        if not row or json.loads(row[0]).get('domain_hash')!=digest(get_domain(json.loads(row[0]).get('domain_ref','change-assessment@2.0.0')).descriptor()):
            raise PolicyDenied('evaluation runtime has changed; reevaluation required')
        return self.library.transition(access,ref,'PUBLISHED',evaluation_id=evaluation_id)

    def evaluations(self, access, ref):
        asset=self.library.get(access,ref,review=True)
        if 'reviewer' not in access.roles and asset['owner']!=access.principal:raise PolicyDenied('review access required')
        with self.store.connect() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT data FROM experience_evaluations WHERE tenant=? AND id=? AND version=? ORDER BY rowid',
                                                            (access.tenant,asset['id'],asset['version']))]
