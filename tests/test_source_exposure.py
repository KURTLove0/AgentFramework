"""Uncited replies retain dependencies on knowledge supplied to their model turn."""
from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical,digest
from agent_framework import history_dependencies
from agent_framework.definitions import default_definition
from agent_framework.knowledge import Library
from agent_framework.read_proxy import ReadCapabilityProxy
from tests import test_task_conversations as fixtures


class SourceExposureTests(unittest.TestCase):
    start=fixtures.TaskConversationTests.start
    wait=fixtures.TaskConversationTests.wait
    send=fixtures.TaskConversationTests.send

    def setUp(self):
        fixtures.TaskConversationTests.setUp(self)
        original=self.fixture.generate
        def capture(transport,*args):
            self.model_transport=transport
            return original(transport,*args)
        self.fixture.generate=capture

    def prepare(self,mode):
        library=Library(self.app.control_store);owner=self.app.library_access()
        source=library.create(owner,{'kind':'KNOWLEDGE','title':'SEARCH_PRIVATE_SENTINEL nativeonlyneedle' if mode!='context' else '会议规则',
            'content':{'text':'CONTEXT_PRIVATE_SENTINEL：会议规则。' if mode=='context' else 'NATIVE_PRIVATE_SENTINEL：业务详情。'}})
        library.transition(owner,source['ref'],'REVIEW');library.transition(owner,source['ref'],'PUBLISHED')
        if mode!='context':
            definition=default_definition('读取助手','general-assistant@1.0.0')
            definition['native_read_refs']=['knowledge.search@1.0.0','knowledge.read@1.0.0']
            self.agent=self.app.agents.save({'name':'读取助手','description':'隔离读取验收','runtime':'codex','model':'fixture',
                'options':{'timeout':5,'max_attempts':2,'reasoning_effort':'low'},'prompt':'按需读取资料。','skills':[],'mcp_servers':[],
                'revision':0,'definition':definition})
        def reply(request,value):
            context=request['context']
            if context['task']['conversation_context']['turn']==1:
                if mode=='context':
                    doc=next(d for d in context['knowledge'] if d['ref']==source['ref']);text=doc['content']['text']
                else:
                    self.assertFalse(any(d['ref']==source['ref'] for d in context['knowledge']))
                    server=self.model_transport.governed_profile['mcp_servers'][0];token=server['args'][-1];proxy=ReadCapabilityProxy(self.temp.name)
                    hits=proxy.call(token,'knowledge_search',{'project_id':owner.project,'query':'nativeonlyneedle'})
                    text=hits['data']['hits'][0]['title']
                    if mode=='read':
                        observed=proxy.call(token,'knowledge_read',{'project_id':owner.project,'asset_refs':[source['ref']]})
                        text=observed['data']['documents'][0]['content']['text']
                value['result']['content']=text;value['result']['citations']=[]
            else:value['result']['content']='请使用当前有效资料。'
            return value
        self.fixture.reply=reply
        root=self.start('会议规则' if mode=='context' else '执行一次读取');first=self.wait(root,status='SUCCEEDED')
        self.assertEqual(first['run']['report']['citations'],[])
        return root,library,owner,source

    def withdrawn(self,mode,sentinel):
        root,library,owner,source=self.prepare(mode);library.transition(owner,source['ref'],'WITHDRAWN')
        self.send(root,'继续处理');self.wait(root,2,'SUCCEEDED')
        self.assertNotIn(sentinel,canonical(self.fixture.requests[-1]['context']))
        self.assertIn('来源已失效',canonical(self.fixture.requests[-1]['context']))
        self.assertIn(sentinel,self.app.detail(root)['run']['report']['content'])

    def test_uncited_context_knowledge_is_revalidated_after_withdrawal(self):
        self.withdrawn('context','CONTEXT_PRIVATE_SENTINEL')

    def test_uncited_native_read_is_revalidated_after_withdrawal(self):
        self.withdrawn('read','NATIVE_PRIVATE_SENTINEL')

    def test_uncited_native_search_result_is_revalidated_after_withdrawal(self):
        self.withdrawn('search','SEARCH_PRIVATE_SENTINEL')

    def test_live_native_sources_are_deduplicated_without_inventing_citations(self):
        root,_,_,source=self.prepare('read');self.send(root,'继续处理');self.wait(root,2,'SUCCEEDED')
        message=next(m for m in self.fixture.requests[-1]['context']['task']['conversation_context']['messages'] if m['role']=='assistant')
        self.assertIn('NATIVE_PRIVATE_SENTINEL',message['content']);self.assertEqual(message['citations'],[])
        self.assertEqual(message['source_dependencies'],[{'asset_ref':source['ref'],'content_hash':source['content_hash']}])

    def test_withdrawal_after_queueing_rechecks_uncited_source_and_preserves_frozen_task(self):
        root,library,owner,source=self.prepare('context')
        with patch.object(self.app,'schedule'):pending=self.send(root,'继续处理')
        child=pending['conversation']['active_run_id'];frozen=deepcopy(self.app.control_store.load(self.app.tenant,child)['task']['conversation_context'])
        library.transition(owner,source['ref'],'WITHDRAWN');self.app.runtime().run(child)
        self.assertNotIn('CONTEXT_PRIVATE_SENTINEL',canonical(self.fixture.requests[-1]['context']))
        self.assertEqual(self.app.control_store.load(self.app.tenant,child)['task']['conversation_context'],frozen)

    def unexposed(self,large=False):
        library=Library(self.app.control_store);owner=self.app.library_access()
        source=library.create(owner,{'kind':'KNOWLEDGE','title':'unselectedneedle','content':{'text':'unselectedneedle '+('x'*14000 if large else 'unused')}})
        library.transition(owner,source['ref'],'REVIEW');library.transition(owner,source['ref'],'PUBLISHED')
        def reply(request,value):
            self.assertFalse(any(d['ref']==source['ref'] for d in request['context']['knowledge']))
            value['result']['content']='UNRELATED_REPLY';return value
        self.fixture.reply=reply
        root=self.start('unselectedneedle' if large else '仅整理用户提供的要求');self.wait(root,status='SUCCEEDED')
        return root,library,owner,source

    def test_source_excluded_by_context_budget_does_not_redact_an_unrelated_reply(self):
        root,library,owner,source=self.unexposed(large=True)
        self.assertTrue(any(e['ref']==source['ref'] and e['reason']=='optional-context-budget' for m in self.app.control_store.contexts(self.app.tenant,root) for e in m['excluded']))
        library.transition(owner,source['ref'],'WITHDRAWN');self.send(root,'继续');self.wait(root,2,'SUCCEEDED')
        self.assertIn('UNRELATED_REPLY',canonical(self.fixture.requests[-1]['context']['task']['conversation_context']))

    def test_prepared_rejected_and_unreferenced_evidence_are_not_treated_as_delivered(self):
        root,library,owner,source=self.unexposed()
        data={'tenant_id':owner.tenant,'project_id':owner.project,'documents':[{'ref':source['ref'],'content_hash':source['content_hash'],'content':source['content']}]}
        evidence={'id':'orphan-evidence','tenant_id':owner.tenant,'run_id':root,'source':'knowledge.read@1.0.0','data':data,'content_hash':digest(data)}
        with self.app.control_store.transaction() as db:
            db.execute('INSERT INTO evidence VALUES(?,?,?,?)',(owner.tenant,root,evidence['id'],canonical(evidence)))
            for status in ('PREPARED','REJECTED'):
                ident='unused-'+status;record={'id':ident,'status':status,'ref':'knowledge.read@1.0.0','evidence_ref':evidence['id']}
                db.execute('INSERT INTO native_reads VALUES(?,?,?,?)',(owner.tenant,root,ident,canonical(record)))
        library.transition(owner,source['ref'],'WITHDRAWN');self.send(root,'继续');self.wait(root,2,'SUCCEEDED')
        self.assertIn('UNRELATED_REPLY',canonical(self.fixture.requests[-1]['context']['task']['conversation_context']))

    def read_evidence(self,root):
        return next(e for e in self.app.control_store.evidence(self.app.control_store.load(self.app.tenant,root)).values() if e['source']=='knowledge.read@1.0.0')

    def write_evidence(self,root,evidence):
        with self.app.control_store.transaction() as db:
            db.execute('UPDATE evidence SET data=? WHERE tenant_id=? AND run_id=? AND id=?',(canonical(evidence),self.app.tenant,root,evidence['id']))

    def assert_unverifiable(self,root):
        self.send(root,'继续');self.wait(root,2,'SUCCEEDED')
        context=canonical(self.fixture.requests[-1]['context'])
        self.assertNotIn('NATIVE_PRIVATE_SENTINEL',context);self.assertIn('历史来源不可核对',context)

    def test_missing_verified_read_evidence_withholds_uncited_body(self):
        root,_,_,_=self.prepare('read');evidence=self.read_evidence(root)
        with self.app.control_store.transaction() as db:
            db.execute('DELETE FROM evidence WHERE tenant_id=? AND run_id=? AND id=?',(self.app.tenant,root,evidence['id']))
        self.assert_unverifiable(root)

    def test_tampered_read_content_is_not_trusted(self):
        root,_,_,_=self.prepare('read');evidence=self.read_evidence(root)
        evidence['data']['documents'][0]['content']['text']='changed';self.write_evidence(root,evidence)
        self.assert_unverifiable(root)

    def test_read_scope_mismatch_is_rejected_with_recomputed_hash(self):
        root,_,_,_=self.prepare('read');evidence=self.read_evidence(root)
        evidence['data']['project_id']='other-project';evidence['content_hash']=digest(evidence['data']);self.write_evidence(root,evidence)
        self.assert_unverifiable(root)

    def manifest_evidence(self,root,items):
        with self.app.control_store.transaction() as db:
            for row in db.execute('SELECT id,data FROM context_manifests WHERE tenant=? AND run_id=?',(self.app.tenant,root)).fetchall():
                manifest=json.loads(row['data']);manifest['evidence']=items;manifest['hash']=digest({k:v for k,v in manifest.items() if k!='hash'})
                db.execute('UPDATE context_manifests SET data=? WHERE tenant=? AND run_id=? AND id=?',(canonical(manifest),self.app.tenant,root,row['id']))

    def test_context_manifest_evidence_can_prove_exposure_without_a_native_receipt(self):
        root,library,owner,source=self.prepare('read');evidence=self.read_evidence(root)
        self.manifest_evidence(root,[{'ref':evidence['id'],'content_hash':evidence['content_hash']}])
        with self.app.control_store.transaction() as db:db.execute('DELETE FROM native_reads WHERE tenant_id=? AND run_id=?',(self.app.tenant,root))
        library.transition(owner,source['ref'],'WITHDRAWN');self.send(root,'继续');self.wait(root,2,'SUCCEEDED')
        context=canonical(self.fixture.requests[-1]['context'])
        self.assertNotIn('NATIVE_PRIVATE_SENTINEL',context);self.assertIn('来源已失效',context)

    def test_manifest_evidence_hash_must_agree_with_native_read_proof(self):
        root,_,_,_=self.prepare('read');evidence=self.read_evidence(root)
        self.manifest_evidence(root,[{'ref':evidence['id'],'content_hash':'different'}]);self.assert_unverifiable(root)

    def test_evidence_and_checkpoint_reads_share_the_same_snapshot(self):
        root,_,_,source=self.prepare('read');evidence=self.read_evidence(root);original=history_dependencies.exposed_sources;changed=[]
        def change_after_checkpoints(*args):
            if not changed:
                changed.append(True);evidence['content_hash']='different';self.write_evidence(root,evidence)
            return original(*args)
        state=self.service.root(root);rows=self.service.rows(state)
        with patch.object(history_dependencies,'exposed_sources',side_effect=change_after_checkpoints):history=self.service.history(state,rows,2)
        self.assertEqual(history['messages'][-1]['source_dependencies'][0]['asset_ref'],source['ref'])
        self.assertIn('历史来源不可核对',canonical(self.service.history(state,rows,2)))


if __name__=='__main__':unittest.main()
