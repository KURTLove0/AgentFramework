"""Long follow-ups remain complete while optional retrieval stays bounded."""
from copy import deepcopy
import unittest

from agent_framework.context_builder import build,context_query
from agent_framework.contracts import canonical,digest
from agent_framework.knowledge import Access,Library
from agent_framework.memory import episodes

from tests import test_task_conversations as fixtures


class LongMessageTests(unittest.TestCase):
    setUp=fixtures.TaskConversationTests.setUp
    start=fixtures.TaskConversationTests.start
    wait=fixtures.TaskConversationTests.wait
    send=fixtures.TaskConversationTests.send

    def check_followup(self,content):
        def reply(request,value):
            value['result']['content']='已完整收到本轮消息。'
            return value
        self.fixture.reply=reply
        root=self.start();self.wait(root,status='SUCCEEDED')
        self.send(root,content);detail=self.wait(root,2)
        self.assertEqual(detail['conversation']['turns'][1]['status'],'SUCCEEDED',detail['conversation']['turns'][1]['error'])
        self.assertEqual(len(self.fixture.requests),2)
        self.assertEqual(self.fixture.requests[-1]['context']['task']['goal'],content)
        self.assertEqual(detail['conversation']['turns'][1]['content'],content)
        return root,detail

    def test_followup_above_search_limit_reaches_model_intact(self):
        self.check_followup('材料'*1000+'。')

    def test_followup_at_composer_limit_reaches_model_intact(self):
        content='资料内容'*3999+'最后四字'
        self.assertEqual(len(content),16000)
        root,detail=self.check_followup(content)
        self.send(root,'请继续处理前面的材料','next');self.wait(root,3,'SUCCEEDED')
        messages=self.fixture.requests[-1]['context']['task']['conversation_context']['messages']
        self.assertTrue(any(m['role']=='user' and m['content']==content for m in messages))

    def test_exact_search_boundary_is_not_sampled(self):
        root,detail=self.check_followup('材料'*1000)
        manifest=detail['conversation']['current']['context_manifests'][-1]
        self.assertEqual(manifest['retrieval_queries']['knowledge']['strategy'],'verbatim')

    def test_unicode_followup_reaches_model_without_byte_or_surrogate_truncation(self):
        self.check_followup('👩🏽‍💻 中文 e\u0301\n'*400+'尾部😀')

    def test_over_composer_limit_is_rejected_before_persisting_a_turn(self):
        root=self.start();self.wait(root,status='SUCCEEDED')
        with self.assertRaises(ValueError):self.send(root,'字'*16001)
        self.assertEqual(len(self.app.detail(root)['conversation']['turns']),1)
        self.assertEqual(len(self.fixture.requests),1)

    def test_tail_sample_retrieves_scoped_sources_and_memory_with_reproducible_audit(self):
        library=Library(self.app.control_store);owner=self.app.library_access()
        other=Access(owner.tenant,'other-person',owner.project,roles=('curator','reviewer'))
        assets=[]
        for access,marker in ((owner,'VISIBLE_SOURCE'),(other,'PRIVATE_SOURCE')):
            asset=library.create(access,{'kind':'KNOWLEDGE','title':'tailneedle','visibility':'PRIVATE','content':{'text':'tailneedle '+marker}})
            library.transition(access,asset['ref'],'REVIEW');library.transition(access,asset['ref'],'PUBLISHED');assets.append(asset)
            episode={'run_id':'episode-'+access.principal,'summary':'tailneedle '+marker,'outcome':'SUCCEEDED','domain_pack_ref':'general-assistant@1.0.0','evidence_refs':[]}
            with self.app.control_store.transaction() as db:
                db.execute('INSERT INTO episodic_memories VALUES(?,?,?,?,?,?)',(access.tenant,episode['run_id'],access.project,access.environment,access.principal,canonical(episode)))
        content='材料'*7000+' tailneedle'
        _,detail=self.check_followup(content);context=self.fixture.requests[-1]['context']
        self.assertIn(assets[0]['ref'],[item['ref'] for item in context['knowledge']])
        self.assertNotIn(assets[1]['ref'],[item['ref'] for item in context['knowledge']])
        self.assertTrue(any(e['run_id']=='episode-'+owner.principal for e in context['memory']['episodes']))
        self.assertNotIn('PRIVATE_SOURCE',canonical(context))
        manifest=next(m for m in detail['conversation']['current']['context_manifests'] if m['id']==context['context_manifest']['id'])
        for record in manifest['retrieval_queries'].values():
            query='\n'.join(content[a:b] for a,b in record['ranges'])
            self.assertEqual(record['query_hash'],digest(query));self.assertEqual(record['query_chars'],len(query))
            self.assertEqual(record['input_chars'],len(content));self.assertLessEqual(len(query),2000)
            self.assertEqual(record['strategy'],'head-middle-tail')
        self.assertEqual(manifest['hash'],digest({k:v for k,v in manifest.items() if k!='hash'}))

    def test_explicit_workflow_query_is_preserved_while_long_goal_memory_is_bounded(self):
        root=self.start();self.wait(root,status='SUCCEEDED')
        state=self.app.control_store.load(self.app.tenant,root)
        state['task']['goal']='材料'*3000;state['task']['retrieval']={'query':'显式检索规则','top_k':1}
        frozen=deepcopy(state)
        bundle,manifest=build(self.app.control_store,state,'execute',self.app.runtime().context(state))
        self.assertEqual(state,frozen)
        self.assertEqual(bundle['state']['task']['goal'],state['task']['goal'])
        knowledge=manifest['retrieval_queries']['knowledge'];memory=manifest['retrieval_queries']['memory']
        self.assertEqual(knowledge['source'],'workflow-query');self.assertEqual(knowledge['strategy'],'verbatim')
        self.assertEqual(knowledge['query_hash'],digest('显式检索规则'))
        self.assertEqual(memory['source'],'task-goal');self.assertEqual(memory['strategy'],'head-middle-tail')
        # Public search limits remain independent of the accepted message limit.
        with self.assertRaises(ValueError):Library(self.app.control_store).search(self.app.library_access(),'字'*2001)
        with self.assertRaises(ValueError):episodes(self.app.control_store,self.app.library_access(),'字'*2001)


class ContextQueryTests(unittest.TestCase):
    def test_short_queries_remain_verbatim_including_whitespace(self):
        for text in ('','  precise phrase  ','汉字'*1000):
            query,record=context_query(text,'task-goal')
            self.assertEqual(query,text);self.assertEqual(record['ranges'],[[0,len(text)]])
            self.assertEqual(record['query_hash'],digest(text));self.assertEqual(record['strategy'],'verbatim')

    def test_long_query_samples_three_disjoint_regions_without_changing_input(self):
        for size in (2001,3000,16000):
            text='HEAD '+('材料😀'*6000)[:size-10]+' TAIL'
            query,record=context_query(text,'task-goal');ranges=record['ranges']
            self.assertEqual(len(text),size);self.assertLessEqual(len(query),2000)
            self.assertTrue(query.startswith('HEAD '));self.assertTrue(query.endswith(' TAIL'))
            self.assertEqual(query,'\n'.join(text[a:b] for a,b in ranges))
            self.assertTrue(all(0<=a<b<=len(text) for a,b in ranges))
            self.assertLessEqual(ranges[0][1],ranges[1][0]);self.assertLessEqual(ranges[1][1],ranges[2][0])
            self.assertEqual(ranges[1][0],(len(text)-666)//2)
            self.assertNotIn('\ufffd',query)


if __name__=='__main__':unittest.main()
