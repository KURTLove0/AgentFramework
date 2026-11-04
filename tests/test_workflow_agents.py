from copy import deepcopy
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.web import Application
from agent_framework.workflow_chat import WorkflowChat,RESPONSE
from agent_framework.workflow_agents import prepare_drafts
from agent_framework.definitions import default_definition
from agent_framework.contracts import canonical
from agent_framework.runtime_config import ConfigConflict
from agent_framework.structured import validate


class WorkflowAgentTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.source=self.app.agents.save(dict(name='流程设计师',description='设计协作流程',runtime='mock',model='builtin',options={},prompt='设计流程',skills=[],mcp_servers=[],revision=0,definition=default_definition('流程设计师','general-assistant@1.0.0')))
        self.flows=self.app.workflows()

    def proposal(self):
        return WorkflowChat(self.app).reply(dict(agent_id=self.source['id'],message='新建「资料分析员」负责分析输入并整理要点；再新建「报告撰写员」负责结合上游结果形成报告。'))['proposal']

    def save(self,proposal=None,key='save-test'):
        return self.flows.save((proposal or self.proposal())|dict(revision=0,request_id=key))

    def test_design_review_atomic_save_retry_and_actual_execution(self):
        proposal=self.proposal()
        self.assertEqual(len(proposal['agent_drafts']),2)
        self.assertEqual(len(self.app.agents.list()),1);self.assertEqual(self.flows.list(),[])
        self.assertEqual(self.app.runs()['counts']['total'],0)
        saved=self.save(proposal)
        self.assertNotIn('agent_drafts',saved)
        self.assertEqual(len(self.app.agents.list()),3)
        self.assertEqual(saved,self.save(proposal))
        source_data={k:deepcopy(self.source[k]) for k in ('name','description','runtime','model','options','prompt','skills','mcp_servers','revision','definition')}
        self.app.agents.save(source_data|dict(prompt='已修改设计师指令'),self.source['id'])
        self.assertEqual(saved,self.save(proposal))
        for node in saved['nodes']:
            profile=self.app.agents.get(node['agent_id'])
            self.assertFalse(node['agent_id'].startswith('draft-agent-'))
            self.assertEqual(profile['definition']['domain_pack_ref'],'general-assistant@1.0.0')
            self.assertEqual(profile['mcp_servers'],[]);self.assertEqual(profile['skills'],[])
        run=self.flows.start(saved['id'],dict(revision=1,request_id='run-specialists'))
        frozen=self.app.agents.get(saved['nodes'][0]['agent_id'])
        agent_data={k:deepcopy(frozen[k]) for k in ('name','description','runtime','model','options','prompt','skills','mcp_servers','revision','definition')}
        self.app.agents.save(agent_data|dict(prompt='保存后修改执行指令'),frozen['id'])
        result=self.flows.execute(run['id'])
        self.assertEqual(result['status'],'SUCCEEDED')
        self.assertTrue(all(n['status']=='SUCCEEDED' and n['run_id'] for n in result['nodes'].values()))
        upstream=self.flows.accepted_child(result['nodes'][saved['nodes'][0]['id']])
        downstream=self.flows.accepted_child(result['nodes'][saved['nodes'][1]['id']])
        self.assertEqual(downstream['task']['workflow_inputs'][0]['artifact'],upstream['report'])
        self.assertEqual(downstream['snapshot']['agent_profile']['id'],saved['nodes'][1]['agent_id'])
        self.assertEqual(upstream['snapshot']['agent_profile']['revision'],1)
        self.assertEqual(upstream['snapshot']['agent_profile']['prompt'],frozen['prompt'])
        self.assertEqual(len(self.app.agents.list()),3)

    def test_invalid_later_draft_and_cycle_leave_no_records(self):
        for corrupt in ('prompt','cycle','unused','extra','duplicate'):
            proposal=self.proposal()
            if corrupt=='prompt':proposal['agent_drafts'][1]['prompt']=''
            if corrupt=='cycle':proposal['nodes'][0]['depends_on']=[proposal['nodes'][1]['id']]
            if corrupt=='unused':proposal['nodes'].pop()
            if corrupt=='extra':proposal['agent_drafts'][1]['mcp_servers']=[]
            if corrupt=='duplicate':proposal['agent_drafts'][1]['id']=proposal['agent_drafts'][0]['id']
            with self.subTest(corrupt=corrupt),self.assertRaises(ValueError):self.save(proposal)
            self.assertEqual(len(self.app.agents.list()),1);self.assertEqual(self.flows.list(),[])

    def test_database_failure_rolls_back_agents_and_receipt(self):
        proposal=self.proposal()
        with self.flows.store.connect() as db:
            db.execute("CREATE TRIGGER reject_workflow BEFORE INSERT ON workflows BEGIN SELECT RAISE(ABORT,'test failure'); END")
        with self.assertRaisesRegex(Exception,'test failure'):self.save(proposal)
        self.assertEqual(len(self.app.agents.list()),1);self.assertEqual(self.flows.list(),[])
        with self.flows.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM workflow_saves').fetchone()[0],0)
            db.execute('DROP TRIGGER reject_workflow')
        self.assertEqual(len(self.save(proposal)['nodes']),2)

    def test_stale_source_and_workspace_scope_rejected(self):
        proposal=self.proposal()
        data={k:deepcopy(self.source[k]) for k in ('name','description','runtime','model','options','prompt','skills','mcp_servers','revision','definition')}
        self.app.agents.save(data|dict(prompt='新的设计指令'),self.source['id'])
        with self.assertRaises(ConfigConflict):self.save(proposal)
        space=self.app.workspaces.save(dict(name='其他空间',business='其他',scenario='测试',description='',revision=0))
        with self.assertRaises(KeyError):self.app.scoped(space['id']).workflows().save(proposal|dict(revision=0,request_id='save-other'))
        self.assertEqual(len(self.app.agents.list()),1)

    def test_default_runtime_and_shared_draft(self):
        proposal=self.proposal();proposal['agent_drafts']=proposal['agent_drafts'][:1]
        draft=proposal['agent_drafts'][0];draft.update(source_agent_id='',source_agent_revision=0)
        for node in proposal['nodes']:node['agent_id']=draft['id']
        saved=self.save(proposal)
        self.assertEqual(saved['nodes'][0]['agent_id'],saved['nodes'][1]['agent_id'])
        self.assertEqual(len(self.app.agents.list()),2)

    def test_save_request_is_required_and_cannot_be_reused_for_other_content(self):
        proposal=self.proposal()
        with self.assertRaisesRegex(ValueError,'请求标识'):self.flows.save(proposal|dict(revision=0))
        self.save(proposal)
        with self.assertRaises(ConfigConflict):self.save(proposal|dict(name='不同内容'))
        self.assertEqual(len(self.app.agents.list()),3)

    def test_real_designer_schema_creates_drafts_with_selected_model(self):
        from agent_framework.llm import CodexTransport
        proposal=self.proposal()
        for draft in proposal['agent_drafts']:
            draft.pop('source_agent_id');draft.pop('source_agent_revision')
        output=dict(reply='已设计两个执行智能体',workflow=proposal);validate(output,RESPONSE)
        source=deepcopy(self.source);source.update(runtime='codex',model='fixture-model',options=dict(timeout=5,max_attempts=1,reasoning_effort='low'))
        with patch.object(self.app.agents,'get',return_value=source),patch.object(self.app.models,'require',return_value={'efforts':['low']}),patch.object(CodexTransport,'generate',return_value=(canonical(output),{})) as generate:
            chat=WorkflowChat(self.app).reply(dict(agent_id=source['id'],message='为此流程自主创建分析和报告智能体',consent=True))
            self.assertIn('agent_drafts',generate.call_args.args[0])
            self.assertEqual(generate.call_args.args[1],RESPONSE)
            self.assertEqual(len(chat['proposal']['agent_drafts']),2)
            drafts,profiles,_,_=prepare_drafts(self.app,chat['proposal']['agent_drafts'])
            self.assertEqual({p['model'] for p in profiles.values()},{'fixture-model'})
        self.assertEqual(len(self.app.agents.list()),1)
