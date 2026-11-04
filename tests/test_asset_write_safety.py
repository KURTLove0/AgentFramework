"""Manual asset writes fence registered workspace deletion and return their commit."""
from contextlib import contextmanager
from copy import deepcopy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_framework.contracts import TaskContract
from agent_framework.definitions import default_definition
from agent_framework.experience import ExperienceService
from agent_framework.knowledge import Access,Library
from agent_framework.learning import Learning
from agent_framework.ontology import activate,export_jsonld,revise
from agent_framework.ontology_evidence import assertions,save as save_evidence
from agent_framework.runtime import Runtime
from agent_framework.web import Application,WebServer


def body(kind='KNOWLEDGE',**updates):
    return {'kind':kind,'title':'写入保护资料','content':{'language':'zh'} if kind=='PREFERENCE' else {'text':'检查订单状态，保留来源证据。'},**updates}


class AssetWriteSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Application(self.tmp.name);self.addCleanup(self.root.close)
        self.space=self.root.workspaces.save({'name':'资料写入空间','business':'测试','scenario':'资产保护','description':'','revision':0})
        self.app=self.root.scoped(self.space['id']);self.lib=self.app.library();self.access=self.app.library_access()
        other=Application(self.tmp.name);self.addCleanup(other.close);self.other=other.scoped(self.space['id']);self.other_lib=self.other.library()

    def delete(self):return self.root.workspaces.lifecycle(self.space['id'],1,True)

    def dump(self):
        with self.lib.store.connect() as db:
            return {table:[tuple(row) for row in db.execute('SELECT * FROM '+table+' ORDER BY rowid')]
                    for table in ['asset_versions','asset_search','asset_events','ontology_activation','ontology_evidence','experience_evaluations']}

    @contextmanager
    def before_write(self,action):
        transaction=self.lib.store.transaction
        @contextmanager
        def interleave():
            action()
            with transaction() as db:yield db
        with patch.object(self.lib.store,'transaction',interleave):yield

    @contextmanager
    def after_write(self,action):
        transaction=self.lib.store.transaction
        @contextmanager
        def interleave():
            with transaction() as db:yield db
            action()
        with patch.object(self.lib.store,'transaction',interleave):yield

    def publish(self,asset,library=None):
        library=library or self.lib;library.transition(self.access,asset['ref'],'REVIEW')
        return library.transition(self.access,asset['ref'],'PUBLISHED')

    def ontology(self,published=False):
        source=self.publish(self.lib.create(self.access,body()))
        agent=self.app.agents.save({'name':'资料保护助手','description':'离线生成','runtime':'mock','model':'builtin','options':{},'prompt':'保留来源',
            'skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('资料保护助手','general-assistant@1.0.0')})
        service=Learning(self.app);proposal=service.generate({'request_id':'asset-write-safety','purpose':'ontology','source_refs':[source['ref']],
            'agent_id':agent['id'],'agent_revision':1})
        result=service.deposit(proposal['id'],{'revision':proposal['revision'],'item_ids':['ontology']})
        asset=self.lib.get(self.access,result['receipt']['assets'][0]['ref'])
        return self.publish(asset) if published else asset

    def versions(self):
        first=self.ontology(True);second=self.publish(revise(self.lib,self.access,first['ref'],{'content':deepcopy(first['content'])}))
        return first,second

    def evidence(self,asset,revision=0,reviewed=False):
        item=assertions(asset['content'])[0]
        return {'path':item['path'],'source_ref':item['source_refs'][0],'quote':'检查订单状态','reviewed':reviewed,'revision':revision}

    def candidate(self):
        run=self.app.create({'start':False,'runtime':'mock','grant':True})['run']['run_id'];self.app.runtime().run(run)
        service=ExperienceService(self.lib.store);return service,next(a for a in service.list(self.access) if a['source_uri']=='local:episode/'+run)

    def test_deleted_workspace_rejects_all_manual_asset_kinds_without_index_or_audit_changes(self):
        self.delete();before=self.dump()
        for kind in ['KNOWLEDGE','PREFERENCE','MEMORY','CAPABILITY']:
            with self.subTest(kind=kind),self.assertRaises(KeyError):self.lib.create(self.access,body(kind))
        self.assertEqual(self.dump(),before)

    def test_deletion_before_create_transaction_rejects_the_entire_write(self):
        before=self.dump()
        with self.before_write(self.delete):
            with self.assertRaises(KeyError):self.lib.create(self.access,body())
        self.assertEqual(self.dump(),before)

    def test_deleted_workspace_rejects_new_asset_versions(self):
        asset=self.lib.create(self.access,body());self.delete();before=self.dump()
        with self.assertRaises(KeyError):self.lib.create(self.access,body(id=asset['id'],supersedes=asset['ref']))
        self.assertEqual(self.dump(),before)

    def test_deleted_workspace_rejects_review_publish_and_withdraw(self):
        draft=self.lib.create(self.access,body());review=self.lib.create(self.access,body());self.lib.transition(self.access,review['ref'],'REVIEW')
        published=self.publish(self.lib.create(self.access,body()));self.delete();before=self.dump()
        for asset,target in [(draft,'REVIEW'),(review,'PUBLISHED'),(published,'WITHDRAWN')]:
            with self.subTest(target=target),self.assertRaises(KeyError):self.lib.transition(self.access,asset['ref'],target)
        self.assertEqual(self.dump(),before)

    def test_deletion_between_transition_preflight_and_commit_does_not_change_status(self):
        asset=self.lib.create(self.access,body());before=self.dump()
        with self.before_write(self.delete):
            with self.assertRaises(KeyError):self.lib.transition(self.access,asset['ref'],'REVIEW')
        self.assertEqual(self.dump(),before)

    def test_deleted_workspace_cannot_bootstrap_a_new_builtin_asset(self):
        self.delete();before=self.dump()
        with self.assertRaises(KeyError):self.lib.bootstrap(self.access)
        self.assertEqual(self.dump(),before)

    def test_deleted_workspace_cannot_seed_knowledge_during_a_rejected_cli_submission(self):
        self.delete();before=self.dump()
        with self.assertRaises(KeyError):Runtime(self.tmp.name).submit(task=TaskContract(project_id=self.space['project_id'],principal=self.app.principal))
        self.assertEqual(self.dump(),before)

    def test_deleted_workspace_rejects_ontology_revision_without_partial_assets(self):
        asset=self.ontology(True);self.delete();before=self.dump()
        with self.assertRaises(KeyError):revise(self.lib,self.access,asset['ref'],{'content':deepcopy(asset['content'])})
        self.assertEqual(self.dump(),before)

    def test_deletion_after_ontology_revision_validation_still_blocks_the_commit(self):
        asset=self.ontology(True);before=self.dump()
        with self.before_write(self.delete):
            with self.assertRaises(KeyError):revise(self.lib,self.access,asset['ref'],{'content':deepcopy(asset['content'])})
        self.assertEqual(self.dump(),before)

    def test_deleted_workspace_cannot_change_the_active_ontology(self):
        first,second=self.versions();self.delete();before=self.dump()
        with self.assertRaises(KeyError):activate(self.lib,self.access,first['ref'],{'expected_active_ref':second['ref']})
        self.assertEqual(self.dump(),before)

    def test_deletion_after_activation_preflight_cannot_change_the_active_ontology(self):
        first,second=self.versions();before=self.dump()
        with self.before_write(self.delete):
            with self.assertRaises(KeyError):activate(self.lib,self.access,first['ref'],{'expected_active_ref':second['ref']})
        self.assertEqual(self.dump(),before)

    def test_existing_evidence_cannot_be_overwritten_after_workspace_deletion(self):
        asset=self.ontology(True);save_evidence(self.lib,self.access,asset['ref'],self.evidence(asset));self.delete();before=self.dump()
        with self.assertRaises(KeyError):save_evidence(self.lib,self.access,asset['ref'],self.evidence(asset,1,True))
        self.assertEqual(self.dump(),before)

    def test_deletion_after_evidence_preflight_rejects_the_quote_and_audit(self):
        asset=self.ontology(True);before=self.dump()
        with self.before_write(self.delete):
            with self.assertRaises(KeyError):save_evidence(self.lib,self.access,asset['ref'],self.evidence(asset))
        self.assertEqual(self.dump(),before)

    def test_deleted_workspace_rejects_evaluation_before_starting_offline_replays(self):
        service,candidate=self.candidate();self.delete();before=self.dump()
        with patch('agent_framework.experience.tempfile.TemporaryDirectory',side_effect=AssertionError('Offline replay started')):
            with self.assertRaises(KeyError):service.evaluate(self.access,candidate['ref'])
        self.assertEqual(self.dump(),before)

    def test_deletion_during_offline_evaluation_prevents_its_final_write(self):
        service,candidate=self.candidate();before=self.dump()
        with self.before_write(self.delete):
            with self.assertRaises(KeyError):service.evaluate(self.access,candidate['ref'])
        self.assertEqual(self.dump(),before)

    def test_create_reply_is_the_accepted_draft_even_if_another_writer_publishes_it(self):
        identity='asset-create-receipt'
        with self.after_write(lambda:self.publish(self.other_lib.get(self.access,identity+'@1'),self.other_lib)):
            result=self.lib.create(self.access,body(id=identity))
        self.assertEqual(result['status'],'DRAFT');self.assertEqual(self.lib.get(self.access,result['ref'])['status'],'PUBLISHED')

    def test_review_reply_does_not_include_another_writers_later_publication(self):
        asset=self.lib.create(self.access,body())
        with self.after_write(lambda:self.other_lib.transition(self.access,asset['ref'],'PUBLISHED')):
            result=self.lib.transition(self.access,asset['ref'],'REVIEW')
        self.assertEqual(result['status'],'REVIEW');self.assertEqual(self.lib.get(self.access,asset['ref'])['status'],'PUBLISHED')

    def test_revision_reply_is_its_accepted_draft_not_a_later_publication(self):
        asset=self.ontology(True);next_ref=asset['id']+'@2'
        with self.after_write(lambda:self.publish(self.other_lib.get(self.access,next_ref),self.other_lib)):
            result=revise(self.lib,self.access,asset['ref'],{'content':deepcopy(asset['content'])})
        self.assertEqual(result['status'],'DRAFT');self.assertEqual(self.lib.get(self.access,next_ref)['status'],'PUBLISHED')

    def test_activation_reply_describes_its_transaction_even_if_another_writer_switches_back(self):
        first,second=self.versions()
        with self.after_write(lambda:activate(self.other_lib,self.access,second['ref'],{'expected_active_ref':first['ref']})):
            result=activate(self.lib,self.access,first['ref'],{'expected_active_ref':second['ref']})
        self.assertEqual(result['active_ref'],first['ref']);self.assertTrue(result['usable'])
        self.assertEqual(self.lib.active_ontology_ref(self.access,first['id']),second['ref'])

    def test_deleted_workspace_history_is_readable_and_restoration_allows_new_writes(self):
        asset=self.ontology(True);before=export_jsonld(asset);self.delete()
        self.assertEqual(export_jsonld(self.lib.get(self.access,asset['ref'])),before)
        self.assertEqual(self.lib.get(self.access,asset['ref']),asset)
        self.root.workspaces.lifecycle(self.space['id'],2,False)
        self.assertEqual(self.lib.create(self.access,body())['status'],'DRAFT')

    def test_unregistered_cli_projects_and_other_tenants_are_not_blocked(self):
        self.delete()
        for access in [Access(self.access.tenant,self.access.principal,'project-unregistered',roles=self.access.roles),
                       Access('tenant-other',self.access.principal,self.access.project,roles=self.access.roles)]:
            with self.subTest(tenant=access.tenant,project=access.project):self.assertEqual(self.lib.create(access,body())['status'],'DRAFT')
        with tempfile.TemporaryDirectory() as temporary:
            library=Library(Path(temporary)/'standalone.sqlite3');asset=library.create(self.access,body())
            self.assertEqual(library.transition(self.access,asset['ref'],'REVIEW')['status'],'REVIEW')

    def test_http_stale_scoped_request_is_rejected_after_space_deletion(self):
        with patch.object(Application,'start_scheduler'),patch.object(Application,'start_conversation_dispatcher'):
            server=WebServer(('127.0.0.1',0),self.root)
        thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.02},daemon=True);thread.start()
        create=Library.create;before=self.dump()
        def interleave(library,access,data):self.delete();return create(library,access,data)
        try:
            connection=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
            try:
                with patch.object(Library,'create',interleave):
                    connection.request('POST','/api/knowledge/assets',json.dumps(body()),{'Content-Type':'application/json','X-Agent-Token':self.root.token,'X-Agent-Workspace':self.space['id']})
                    response=connection.getresponse();reply=json.loads(response.read());self.assertEqual(response.status,404)
                    self.assertEqual(reply['error'],'当前工作空间不存在或已删除，请在工作空间管理中检查或恢复后重试')
                connection.request('GET','/api/library',headers={'X-Agent-Workspace':self.space['id']})
                response=connection.getresponse();self.assertEqual(response.status,404)
                self.assertIn('工作空间',json.loads(response.read())['error'])
                connection.request('GET','/api/runs/run-missing')
                response=connection.getresponse();self.assertEqual(response.status,404)
                self.assertEqual(json.loads(response.read())['error'],'未找到该运行')
            finally:connection.close()
            self.assertEqual(self.dump(),before)
        finally:server.shutdown();server.server_close();thread.join(2)
