"""Cross-module journeys use the same task semantics, context and frozen versions."""
from copy import deepcopy
from datetime import datetime,timedelta
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.definitions import default_definition
from agent_framework.learning import Learning
from agent_framework.llm import CodexTransport,ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application
from agent_framework.workspace_scheduler import WorkspaceScheduler
from agent_framework.workflow_rules import matches


class ProjectJourneyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='project-journey-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.calls=[];self.release=threading.Event();self.release.set();self.entered=threading.Event();self.block_goal=None
        model=patch.object(ModelCatalog,'list',return_value={'models':[{'id':'fixture','name':'Fixture','efforts':['low']}],'source':'fixture'});model.start();self.addCleanup(model.stop)
        transport=patch.object(CodexTransport,'generate',lambda transport,*args:self.generate(transport,*args));transport.start();self.addCleanup(transport.stop)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close);self.addCleanup(self.release.set)
        self.agent=self.app.agents.save({'name':'通用执行助手','description':'按照目标处理任务','runtime':'codex','model':'fixture','options':{'timeout':5,'max_attempts':1,'reasoning_effort':'low'},'prompt':'按目标与对话上下文交付结果。','skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('通用执行助手','general-assistant@1.0.0')})
    def generate(self,transport,prompt,schema,config,timeout):
        request=json.loads(prompt[prompt.index('\n{')+1:]);self.calls.append(deepcopy(request));self.assertEqual(request['phase'],'execute')
        task=request['context']['task'];goal=task['goal']
        if goal==self.block_goal:
            self.entered.set()
            while not self.release.wait(.02):
                if callable(transport.should_cancel) and transport.should_cancel():raise ModelError('task_cancelled')
        if goal=='先确认会议时间' and not (task.get('conversation_context') or {}).get('messages'):
            result={'kind':'request_input','summary':'会议时间安排在什么时候？','result':None}
        else:
            content='已完成：'+goal
            if goal=='整理会议通知':content+='；上游结果：'+task['workflow_inputs'][0]['artifact']['content']
            result={'kind':'result','summary':'已按当前目标交付。','result':{'title':'本轮结果','content':content,'citations':[],'limitations':[]}}
        return json.dumps(result,ensure_ascii=False),{'usage':{'input_tokens':10,'output_tokens':10}}
    def wait_run(self,identity,turn=1,status='SUCCEEDED'):
        deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            detail=self.app.detail(identity);turns=detail['conversation']['turns']
            if len(turns)>=turn:
                current=turns[turn-1]
                if current['status']==status and not (self.app.job(current['run_id']) or {}).get('active'):return detail
            time.sleep(.02)
        self.fail('Task did not settle: '+str([(t['number'],t['status'],t['error']) for t in self.app.detail(identity)['conversation']['turns']]))
    def wait_flow(self,identity,status):
        deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            detail=self.app.flow_detail(identity)
            if detail['run']['status']==status and not (detail['job'] or {}).get('active'):return detail
            time.sleep(.02)
        self.fail('Workflow did not settle: '+str(self.app.flow_detail(identity)['run']))
    def daily(self,goal='每日整理事项'):
        service=WorkspaceScheduler(self.app)
        service.save({'revision':0,'enabled':False,'timezone':'Asia/Shanghai','daily_time':'09:00','auto_start':False,'tasks':[{'goal':goal,'agent_id':self.agent['id'],'agent_revision':1,'change_id':'daily-template','grant':False,'consent':True,'mcp_consent':True,'execution_mode':'conversation'}]})
        return service
    def test_daily_waits_for_explicit_start_then_runs_one_turn_and_supports_followups(self):
        service=self.daily();plan=service.dispatch(service.generate()['id']);identity=plan['items'][0]['run_id']
        detail=self.app.detail(identity);self.assertEqual(detail['run']['status'],'CREATED');self.assertTrue(detail['conversation']['resumable'])
        TaskConversations.tick(self.app);self.assertEqual(self.calls,[])
        self.app.mutate(identity,'resume');first=self.wait_run(identity);self.assertEqual(first['run']['task']['execution_mode'],'conversation');self.assertFalse(first['grant']['valid'])
        TaskConversations(self.app).append(identity,{'content':'继续补充明日安排','request_id':'followup','revision':1});self.wait_run(identity,2)
        self.assertEqual(self.app.runs()['counts']['total'],1);self.assertEqual(len(self.calls),2)
    def test_daily_dedup_includes_an_active_followup_on_a_completed_root(self):
        service=self.daily();root=self.app.start_task({'goal':'每日整理事项','agent_id':self.agent['id'],'agent_revision':1,'request_id':'manual'})['run']['run_id'];self.wait_run(root)
        self.block_goal='继续处理';self.release.clear();TaskConversations(self.app).append(root,{'content':'继续处理','request_id':'followup','revision':1});self.assertTrue(self.entered.wait(2))
        plan=service.generate();self.assertEqual(plan['items'][0]['status'],'SKIPPED');self.assertEqual(plan['history_counts']['total'],1)
        self.assertFalse(any(t.get('attention_kind')=='resume' for t in self.app.attention()['tasks']))
    def flow(self,goals):
        nodes=[{'id':'n'+str(n),'name':'节点'+str(n),'agent_id':self.agent['id'],'agent_revision':1,'goal':goal,'depends_on':[] if n==0 else ['n'+str(n-1)]} for n,goal in enumerate(goals)]
        workflow=self.app.workflows().save({'name':'目标协作','description':'按目标串联结果','revision':0,'nodes':nodes})
        run=self.app.workflows().start(workflow['id'],{'revision':1,'consent':True,'request_id':'workflow'})
        self.app.schedule_flow(run['id']);return run['id']
    def test_workflow_question_can_be_answered_in_its_task_and_continues_with_latest_result(self):
        identity=self.flow(['先确认会议时间','整理会议通知']);waiting=self.wait_flow(identity,'WAITING_INPUT');root=waiting['run']['nodes']['n0']['run_id']
        self.assertEqual(len(self.calls),1);self.assertEqual(waiting['run']['snapshot']['execution_modes']['n0'],'direct')
        TaskConversations(self.app).append(root,{'content':'周五下午三点','request_id':'answer','revision':1})
        completed=self.wait_flow(identity,'SUCCEEDED');output=completed['run']['nodes']['n0']['output_run_id']
        self.assertNotEqual(output,root);self.assertEqual(completed['children']['n0']['run_id'],output)
        downstream=self.calls[-1]['context']['task']['workflow_inputs'][0]
        self.assertEqual(downstream['run_id'],output);self.assertIn('周五下午三点',downstream['artifact']['content']);self.assertEqual(len(self.calls),3)
    def test_workflow_cancel_interrupts_the_current_model_call(self):
        self.block_goal='长时间整理';self.release.clear();identity=self.flow(['长时间整理']);self.assertTrue(self.entered.wait(2))
        start=time.monotonic();self.app.workflows().cancel(identity);detail=self.wait_flow(identity,'CANCELLED')
        self.assertLess(time.monotonic()-start,2);self.assertEqual(detail['children']['n0']['status'],'CANCELLED')
    def test_downstream_followup_keeps_inputs_and_later_edits_do_not_rewrite_accepted_output(self):
        identity=self.flow(['整理会议背景','先确认会议时间']);waiting=self.wait_flow(identity,'WAITING_INPUT');root=waiting['run']['nodes']['n1']['run_id']
        original=self.app.runtime().store.load(self.app.tenant,root)['task']['workflow_inputs'];self.assertTrue(original)
        TaskConversations(self.app).append(root,{'content':'周五下午三点','request_id':'time','revision':1})
        completed=self.wait_flow(identity,'SUCCEEDED');accepted=completed['run']['nodes']['n1']['output_run_id']
        self.assertEqual(self.calls[-1]['context']['task']['workflow_inputs'],original)
        TaskConversations(self.app).append(root,{'content':'另存一份后续讨论','request_id':'later','revision':2});self.wait_run(root,3)
        self.assertNotEqual(self.app.detail(root)['conversation']['active_run_id'],accepted)
        self.assertEqual(self.app.flow_detail(identity)['children']['n1']['run_id'],accepted)
    def test_retrospective_uses_latest_reply_and_invalidates_when_conversation_changes(self):
        root=self.app.start_task({'goal':'整理事项','agent_id':self.agent['id'],'agent_revision':1,'request_id':'root'})['run']['run_id'];self.wait_run(root)
        TaskConversations(self.app).append(root,{'content':'修订为最终版本','request_id':'revision','revision':1});second=self.wait_run(root,2)
        service=Learning(self.app);context=service.run_context(root);latest=second['conversation']['turns'][1]['run_id']
        self.assertEqual(context['facts']['run_id'],latest);self.assertIn('最终版本',context['facts']['report']['content']);self.assertEqual(context['facts']['goal'],'整理事项')
        self.assertEqual(context['sources'][0]['ref'],'run:'+latest);self.assertTrue(context['facts']['conversation_history'])
        fields=('name','description','runtime','model','options','prompt','skills','mcp_servers','definition')
        reviewer={k:self.agent[k] for k in fields};reviewer.update(name='离线复盘',runtime='mock',model='builtin',options={},revision=0)
        reviewer=self.app.agents.save(reviewer)
        proposal=service.generate({'purpose':'retrospective','run_id':root,'agent_id':reviewer['id'],'agent_revision':1,'request_id':'latest-review','instruction':'根据当前结果归纳。'})
        receipt=service.deposit(proposal['id'],{'revision':proposal['revision'],'item_ids':[i['id'] for i in proposal['output']['items']]})
        self.assertEqual(receipt['status'],'DEPOSITED')
        self.assertTrue(any(a['kind']=='EXPERIENCE' for a in receipt['receipt']['assets']))
        from agent_framework.experience import ExperienceService
        experience=ExperienceService(self.app.runtime().store)
        ref=next(a['ref'] for a in receipt['receipt']['assets'] if a['kind']=='EXPERIENCE')
        evaluation=experience.evaluate(service.access,ref)
        self.assertEqual(evaluation['mode'],'local-deliverable-checks');self.assertTrue(evaluation['passed'])
        self.assertEqual(len(evaluation['cases']),3);self.assertEqual(evaluation['live_model_calls'],0)
        self.assertEqual(experience.publish(service.access,ref,evaluation['id'])['status'],'PUBLISHED')
        TaskConversations(self.app).append(root,{'content':'再调整标题','request_id':'third','revision':2});self.wait_run(root,3)
        self.assertNotEqual(service.run_context(root)['source_hash'],context['source_hash'])
    def test_general_content_branches_are_mutually_exclusive_and_old_answer_alias_is_supported(self):
        report={'content':'会议安排在周五下午三点。','citations':[]}
        yes={'field':'content','operator':'contains','value':'周五'};no={**yes,'operator':'not_contains'}
        self.assertTrue(matches(yes,report));self.assertFalse(matches(no,report));self.assertTrue(matches({**yes,'field':'answer'},report))
        self.assertFalse(matches(no,{}))


if __name__=='__main__':unittest.main()
