"""Generation accepts one reviewed configuration and fences later draft writes."""
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor,TimeoutError
from copy import deepcopy
import http.client
import json
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical
from agent_framework.definitions import default_definition
from agent_framework.learning import Learning,agent_generate
from agent_framework.ontology import source_context
from agent_framework.runtime_config import ConfigConflict
from agent_framework.agents import AgentRegistry
from agent_framework.web import Application,WebServer


def profile(revision=0):
    return {'name':'生成受理助手','description':'核对来源后生成','runtime':'mock','model':'builtin','options':{},
            'prompt':'保留来源与限制','skills':[],'mcp_servers':[],'revision':revision,
            'definition':default_definition('生成受理助手','general-assistant@1.0.0')}


class LearningAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Application(self.tmp.name);self.addCleanup(self.root.close)
        self.space=self.root.workspaces.save({'name':'生成受理空间','business':'测试','scenario':'来源核对','description':'','revision':0})
        self.app=self.root.scoped(self.space['id']);self.service=Learning(self.app)
        other=Application(self.tmp.name);self.addCleanup(other.close);self.other=other.scoped(self.space['id'])
        self.agent=self.app.agents.save(profile());self.lib=self.app.library();self.access=self.app.library_access()
        a=self.lib.create(self.access,{'title':'有效资料','content':{'text':'测试证据需要明确来源。'}})
        self.lib.transition(self.access,a['ref'],'REVIEW');self.source=self.lib.transition(self.access,a['ref'],'PUBLISHED')

    def request(self):
        return {'request_id':'learning-acceptance','purpose':'ontology','source_refs':[self.source['ref']],
                'agent_id':self.agent['id'],'agent_revision':self.agent['revision'],'instruction':'基于选定资料生成'}

    def delete(self):return self.root.workspaces.lifecycle(self.space['id'],1,True)

    def count(self,table):
        with self.service.store.connect() as db:
            return db.execute('SELECT COUNT(*) FROM '+table+' WHERE tenant=? AND workspace=?',(self.app.tenant,self.space['id'])).fetchone()[0]

    @contextmanager
    def after_agent(self,action):
        check=self.service._agent
        def interleave(data):
            result=check(data);action();return result
        with patch.object(self.service,'_agent',interleave):yield

    def bind_skill(self,enabled=True):
        registry=self.app.skills();p=registry.save({'folder':'learning-guard-method','revision':0,'files':{
            'SKILL.md':{'encoding':'utf-8','content':'---\nname: learning-guard-method\ndescription: 生成时核对来源\n---\n\n保留来源。'}}})
        p=registry.lifecycle(p['id'],1,'publish',1)
        data=profile(1);data['skill_bindings']=[{'skill_id':p['id'],'version':1,'enabled':enabled}]
        self.agent=self.app.agents.save(data,self.agent['id']);return p

    def test_agent_update_between_preflight_and_acceptance_does_not_call_the_generator(self):
        def update():
            data=profile(1);data['prompt']='另一页面新保存的指令';self.other.agents.save(data,self.agent['id'])
        q=self.request()
        with self.after_agent(update),patch('agent_framework.learning.agent_generate',wraps=agent_generate) as generate:
            with self.assertRaises(ConfigConflict):self.service.generate(q)
            self.assertEqual(generate.call_count,0)
        self.assertEqual(self.count('learning_proposals'),0)
        q['agent_revision']=2;p=self.service.generate(q);self.assertEqual(p['agent_revision'],2)

    def test_agent_archive_between_preflight_and_acceptance_is_rejected(self):
        with self.after_agent(lambda:self.other.agents.archive(self.agent['id'],1)),patch('agent_framework.learning.agent_generate',wraps=agent_generate) as generate:
            with self.assertRaises(ConfigConflict):self.service.generate(self.request())
            self.assertEqual(generate.call_count,0)
        self.assertEqual(self.count('learning_proposals'),0)

    def test_enabled_skill_withdrawal_between_preflight_and_acceptance_is_rejected(self):
        skill=self.bind_skill()
        with self.after_agent(lambda:self.other.skills().lifecycle(skill['id'],skill['revision'],'withdraw',1)),patch('agent_framework.learning.agent_generate',wraps=agent_generate) as generate:
            with self.assertRaises(ConfigConflict):self.service.generate(self.request())
            self.assertEqual(generate.call_count,0)
        self.assertEqual(self.count('learning_proposals'),0)

    def test_disabled_skill_withdrawal_does_not_block_generation(self):
        skill=self.bind_skill(False)
        with self.after_agent(lambda:self.other.skills().lifecycle(skill['id'],skill['revision'],'withdraw',1)):
            self.assertEqual(self.service.generate(self.request())['status'],'DRAFT')

    def test_source_withdrawal_after_it_was_read_is_rejected_before_generation(self):
        changed=False
        def interleave(*args,**kwargs):
            nonlocal changed
            result=source_context(*args,**kwargs)
            if not changed:changed=True;self.lib.transition(self.access,self.source['ref'],'WITHDRAWN')
            return result
        with patch('agent_framework.ontology.source_context',side_effect=interleave),patch('agent_framework.learning.agent_generate',wraps=agent_generate) as generate:
            with self.assertRaises(ConfigConflict):self.service.generate(self.request())
            self.assertEqual(generate.call_count,0)
        self.assertEqual(self.count('learning_proposals'),0)

    def test_workspace_deletion_after_preflight_blocks_new_generation(self):
        with self.after_agent(self.delete),patch('agent_framework.learning.agent_generate',wraps=agent_generate) as generate:
            with self.assertRaises(KeyError):self.service.generate(self.request())
            self.assertEqual(generate.call_count,0)
        self.assertEqual(self.count('learning_proposals'),0)

    def test_accepted_generation_finishes_with_its_frozen_selection_and_is_not_replayed(self):
        q=self.request()
        def complete(app,agent,purpose,context,shape,consent,offline):
            self.assertEqual(self.service.list()[0]['status'],'GENERATING')
            self.other.agents.archive(self.agent['id'],1);self.lib.transition(self.access,self.source['ref'],'WITHDRAWN')
            return offline(),{'model_calls':0,'usage':[]}
        with patch('agent_framework.learning.agent_generate',side_effect=complete) as generate:
            p=self.service.generate(q);again=self.service.generate(q);self.assertEqual(generate.call_count,1)
        self.assertEqual(p['status'],'DRAFT');self.assertEqual(again,p);self.assertEqual(p['agent_revision'],1)
        with self.assertRaises(ValueError):self.service.deposit(p['id'],{'revision':p['revision'],'item_ids':['ontology']})

    def test_accepted_generation_result_is_preserved_if_its_workspace_is_deleted_during_generation(self):
        q=self.request()
        def complete(app,agent,purpose,context,shape,consent,offline):
            self.delete();return offline(),{'model_calls':0,'usage':[]}
        with patch('agent_framework.learning.agent_generate',side_effect=complete):p=self.service.generate(q)
        self.assertEqual(p['status'],'DRAFT');self.assertEqual(self.service.get(p['id'])['output'],p['output'])
        self.root.workspaces.lifecycle(self.space['id'],2,False)
        with patch('agent_framework.learning.agent_generate',side_effect=AssertionError('must not replay')):
            self.assertEqual(self.service.generate(q)['id'],p['id'])

    def test_deleted_workspace_blocks_draft_save(self):
        p=self.service.generate(self.request());self.delete()
        with self.assertRaises(KeyError):self.service.save(p['id'],{'revision':p['revision'],'output':p['output']})
        self.assertEqual(self.service.get(p['id']),p)

    def test_deleted_workspace_blocks_asset_deposition(self):
        p=self.service.generate(self.request());self.delete()
        with self.assertRaises(KeyError):self.service.deposit(p['id'],{'revision':p['revision'],'item_ids':['ontology']})
        self.assertEqual(self.service.get(p['id']),p)
        with self.service.store.connect() as db:self.assertEqual(db.execute("SELECT COUNT(*) FROM asset_versions WHERE tenant=? AND id LIKE 'learned-%'",(self.app.tenant,)).fetchone()[0],0)

    def failed(self):
        p=self.service.generate(self.request())
        with self.service.store.transaction() as db:
            value={k:v for k,v in p.items() if k not in ('id','revision','status','purpose')};value['rejected_output']=deepcopy(p['output']);value['error']='合成约束失败'
            db.execute("UPDATE learning_proposals SET status='FAILED',data=? WHERE id=?",(canonical(value),p['id']))
        return self.service.get(p['id'])

    def test_deleted_workspace_blocks_repair_draft_creation(self):
        p=self.failed();self.assertTrue(p['repairable']);self.delete()
        with self.assertRaises(KeyError):self.service.repair(p['id'],{'revision':p['revision']})
        self.assertEqual(self.count('learning_proposals'),1)

    def test_workspace_deletion_during_draft_validation_rolls_back_the_save(self):
        p=self.service.generate(self.request());validate=self.service.validate_output
        def interleave(*args):validate(*args);self.delete()
        with patch.object(self.service,'validate_output',side_effect=interleave):
            with self.assertRaises(KeyError):self.service.save(p['id'],{'revision':p['revision'],'output':p['output']})
        self.assertEqual(self.service.get(p['id']),p)

    def test_workspace_deletion_during_deposition_preflight_creates_no_assets(self):
        p=self.service.generate(self.request());validate=self.service.validate_output
        def interleave(*args):validate(*args);self.delete()
        with patch.object(self.service,'validate_output',side_effect=interleave):
            with self.assertRaises(KeyError):self.service.deposit(p['id'],{'revision':p['revision'],'item_ids':['ontology']})
        self.assertEqual(self.service.get(p['id']),p)

    def test_workspace_deletion_after_repair_preflight_creates_no_draft(self):
        p=self.failed();get=self.service.get;changed=False
        def interleave(identity):
            nonlocal changed
            result=get(identity)
            if not changed:changed=True;self.delete()
            return result
        with patch.object(self.service,'get',side_effect=interleave):
            with self.assertRaises(KeyError):self.service.repair(p['id'],{'revision':p['revision']})
        self.assertEqual(self.count('learning_proposals'),1)

    def test_deleted_scope_does_not_replay_accepted_generation_or_deposition(self):
        q=self.request();p=self.service.generate(q);p=self.service.deposit(p['id'],{'revision':p['revision'],'item_ids':['ontology']});self.delete()
        with self.assertRaises(KeyError):self.service.generate(q)
        with self.assertRaises(KeyError):self.service.deposit(p['id'],{'revision':p['revision'],'item_ids':['ontology']})

    def test_retrospective_facts_changed_after_preflight_are_not_sent_to_generation(self):
        run=self.app.create({'start':False,'scenario':'denied','grant':False})['run']['run_id'];self.app.runtime().run(run)
        q=self.request();q.update(purpose='retrospective',run_id=run);q.pop('source_refs')
        context=self.service.run_context;changed=False
        def interleave(identity):
            nonlocal changed
            result=context(identity)
            if not changed:
                changed=True;self.other.mutate(identity,'cancel')
                future=self.other.cancel_jobs[identity].get('future')
                if future:future.result(timeout=5)
            return result
        with patch.object(self.service,'run_context',side_effect=interleave),patch('agent_framework.learning.agent_generate',wraps=agent_generate) as generate:
            with self.assertRaises(ConfigConflict):self.service.generate(q)
            self.assertEqual(generate.call_count,0)
        self.assertEqual(self.count('learning_proposals'),0)

    def test_durable_stop_after_preflight_blocks_generation_without_a_local_job(self):
        run=self.app.create({'start':False,'scenario':'denied','grant':False})['run']['run_id'];self.app.runtime().run(run)
        q=self.request();q.update(purpose='retrospective',run_id=run);q.pop('source_refs')
        context=self.service.run_context;changed=False
        def interleave(identity):
            nonlocal changed
            result=context(identity)
            if not changed:
                changed=True;self.other.control_store.request_cancellation(self.app.tenant,identity)
            return result
        with patch.object(self.service,'run_context',side_effect=interleave),patch('agent_framework.learning.agent_generate',wraps=agent_generate) as generate:
            with self.assertRaises(ConfigConflict):self.service.generate(q)
            self.assertEqual(generate.call_count,0)
        self.assertEqual(self.count('learning_proposals'),0)

    def test_retrospective_cannot_start_while_a_durable_stop_awaits_dispatch(self):
        run=self.app.create({'start':False,'scenario':'denied','grant':False})['run']['run_id'];self.app.runtime().run(run)
        self.other.control_store.request_cancellation(self.app.tenant,run)
        self.assertIsNone(self.app.job(run))
        with self.assertRaises(ConfigConflict):self.service.run_context(run)

    def test_acceptance_transaction_serializes_another_connection_until_the_request_is_saved(self):
        assert_current=AgentRegistry.assert_submission_current;future=None;started=threading.Event()
        with ThreadPoolExecutor(max_workers=1) as pool:
            def update():
                started.set();return self.other.agents.archive(self.agent['id'],1)
            def checked(registry,db,agent):
                nonlocal future
                assert_current(registry,db,agent);future=pool.submit(update);self.assertTrue(started.wait(2))
                with self.assertRaises(TimeoutError):future.result(timeout=.05)
            def complete(app,agent,purpose,context,shape,consent,offline):
                self.assertTrue(future.result(timeout=5)['archived']);self.assertEqual(self.service.list()[0]['status'],'GENERATING')
                return offline(),{'model_calls':0,'usage':[]}
            with patch.object(AgentRegistry,'assert_submission_current',checked),patch('agent_framework.learning.agent_generate',side_effect=complete):p=self.service.generate(self.request())
        self.assertEqual(p['agent_revision'],1);self.assertEqual(p['status'],'DRAFT')

    def test_save_reply_keeps_its_accepted_content_when_another_writer_saves_after_commit(self):
        p=self.service.generate(self.request());output=deepcopy(p['output']);output['name']='本次审阅保存'
        other=Learning(self.other);transaction=self.service.store.transaction
        @contextmanager
        def commit_then_save():
            with transaction() as db:yield db
            next_output=deepcopy(output);next_output['name']='另一页面随后保存'
            other.save(p['id'],{'revision':p['revision']+1,'output':next_output})
        with patch.object(self.service.store,'transaction',commit_then_save):result=self.service.save(p['id'],{'revision':p['revision'],'output':output})
        self.assertEqual(result['revision'],p['revision']+1);self.assertEqual(result['output']['name'],'本次审阅保存')
        self.assertEqual(self.service.get(p['id'])['output']['name'],'另一页面随后保存')

    def test_repair_reply_keeps_its_new_draft_when_another_writer_edits_after_commit(self):
        p=self.failed();other=Learning(self.other);transaction=self.service.store.transaction
        @contextmanager
        def commit_then_edit():
            with transaction() as db:yield db
            repair=next(item for item in other.list() if item['id']!=p['id']);draft=other.get(repair['id']);output=deepcopy(draft['output']);output['name']='修复后另一页面编辑'
            other.save(draft['id'],{'revision':draft['revision'],'output':output})
        with patch.object(self.service.store,'transaction',commit_then_edit):result=self.service.repair(p['id'],{'revision':p['revision']})
        self.assertEqual(result['revision'],1);self.assertEqual(result['output']['name'],p['rejected_output']['name'])
        self.assertEqual(self.service.get(result['id'])['revision'],2)

    def test_http_acceptance_conflict_leaves_no_proposal_and_does_not_call_a_model(self):
        with patch.object(Application,'start_scheduler'),patch.object(Application,'start_conversation_dispatcher'):
            server=WebServer(('127.0.0.1',0),self.root)
        thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.02},daemon=True);thread.start()
        try:
            check=Learning._agent
            def interleave(service,data):
                result=check(service,data);self.other.agents.archive(self.agent['id'],1);return result
            connection=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
            try:
                with patch.object(Learning,'_agent',interleave),patch('agent_framework.learning.agent_generate',wraps=agent_generate) as generate:
                    connection.request('POST','/api/learning-proposals',json.dumps(self.request()),{'Content-Type':'application/json','X-Agent-Token':self.root.token,'X-Agent-Workspace':self.space['id']})
                    response=connection.getresponse();body=json.loads(response.read());self.assertEqual(response.status,409);self.assertIn('智能体',body['error']);self.assertEqual(generate.call_count,0)
            finally:connection.close()
            self.assertEqual(self.count('learning_proposals'),0)
        finally:server.shutdown();server.server_close();thread.join(2)

    def test_generation_reply_is_its_completed_output_even_if_another_writer_reviews_it_after_commit(self):
        other=Learning(self.other);transaction=self.service.store.transaction;commits=0
        @contextmanager
        def commit_then_review():
            nonlocal commits
            with transaction() as db:yield db
            commits+=1
            if commits==2:
                draft=other.get(other.list()[0]['id']);output=deepcopy(draft['output']);output['name']='另一页面随后审阅'
                other.save(draft['id'],{'revision':draft['revision'],'output':output})
        with patch.object(self.service.store,'transaction',commit_then_review):result=self.service.generate(self.request())
        self.assertEqual(result['revision'],2);self.assertNotEqual(result['output']['name'],'另一页面随后审阅')
        current=self.service.get(result['id']);self.assertEqual(current['revision'],3);self.assertEqual(current['output']['name'],'另一页面随后审阅')

    def test_deposition_receipt_does_not_depend_on_a_followup_read(self):
        p=self.service.generate(self.request());get=self.service.get;reads=0
        def read_once(identity):
            nonlocal reads
            reads+=1
            if reads>1:raise OSError('synthetic post-commit read unavailable')
            return get(identity)
        with patch.object(self.service,'get',side_effect=read_once):result=self.service.deposit(p['id'],{'revision':p['revision'],'item_ids':['ontology']})
        self.assertEqual(result['status'],'DEPOSITED');self.assertEqual(len(result['receipt']['assets']),1)
        self.assertEqual(self.service.get(p['id'])['receipt'],result['receipt'])
