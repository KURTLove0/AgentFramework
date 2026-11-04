"""Bounded model history keeps useful replies and audit identities, not duplicate quotations."""
import json
from copy import deepcopy
import random
import tempfile
import unittest
from unittest.mock import Mock, patch

from agent_framework.contracts import PolicyDenied, canonical, digest
from agent_framework.conversation_history import HistoryWindow
from agent_framework.knowledge import Library
from agent_framework.store import Store
from agent_framework.task_conversations import TaskConversations, HISTORY_BYTES, refresh_history
from agent_framework.web import Application
from tests import test_task_conversations as fixtures


class HistoryWindowTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.root=self.app.create({'start':False})['run'];self.service=TaskConversations(self.app)

    def rows(self,count=3):
        return [{'number':n,'content':'历史消息 '+str(n),'run_id':self.root['run_id'],'state':'RUNNING'} for n in range(1,count+1)]

    def test_history_does_not_hydrate_full_execution_records_without_citations(self):
        with patch.object(Store,'result',side_effect=AssertionError('full execution loaded')):
            history=self.service.history(self.root,self.rows(),4)
        self.assertEqual(len(history['messages']),3)

    def test_history_budget_includes_json_array_punctuation(self):
        history=self.service.history(self.root,self.rows(),4)
        exact=sum(len(canonical(m).encode()) for m in history['messages'])
        with patch('agent_framework.task_conversations.HISTORY_BYTES',exact):
            bounded=self.service.history(self.root,self.rows(),4)
        self.assertLessEqual(len(canonical(bounded['messages']).encode()),exact)
        self.assertEqual(bounded['messages'][-1]['content'],'历史消息 3')
        self.assertEqual(bounded['history_hash'],digest(history['messages']))

    def test_incremental_window_matches_canonical_suffix_and_complete_history_hash(self):
        rng=random.Random(71)
        messages=[{'role':'user','content':rng.choice(['汉字😀','line\nquote"','\\path'])*rng.randrange(1,30),
            'turn':n,'run_id':'run-'+str(n),'status':'sent','citations':[]} for n in range(1,80)]
        for budget,count in [(2,200),(500,200),(2000,7),(96000,20)]:
            window=HistoryWindow(budget,count)
            for message in messages:window.append(message)
            selected=[]
            for message in reversed(messages):
                if len(selected)>=count or len(canonical([message,*selected]).encode())>budget:break
                selected.insert(0,message)
            result=window.result()
            self.assertEqual(result['messages'],selected)
            self.assertEqual(result['history_hash'],digest(messages))
            self.assertEqual(result['omitted_messages'],len(messages)-len(selected))
            self.assertLessEqual(len(canonical(result['messages']).encode()),budget)

    def test_cancelled_queued_messages_are_not_included_or_counted_as_omitted(self):
        rows=self.rows();rows[1]['state']='CANCELLED'
        result=self.service.history(self.root,rows,4)
        self.assertEqual([m['turn'] for m in result['messages']],[1,3])
        self.assertEqual(result['omitted_messages'],0)
        self.assertEqual(result['history_hash'],digest(result['messages']))

    def test_history_uses_one_checkpoint_snapshot_across_batches(self):
        before={**self.root,'status':'SUCCEEDED','report':{'content':'旧结果'}}
        with self.app.control_store.transaction() as db:
            db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(before),self.app.tenant,self.root['run_id']))
        original=self.service._turn_states;calls=[]
        def change_after_read(*args):
            states=original(*args)
            if not calls:
                calls.append(True)
                with self.app.control_store.transaction() as db:
                    db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical({**before,'report':{'content':'新结果'}}),self.app.tenant,self.root['run_id']))
            return states
        with patch.object(self.service,'_turn_states',side_effect=change_after_read):
            result=self.service.history(self.root,self.rows(205),206)
        self.assertTrue(calls)
        self.assertTrue(all(m['content']=='旧结果' for m in result['messages'] if m['role']=='assistant'))
        self.assertEqual(self.service.history(self.root,self.rows(1),2)['messages'][-1]['content'],'新结果')

    def test_a_foreign_turn_cannot_be_forwarded_as_model_history(self):
        state=deepcopy(self.root);state['task']['principal']='other-person'
        with self.app.control_store.transaction() as db:
            db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(state),self.app.tenant,self.root['run_id']))
        with self.assertRaises(PolicyDenied):self.service.history(self.root,self.rows(1),2)


class HistoryRefreshTests(unittest.TestCase):
    def context(self,citations):
        return {'task_id':'task','turn':3,'goal':'目标','history_hash':'frozen-hash','omitted_messages':7,
            'messages':[{'role':'assistant','turn':n,'run_id':'run-'+str(n),'status':'SUCCEEDED','content':'先前的回答','citations':deepcopy(citations)} for n in (1,2)]}

    def test_legacy_quotes_are_compacted_and_shared_sources_resolved_once(self):
        citation={'asset_ref':'source@1','content_hash':'hash','quote':'重复原文'*100,'evidence_ref':'context-original'}
        original=self.context([citation,citation]);frozen=deepcopy(original)
        asset={'ref':'source@1','kind':'KNOWLEDGE','status':'PUBLISHED','content_hash':'hash','effective_at':0,'effective_until':4000000000}
        library=Mock();library.get.return_value=asset
        refreshed,sources,redactions=refresh_history(library,object(),original)
        library.get.assert_called_once();self.assertEqual(sources,[asset]);self.assertEqual(redactions,[])
        self.assertEqual(original,frozen)
        self.assertEqual(refreshed['history_hash'],'frozen-hash');self.assertEqual(refreshed['omitted_messages'],7)
        for message in refreshed['messages']:
            self.assertEqual(message['citations'],[{'asset_ref':'source@1','content_hash':'hash'}])
        self.assertNotIn('重复原文',canonical(refreshed))

    def test_each_message_is_redacted_when_a_shared_source_is_unavailable(self):
        original=self.context([{'asset_ref':'source@1','content_hash':'hash'}]);library=Mock();library.get.side_effect=PolicyDenied('private detail')
        refreshed,sources,redactions=refresh_history(library,object(),original)
        library.get.assert_called_once();self.assertEqual(sources,[]);self.assertEqual(redactions,[1,2])
        for message in refreshed['messages']:
            self.assertIn('来源已失效',message['content']);self.assertEqual(message['citations'],[])
        self.assertNotIn('private detail',canonical(refreshed))

    def test_different_source_hashes_are_not_conflated_by_the_read_cache(self):
        original=self.context([{'asset_ref':'source@1','content_hash':'old'}]);original['messages'][1]['citations'][0]['content_hash']='current'
        library=Mock();library.get.return_value={'ref':'source@1','kind':'KNOWLEDGE','status':'PUBLISHED','content_hash':'current','effective_at':0,'effective_until':4000000000}
        refreshed,_,redactions=refresh_history(library,object(),original)
        self.assertEqual(redactions,[1]);self.assertEqual(refreshed['messages'][1]['content'],'先前的回答')
        library.get.assert_called_once()

    def test_malformed_frozen_citations_redact_instead_of_forwarding_unchecked_text(self):
        for value in ['not-a-list',[None],[{'asset_ref':'source@1'}]]:
            context=self.context(value);library=Mock()
            refreshed,_,redactions=refresh_history(library,object(),context)
            self.assertEqual(redactions,[1,2]);library.get.assert_not_called()
            self.assertTrue(all(not m['citations'] for m in refreshed['messages']))


class HistoryContextIntegrationTests(unittest.TestCase):
    setUp=fixtures.TaskConversationTests.setUp
    start=fixtures.TaskConversationTests.start
    wait=fixtures.TaskConversationTests.wait
    send=fixtures.TaskConversationTests.send

    def cited_reply(self,text,duplicates=1):
        library=Library(self.app.control_store);owner=self.app.library_access()
        source=library.create(owner,{'kind':'KNOWLEDGE','title':'会议规则','content':{'text':text}})
        library.transition(owner,source['ref'],'REVIEW');library.transition(owner,source['ref'],'PUBLISHED')
        def reply(request,result):
            if request['context']['task']['conversation_context']['turn']==1:
                doc=next(d for d in request['context']['knowledge'] if d['ref']==source['ref'])
                result['result']['content']='上一轮已确认会议规则。'
                citation={'asset_ref':doc['ref'],'content_hash':doc['content_hash'],'quote':doc['content']['text'],'evidence_ref':request['context']['context_manifest']['id']}
                result['result']['citations']=[dict(citation) for _ in range(duplicates)]
            return result
        self.fixture.reply=reply
        return library,owner,source

    def test_repeated_long_citations_do_not_remove_the_last_reply_from_the_next_model_input(self):
        _,_,source=self.cited_reply('会议规则'*997,duplicates=8)
        root=self.start('会议规则');first=self.wait(root,status='SUCCEEDED')
        self.assertEqual(len(first['run']['report']['citations']),8)
        self.send(root,'请把上一轮结论整理成一句话');self.wait(root,2,'SUCCEEDED')
        context=self.fixture.requests[-1]['context']['task']['conversation_context']
        self.assertTrue(context['messages'])
        assistant=next(m for m in context['messages'] if m['role']=='assistant')
        self.assertEqual(assistant['content'],'上一轮已确认会议规则。')
        self.assertEqual(assistant['citations'],[{'asset_ref':source['ref'],'content_hash':source['content_hash']}])
        self.assertLessEqual(len(canonical(context['messages']).encode()),HISTORY_BYTES)
        self.assertEqual(len(self.app.detail(root)['conversation']['turns'][0]['reply']['citations']),8)

    def test_manifest_binds_refreshed_history_without_rewriting_the_frozen_context(self):
        library,owner,source=self.cited_reply('SOURCE_HISTORY_SENTINEL：会议规则。')
        root=self.start('会议规则');self.wait(root,status='SUCCEEDED')
        with patch.object(self.app,'schedule'):pending=self.send(root,'继续解释')
        child=pending['conversation']['active_run_id'];frozen=self.app.control_store.load(self.app.tenant,child)['task']['conversation_context']
        library.transition(owner,source['ref'],'WITHDRAWN');self.app.runtime().run(child)
        request=self.fixture.requests[-1]['context'];context=request['task']['conversation_context']
        manifest=next(m for m in self.app.control_store.contexts(self.app.tenant,child) if m['id']==request['context_manifest']['id'])
        self.assertIn('来源已失效',canonical(context))
        self.assertEqual(manifest.get('conversation_context_hash'),digest(context))
        self.assertEqual(manifest['conversation_history_hash'],frozen['history_hash'])
        self.assertEqual(manifest['conversation_message_count'],len(context['messages']))
        self.assertEqual(manifest['conversation_omitted_messages'],context['omitted_messages'])
        self.assertNotEqual(digest(context),digest(frozen))
        self.assertEqual(self.app.control_store.load(self.app.tenant,child)['task']['conversation_context'],frozen)


if __name__=='__main__':unittest.main()
