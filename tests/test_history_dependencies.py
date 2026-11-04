"""Withdrawn cited history cannot re-enter a model through an uncited rewrite."""
from copy import deepcopy
import json
import unittest
from unittest.mock import Mock,patch

from agent_framework.contracts import TaskContract,canonical,digest
from agent_framework.conversation_history import HistoryWindow
from agent_framework import history_dependencies
from agent_framework.task_conversations import refresh_history
from tests import test_history_context as history_fixtures
from tests import test_task_conversations as fixtures


class HistoryDependencyTests(unittest.TestCase):
    setUp=fixtures.TaskConversationTests.setUp
    start=fixtures.TaskConversationTests.start
    wait=fixtures.TaskConversationTests.wait
    send=fixtures.TaskConversationTests.send
    cited_reply=history_fixtures.HistoryContextIntegrationTests.cited_reply

    def prepare_rewrite(self):
        library,owner,source=self.cited_reply('SOURCE_PRIVATE_SENTINEL：会议规则。')
        cited=self.fixture.reply
        def reply(request,value):
            value=cited(request,value)
            turn=request['context']['task']['conversation_context']['turn']
            if turn==1:value['result']['content']='SOURCE_PRIVATE_SENTINEL 的原始结论。'
            elif turn==2:value['result']['content']='PARAPHRASED_PRIVATE_SENTINEL：按前文整理后的结论。'
            else:value['result']['content']='请依据当前有效资料继续。'
            return value
        self.fixture.reply=reply
        root=self.start('会议规则');self.wait(root,status='SUCCEEDED')
        self.send(root,'把上述内容换一种说法');self.wait(root,2,'SUCCEEDED')
        return root,library,owner,source

    def assert_rewrite_hidden(self,root):
        context=self.fixture.requests[-1]['context']
        self.assertNotIn('SOURCE_PRIVATE_SENTINEL',canonical(context))
        self.assertNotIn('PARAPHRASED_PRIVATE_SENTINEL',canonical(context))
        self.assertIn('来源已失效',canonical(context))
        turns=self.app.detail(root)['conversation']['turns']
        self.assertIn('PARAPHRASED_PRIVATE_SENTINEL',turns[1]['reply']['content'])
        self.assertEqual(turns[1]['reply']['citations'],[])

    def test_withdrawn_source_hides_uncited_rewrite_from_next_model_input(self):
        root,library,owner,source=self.prepare_rewrite()
        library.transition(owner,source['ref'],'WITHDRAWN')
        self.send(root,'请继续整理','third');self.wait(root,3,'SUCCEEDED')
        self.assert_rewrite_hidden(root)

    def test_queued_turn_revalidates_inherited_source_without_rewriting_frozen_history(self):
        root,library,owner,source=self.prepare_rewrite()
        with patch.object(self.app,'schedule'):pending=self.send(root,'请继续整理','third')
        child=pending['conversation']['active_run_id'];frozen=deepcopy(self.app.control_store.load(self.app.tenant,child)['task']['conversation_context'])
        library.transition(owner,source['ref'],'WITHDRAWN');self.app.runtime().run(child)
        self.assert_rewrite_hidden(root)
        self.assertEqual(self.app.control_store.load(self.app.tenant,child)['task']['conversation_context'],frozen)

    def rewrite_manifests(self,run_id,change):
        with self.app.control_store.transaction() as db:
            for row in db.execute('SELECT id,data FROM context_manifests WHERE tenant=? AND run_id=?',(self.app.tenant,run_id)).fetchall():
                manifest=json.loads(row['data']);change(manifest)
                db.execute('UPDATE context_manifests SET data=? WHERE tenant=? AND run_id=? AND id=?',(canonical(manifest),self.app.tenant,run_id,row['id']))

    def legacy(self,root):
        for turn in self.app.detail(root)['conversation']['turns']:
            def strip(manifest):
                manifest.pop('conversation_sources',None);manifest.pop('conversation_context_hash',None)
                manifest['hash']=digest({k:v for k,v in manifest.items() if k!='hash'})
            self.rewrite_manifests(turn['run_id'],strip)
            with self.app.control_store.transaction() as db:
                run=self.app.control_store.load(self.app.tenant,turn['run_id'],db=db)
                for message in run['task']['conversation_context']['messages']:message.pop('source_dependencies',None)
                db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(run),self.app.tenant,turn['run_id']))

    def test_valid_inherited_source_preserves_uncited_body_without_inventing_a_citation(self):
        root,_,_,source=self.prepare_rewrite()
        self.send(root,'请继续整理','third');self.wait(root,3,'SUCCEEDED')
        context=self.fixture.requests[-1]['context']['task']['conversation_context']
        rewritten=next(m for m in context['messages'] if m['turn']==2 and m['role']=='assistant')
        self.assertIn('PARAPHRASED_PRIVATE_SENTINEL',rewritten['content']);self.assertEqual(rewritten['citations'],[])
        self.assertEqual(rewritten['source_dependencies'],[{'asset_ref':source['ref'],'content_hash':source['content_hash']}])

    def test_dependency_survives_multiple_rewrites_when_original_citation_leaves_window(self):
        root,library,owner,source=self.prepare_rewrite()
        original=self.fixture.reply
        def reply(request,value):
            value=original(request,value)
            if request['context']['task']['conversation_context']['turn']==3:value['result']['content']='SECOND_REWRITE_PRIVATE_SENTINEL'
            return value
        self.fixture.reply=reply
        with patch('agent_framework.task_conversations.HistoryWindow',side_effect=lambda size:HistoryWindow(size,max_messages=2)):
            self.send(root,'再改写一次','third');self.wait(root,3,'SUCCEEDED')
            third_context=self.fixture.requests[-1]['context']['task']['conversation_context']
            self.assertEqual([m['turn'] for m in third_context['messages']],[2,2])
            library.transition(owner,source['ref'],'WITHDRAWN')
            self.send(root,'继续','fourth');self.wait(root,4,'SUCCEEDED')
        context=self.fixture.requests[-1]['context']['task']['conversation_context']
        self.assertEqual([m['turn'] for m in context['messages']],[3,3])
        self.assertNotIn('SECOND_REWRITE_PRIVATE_SENTINEL',canonical(context));self.assertIn('来源已失效',canonical(context))

    def test_old_manifests_recover_transitive_dependencies_from_frozen_history(self):
        root,library,owner,source=self.prepare_rewrite()
        with patch('agent_framework.task_conversations.HistoryWindow',side_effect=lambda size:HistoryWindow(size,max_messages=2)):
            self.send(root,'再改写一次','third');self.wait(root,3,'SUCCEEDED')
        self.legacy(root);library.transition(owner,source['ref'],'WITHDRAWN')
        with patch('agent_framework.task_conversations.HistoryWindow',side_effect=lambda size:HistoryWindow(size,max_messages=2)):
            self.send(root,'继续','fourth');self.wait(root,4,'SUCCEEDED')
        history=self.fixture.requests[-1]['context']['task']['conversation_context']
        self.assertEqual([m['turn'] for m in history['messages']],[3,3]);self.assertIn('来源已失效',canonical(history))

    def test_redacted_sources_do_not_taint_later_source_free_reply_in_old_or_new_records(self):
        root,library,owner,source=self.prepare_rewrite();library.transition(owner,source['ref'],'WITHDRAWN')
        self.send(root,'继续','third');third=self.wait(root,3,'SUCCEEDED')
        manifest=third['conversation']['current']['context_manifests'][-1]
        self.assertEqual(manifest['conversation_sources'],[])
        self.assertIn(2,manifest['conversation_redactions'])
        self.legacy(root)
        self.send(root,'继续下一步','fourth');self.wait(root,4,'SUCCEEDED')
        messages=self.fixture.requests[-1]['context']['task']['conversation_context']['messages']
        safe=next(m for m in messages if m['turn']==3 and m['role']=='assistant')
        self.assertEqual(safe['content'],'请依据当前有效资料继续。');self.assertFalse(safe.get('source_dependencies'))

    def test_tampered_empty_dependency_manifest_cannot_hide_provenance(self):
        root,_,_,_=self.prepare_rewrite();child=self.app.detail(root)['conversation']['active_run_id']
        self.rewrite_manifests(child,lambda manifest:manifest.update(conversation_sources=[]))
        self.send(root,'继续','third');self.wait(root,3,'SUCCEEDED')
        history=self.fixture.requests[-1]['context']['task']['conversation_context']
        self.assertNotIn('PARAPHRASED_PRIVATE_SENTINEL',canonical(history));self.assertIn('历史来源不可核对',canonical(history))

    def test_scope_mismatch_is_rejected_even_when_manifest_hash_is_consistent(self):
        root,_,_,_=self.prepare_rewrite();child=self.app.detail(root)['conversation']['active_run_id']
        def forge(manifest):
            manifest['scope']['principal']='another-person';manifest['hash']=digest({k:v for k,v in manifest.items() if k!='hash'})
        self.rewrite_manifests(child,forge)
        self.send(root,'继续','third');self.wait(root,3,'SUCCEEDED')
        self.assertNotIn('PARAPHRASED_PRIVATE_SENTINEL',canonical(self.fixture.requests[-1]['context']))

    def test_dependency_reads_share_checkpoint_snapshot(self):
        root,_,_,source=self.prepare_rewrite();child=self.app.detail(root)['conversation']['active_run_id']
        original=history_dependencies.dependencies;changed=[]
        def change_after_checkpoints(*args,**kwargs):
            if not changed:
                changed.append(True);self.rewrite_manifests(child,lambda manifest:manifest.update(conversation_sources=[]))
            return original(*args,**kwargs)
        state=self.service.root(root);rows=self.service.rows(state)
        with patch.object(history_dependencies,'dependencies',side_effect=change_after_checkpoints):history=self.service.history(state,rows,3)
        message=next(m for m in history['messages'] if m['turn']==2 and m['role']=='assistant')
        self.assertEqual(message['source_dependencies'][0]['asset_ref'],source['ref'])
        next_history=self.service.history(state,rows,3)
        self.assertNotIn('PARAPHRASED_PRIVATE_SENTINEL',canonical(next_history))

    def test_old_source_chain_crosses_batches_after_ancestor_leaves_visible_history(self):
        root,library,owner,source=self.prepare_rewrite();state=self.service.root(root);rows=self.service.rows(state)
        previous=root
        with self.app.control_store.transaction() as db:
            for offset in range(205):
                identity='legacy-dependency-'+str(offset);number=offset+3;run=deepcopy(state)
                message={'role':'assistant','content':'先前结论','run_id':previous,'turn':number-1,'status':'SUCCEEDED',
                         'citations':[{'asset_ref':source['ref'],'content_hash':source['content_hash']}] if offset==0 else []}
                run['run_id']=identity;run['report']={'content':'继承结论','citations':[]}
                run['task']['conversation_context']={'task_id':root,'turn':number,'goal':state['task']['goal'],
                    'messages':[message],'history_hash':digest([message]),'omitted_messages':number-2}
                db.execute('INSERT INTO runs(tenant_id,id,version,state) VALUES(?,?,?,?)',(self.app.tenant,identity,run['version'],canonical(run)))
                rows.append({'number':number,'run_id':identity,'state':'RUNNING','content':'继续','created':state['created_at']})
                previous=identity
        with patch('agent_framework.task_conversations.HistoryWindow',side_effect=lambda size:HistoryWindow(size,max_messages=2)):
            history=self.service.history(state,rows,208)
        self.assertEqual(history['messages'][-1]['run_id'],previous)
        self.assertEqual(history['messages'][-1]['source_dependencies'],[{'asset_ref':source['ref'],'content_hash':source['content_hash']}])
        library.transition(owner,source['ref'],'WITHDRAWN');actual,_,_=refresh_history(library,owner,history)
        self.assertNotIn('继承结论',canonical(actual));self.assertIn('来源已失效',canonical(actual))

    def test_cycle_in_old_history_is_withheld_instead_of_recursive_failure(self):
        root,_,_,_=self.prepare_rewrite();self.legacy(root);child=self.app.detail(root)['conversation']['active_run_id']
        with self.app.control_store.transaction() as db:
            run=self.app.control_store.load(self.app.tenant,child,db=db)
            run['task']['conversation_context']['messages'][1]['run_id']=child
            db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(run),self.app.tenant,child))
        state=self.service.root(root);history=self.service.history(state,self.service.rows(state),3)
        self.assertNotIn('PARAPHRASED_PRIVATE_SENTINEL',canonical(history));self.assertIn('历史来源不可核对',canonical(history))


class DependencyRefreshTests(unittest.TestCase):
    def context(self):
        return {'task_id':'task','turn':2,'goal':'目标','history_hash':'frozen','omitted_messages':0,'messages':[
            {'role':'assistant','turn':1,'run_id':'run','status':'SUCCEEDED','content':'inherited-private-text','citations':[],
             'source_dependencies':[{'asset_ref':'source@1','content_hash':'original'}]}]}

    def test_dependency_only_messages_are_revalidated_without_mutating_frozen_context(self):
        context=self.context();frozen=deepcopy(context);library=Mock()
        library.get.return_value={'ref':'source@1','kind':'KNOWLEDGE','status':'PUBLISHED','content_hash':'changed','effective_at':0,'effective_until':4000000000}
        actual,sources,redacted=refresh_history(library,object(),context)
        self.assertEqual(context,frozen);self.assertEqual(redacted,[1]);self.assertEqual(sources,[])
        self.assertNotIn('inherited-private-text',canonical(actual));self.assertEqual(actual['messages'][0]['source_dependencies'],[])

    def test_contract_accepts_legacy_and_exact_dependencies_but_rejects_malformed_metadata(self):
        context=self.context();TaskContract(execution_mode='conversation',conversation_context=context)
        legacy=deepcopy(context);legacy['messages'][0].pop('source_dependencies');TaskContract(execution_mode='conversation',conversation_context=legacy)
        for invalid in (None,{},[{}],[{'asset_ref':'ref','content_hash':'hash','quote':'not a citation'}]):
            value=deepcopy(context);value['messages'][0]['source_dependencies']=invalid
            with self.assertRaises(ValueError):TaskContract(execution_mode='conversation',conversation_context=value)
        context['messages'][0]['role']='user'
        with self.assertRaises(ValueError):TaskContract(execution_mode='conversation',conversation_context=context)


if __name__=='__main__':unittest.main()
