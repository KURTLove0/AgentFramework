import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.web import Application, WebServer
from agent_framework.runtime import Runtime


class WebTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = Application(self.tmp.name, lease_seconds=.5, tool_timeout=.2)

    def tearDown(self):
        self.app.close()
        self.tmp.cleanup()

    def wait(self, run_id):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            detail = self.app.detail(run_id)
            if not detail['job'] or not detail['job']['active']:
                return detail
            time.sleep(.03)
        self.fail('worker did not finish')

    def create(self, **kwargs):
        d = self.app.create(kwargs)
        return self.wait(d['run']['run_id'])

    def assert_one_draft(self, d):
        self.assertEqual(d['run']['status'], 'SUCCEEDED')
        self.assertEqual(len(d['external']['drafts']), 1)
        self.assertEqual(d['external']['calls']['report.draft.create@1.0.0'], 1)
        self.assertTrue(all(c['passed'] for c in d['run']['checks'].values()))

    def test_normal_and_real_counts(self):
        self.assertEqual(self.app.runs()['counts']['total'], 0)
        d = self.create()
        self.assert_one_draft(d)
        self.assertEqual(self.app.runs()['counts']['succeeded'], 1)
        self.assertTrue(d['evidence'])
        self.assertTrue(d['events'])
        self.assertEqual(d['run']['task']['tenant_id'], 'tenant-demo')

    def test_response_lost_reconciles(self):
        self.assert_one_draft(self.create(scenario='response-lost'))

    def test_crash_restart_recovery(self):
        d = self.create(scenario='crash-after-write')
        run_id = d['run']['run_id']
        self.assertEqual(d['job']['state'], 'CRASHED')
        self.assertEqual(len(d['external']['drafts']), 1)
        self.app.close()
        self.app = Application(self.tmp.name, lease_seconds=.5, tool_timeout=.2)
        self.assertEqual(self.app.runs()['counts']['total'], 1)
        self.assertIsNone(self.app.detail(run_id)['job'])
        time.sleep(.55)
        self.app.mutate(run_id, 'resume')
        self.assert_one_draft(self.wait(run_id))

    def test_concrete_grant(self):
        d = self.create(grant=False)
        self.assertEqual(d['run']['status'], 'WAITING_AUTH')
        self.assertEqual(len(d['external']['drafts']), 0)
        pending = [a for a in d['run']['actions'] if a['status'] == 'PREPARED']
        self.assertTrue(pending)
        self.app.mutate(d['run']['run_id'], 'grant')
        self.assert_one_draft(self.wait(d['run']['run_id']))

    def test_tamper_and_unverifiable_stay_review(self):
        for scenario in ('tampered-draft', 'unverifiable'):
            d = self.create(scenario=scenario)
            self.assertEqual(d['run']['status'], 'NEEDS_REVIEW')
            self.assertLessEqual(d['external']['calls']['report.draft.create@1.0.0'], 1)

    def test_cancel_created_and_resume_rejected(self):
        d = self.app.create({'start': False})
        run_id = d['run']['run_id']
        self.app.mutate(run_id, 'cancel')
        self.assertEqual(self.app.detail(run_id)['run']['status'], 'CANCELLED')
        self.assertFalse(self.app.detail(run_id)['external']['drafts'])
        with self.assertRaisesRegex(Exception, '运行已结束'):
            self.app.mutate(run_id, 'resume')

    def test_active_cancel_and_duplicate_schedule(self):
        entered, proceed = threading.Event(), threading.Event()
        original = Runtime.run

        def controlled(runtime, *args, **kwargs):
            entered.set()
            if not proceed.wait(3):
                raise RuntimeError('test barrier timeout')
            return original(runtime, *args, **kwargs)

        d = self.app.create({'start': False})
        run_id = d['run']['run_id']
        with patch.object(Runtime, 'run', controlled):
            try:
                self.app.schedule(run_id)
                self.assertTrue(entered.wait(2))
                with self.assertRaisesRegex(Exception, '工作进程持有'):
                    self.app.schedule(run_id)
                response = self.app.mutate(run_id, 'cancel')
                self.assertTrue(response['job']['cancel_requested'])
            finally:
                proceed.set()
            result = self.wait(run_id)
        self.assertEqual(result['run']['status'], 'CANCELLED')
        self.assertEqual(len(result['external']['drafts']), 0)

    def test_scope_consent_validation_and_no_model_call(self):
        with patch('agent_framework.web.LLMPlanner') as planner:
            with self.assertRaisesRegex(Exception, '使用真实模型前'):
                self.app.create({'planner': 'codex'})
            planner.assert_not_called()
        for bad in ({'tenant_id': 'other'}, {'goal': ''}, {'start': 'yes'}, {'budget': []}, {'scenario': 'unknown'}):
            with self.assertRaises((ValueError, TypeError)):
                self.app.create(bad)
        other = Application(self.tmp.name, tenant='another-tenant')
        try:
            self.create()
            self.assertFalse(other.runs()['runs'])
        finally:
            other.close()

    def test_task_draft_persistence_revision_and_workspace_scope(self):
        self.assertIsNone(self.app.task_draft()['draft'])
        draft={'domain_pack_ref':'change-assessment@2.0.0','goal':'保留的模拟目标','change_id':'change-draft-001','agent_id':'','planner':'mock','max_steps':32,'max_wall_seconds':180,'step':1}
        saved=self.app.save_task_draft({'revision':0,'draft':draft})
        self.assertEqual(saved['revision'],1)
        self.assertEqual(saved['draft']['goal'],'保留的模拟目标')
        with self.assertRaisesRegex(ValueError,'许可字段'):
            self.app.save_task_draft({'revision':1,'draft':draft|{'grant':True}})
        with self.assertRaisesRegex(Exception,'其他页面更新'):
            self.app.save_task_draft({'revision':0,'draft':draft})
        other_space=self.app.workspaces.save({'name':'其他空间','business':'模拟','scenario':'隔离','description':'','revision':0})
        self.assertIsNone(self.app.scoped(other_space['id']).task_draft()['draft'])
        self.app.close()
        self.app=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2)
        self.assertEqual(self.app.task_draft()['draft']['goal'],'保留的模拟目标')
        created=self.app.create({'start':False,'clear_draft':True})
        self.assertEqual(created['run']['status'],'CREATED')
        self.assertIsNone(self.app.task_draft()['draft'])

    def test_source_run_is_linked_without_inheriting_grant(self):
        original=self.app.create({'start':False})['run']
        copied=self.app.create({'start':False,'source_run_id':original['run_id'],'grant':False})['run']
        self.assertNotEqual(copied['run_id'],original['run_id'])
        self.assertEqual(copied['task']['source_run_id'],original['run_id'])
        self.assertIsNone(self.app.runtime().store.get_grant(copied))
        self.assertEqual(self.app.detail(original['run_id'])['run']['status'],'CREATED')
        self.assertEqual(self.app.runs({'search':[original['run_id']]})['filtered_total'],1)

    def test_runs_filter_sort_and_cursor_pagination(self):
        first=self.app.create({'goal':'分页-甲','start':False})['run']
        second=self.app.create({'goal':'分页-乙','start':False})['run']
        third=self.app.create({'goal':'分页-丙','start':False,'domain_pack_ref':'knowledge-answer@1.0.0'})['run']
        page=self.app.runs({'sort':['created_asc'],'limit':['2']})
        self.assertEqual([r['run_id'] for r in page['runs']],[first['run_id'],second['run_id']])
        self.assertEqual(page['filtered_total'],3)
        self.assertTrue(page['next_cursor'])
        following=self.app.runs({'sort':['created_asc'],'limit':['2'],'cursor':[page['next_cursor']]})
        self.assertEqual([r['run_id'] for r in following['runs']],[third['run_id']])
        self.assertIsNone(following['next_cursor'])
        self.assertEqual(self.app.runs({'domain':['knowledge-answer@1.0.0']})['filtered_total'],1)
        self.assertEqual(self.app.runs({'search':['分页-乙']})['runs'][0]['run_id'],second['run_id'])
        with self.assertRaisesRegex(ValueError,'分页游标'):
            self.app.runs({'cursor':['invalid']})

    def test_runs_cursor_pagination_reaches_records_beyond_two_hundred(self):
        ids=[]
        for index in range(205):
            ids.append(self.app.create({'goal':f'历史-{index:03d}','start':False})['run']['run_id'])
        seen=[];cursor=None;pages=0
        while True:
            params={'sort':['created_asc'],'limit':['50']}
            if cursor:params['cursor']=[cursor]
            page=self.app.runs(params);pages+=1
            seen.extend(r['run_id'] for r in page['runs'])
            cursor=page['next_cursor']
            if not cursor:break
        self.assertEqual(pages,5)
        self.assertEqual(len(seen),205)
        self.assertEqual(len(set(seen)),205)
        self.assertEqual(seen[0],ids[0])
        self.assertEqual(seen[-1],ids[-1])
        self.assertEqual(self.app.runs({'search':['历史-000']})['filtered_total'],1)

    def test_attention_uses_current_workspace_actionable_states(self):
        waiting=self.create(grant=False)['run']
        created=self.app.create({'start':False})['run']
        result=self.app.attention()
        by_id={item['run_id']:item['attention_kind'] for item in result['tasks']}
        self.assertEqual(by_id[waiting['run_id']],'auth')
        self.assertEqual(by_id[created['run_id']],'start')
        self.assertEqual(result['counts']['total'],2)
        self.assertEqual(result['open_alert_count'],0)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = Application(self.tmp.name)
        self.server = WebServer(('127.0.0.1', 0), self.app)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.close()
        self.thread.join(2)
        self.tmp.cleanup()

    def request(self, path='/', method='GET', data=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=4)
        hdrs = {'Content-Type': 'application/json', 'X-Agent-Token': self.app.token}
        hdrs.update(headers or {})
        conn.request(method, path, data, hdrs)
        response = conn.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        conn.close()
        return result

    def test_static_session_and_download(self):
        for path, mime in (('/', 'text/html'), ('/app.js', 'text/javascript'), ('/styles.css', 'text/css')):
            status, headers, body = self.request(path)
            self.assertEqual(status, 200)
            self.assertTrue(headers['Content-Type'].startswith(mime))
            self.assertGreater(len(body), 100)
            self.assertIn("script-src 'self'", headers['Content-Security-Policy'])
        status, _, body = self.request('/api/session')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['csrf_token'], self.app.token)
        status, _, body = self.request('/api/runs', 'POST', json.dumps({'start': False}))
        self.assertEqual(status, 202)
        run_id = json.loads(body)['run']['run_id']
        status, headers, body = self.request('/api/runs/'+run_id+'/download?kind=result')
        self.assertEqual(status, 200)
        self.assertIn('attachment', headers['Content-Disposition'])
        self.assertEqual(json.loads(body)['run_id'], run_id)
        self.assertEqual(self.request('/api/runs/'+run_id+'/download?kind=report')[0], 404)
        self.assertEqual(self.request('/../web.py')[0], 404)

    def test_cross_site_mutation_and_bad_input_rejected(self):
        for headers in ({'Host':'evil.example'}, {'Origin':'https://evil.example'}, {'X-Agent-Token':''}):
            self.assertEqual(self.request('/api/runs','POST','{}',headers)[0],403)
        self.assertEqual(self.request('/api/runs','POST','{}',{'Content-Type':'text/plain'})[0],415)
        for body in ('[]', '{"start":true,"start":false}', '{"budget":{"max_wall_seconds":NaN}}'):
            self.assertEqual(self.request('/api/runs','POST',body)[0],400)
        self.assertEqual(self.request('/api/runs','POST','{}',{'Content-Length':'70000'})[0],413)
        self.assertEqual(self.app.runs()['counts']['total'],0)

    def test_task_draft_and_attention_routes(self):
        draft={'domain_pack_ref':'change-assessment@2.0.0','goal':'HTTP 草稿','planner':'mock','step':0}
        status,_,body=self.request('/api/task-draft','POST',json.dumps({'revision':0,'draft':draft}))
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body)['revision'],1)
        status,_,body=self.request('/api/task-draft')
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body)['draft']['goal'],'HTTP 草稿')
        self.assertEqual(self.request('/api/task-draft','POST',json.dumps({'revision':1,'draft':draft|{'consent':True}}))[0],400)
        status,_,body=self.request('/api/attention')
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body)['counts']['total'],0)
        self.assertEqual(self.request('/api/task-draft/discard','POST','{}')[0],200)
        self.assertIsNone(self.app.task_draft()['draft'])

    def test_runtime_configuration_routes_and_task_selection(self):
        from unittest.mock import patch
        status, _, body = self.request('/api/runtime-config')
        self.assertEqual(status, 200)
        config = json.loads(body)
        self.assertEqual({p['id'] for p in config['providers']}, {'mock', 'codex', 'cursor', 'qoder'})
        self.assertIn('qoder', config['settings']['profiles'])
        data = {k: config['settings'][k] for k in ('default_runtime', 'profiles', 'revision')}
        data['default_runtime'] = 'cursor'
        data['profiles']['cursor']['model'] = 'cursor-http-fixture'
        self.assertEqual(self.request('/api/runtime-config', 'POST', json.dumps(data), {'X-Agent-Token':''})[0], 403)
        status, _, body = self.request('/api/runtime-config', 'POST', json.dumps(data))
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['settings']['revision'], 1)
        self.assertEqual(self.request('/api/runtime-config', 'POST', json.dumps(data))[0], 409)
        self.assertEqual(self.request('/api/runtime-config/detect', 'POST', '{"provider":"mock"}')[0], 200)
        self.assertEqual(self.request('/api/runtime-config/detect', 'POST', '{"provider":"sh"}')[0], 400)
        with patch('agent_framework.runtime_config.shutil.which', return_value='/local/cli'):
            status, _, body = self.request('/api/runs', 'POST', json.dumps({'consent':True,'start':False,'runtime_revision':1}))
            self.assertEqual(status, 202)
            snapshot = json.loads(body)['run']['snapshot']['planner']
            self.assertEqual(snapshot['ref'], 'cursor-planner@1.0.0')
            self.assertEqual(snapshot['config']['model'], 'cursor-http-fixture')

    def test_agent_crud_model_selector_and_task_binding(self):
        status, _, body = self.request('/api/runtime-config/models?provider=mock')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['models'][0]['id'], 'builtin')
        definition = {'name':'HTTP Agent','description':'模拟配置','runtime':'mock','model':'builtin','options':{},
                      'prompt':'按证据生成评估草稿','skills':[{'name':'检查方法','instructions':'先核对测试','enabled':True}],
                      'mcp_servers':[],'revision':0}
        self.assertEqual(self.request('/api/agents','POST',json.dumps(definition),{'X-Agent-Token':''})[0],403)
        status, _, body = self.request('/api/agents','POST',json.dumps(definition))
        self.assertEqual(status,201)
        agent=json.loads(body)
        for path in ('/api/capabilities','/api/skills','/api/standards','/api/domain-packs','/api/agent-definition-default'):
            self.assertEqual(self.request(path)[0],200)
        compile_path='/api/agents/'+agent['id']+'/compile'
        self.assertEqual(self.request(compile_path,'POST','{"revision":1}',{'X-Agent-Token':''})[0],403)
        status, _, body=self.request(compile_path,'POST','{"revision":1}')
        self.assertEqual(status,200)
        compiled=json.loads(body)['compiled_agent']
        self.assertEqual(compiled['schema_version'],2)
        self.assertEqual(self.request(compile_path,'POST','{"revision":0}')[0],409)
        definition['revision']=1
        definition['prompt']='新的 Agent Prompt'
        self.assertEqual(self.request('/api/agents/'+agent['id'],'POST',json.dumps(definition))[0],200)
        self.assertEqual(self.request('/api/agents/'+agent['id'],'POST',json.dumps(definition))[0],409)
        self.assertEqual(self.request('/api/runs','POST',json.dumps({'agent_id':agent['id'],'agent_revision':1,'start':False}))[0],409)
        status, _, body=self.request('/api/runs','POST',json.dumps({'agent_id':agent['id'],'agent_revision':2,'start':False}))
        self.assertEqual(status,202)
        run=json.loads(body)['run']
        self.assertEqual(run['snapshot']['agent_profile']['prompt'],definition['prompt'])
        status, _, body=self.request(compile_path,'POST','{"revision":2}')
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body)['compiled_agent']['hash'],run['snapshot']['compiled_agent']['hash'])

        self.assertEqual(self.request('/api/agents/'+agent['id']+'/archive','POST',json.dumps({'revision':2,'archived':True}))[0],200)
        self.assertEqual(self.request('/api/runs','POST',json.dumps({'agent_id':agent['id'],'agent_revision':3,'start':False}))[0],400)

    def test_knowledge_lifecycle_context_manifests_and_private_identity(self):
        payload={'kind':'PREFERENCE','title':'HTTP 偏好','content':{'report_title_prefix':'HTTP：'}}
        self.assertEqual(self.request('/api/knowledge/assets','POST',json.dumps(payload),{'X-Agent-Token':''})[0],403)
        status,_,body=self.request('/api/knowledge/assets','POST',json.dumps(payload))
        self.assertEqual(status,201);asset=json.loads(body)
        self.assertEqual(self.request('/api/knowledge/assets','POST',json.dumps(payload|{'principal':'another'}))[0],400)
        for action in ('review','publish'):
            self.assertEqual(self.request('/api/knowledge/assets/'+asset['ref'].replace('@','%40')+'/'+action,'POST','{}')[0],200)
        status,_,body=self.request('/api/knowledge/search','POST',json.dumps({'query':'报告'}))
        self.assertEqual(status,200)
        self.assertIn(asset['ref'],[x['ref'] for x in json.loads(body)['items']])
        status,_,body=self.request('/api/runs','POST',json.dumps({'start':False}))
        run=json.loads(body)['run']
        self.app.runtime().run(run['run_id'])
        status,_,body=self.request('/api/runs/'+run['run_id']+'/context-manifests')
        self.assertEqual(status,200);self.assertTrue(json.loads(body)['manifests'])
        self.assertEqual(self.request('/api/memory')[0],200)
        status,_,body=self.request('/api/experiences');candidate=json.loads(body)['experiences'][0]
        self.assertEqual(candidate['status'],'CANDIDATE')
        self.assertEqual(self.request('/api/experiences/'+candidate['ref']+'/publish','POST','{}')[0],403)
        self.assertEqual(self.request('/api/knowledge/assets/'+asset['ref']+'/withdraw','POST','{}')[0],200)
        for path in ('/library.js','/api/library'):
            self.assertEqual(self.request(path)[0],200)

    def test_read_only_question_domain_routes_and_export(self):
        status,_,body=self.request('/api/runs','POST',json.dumps({'domain_pack_ref':'knowledge-answer@1.0.0','goal':'变更评估风险规则是什么？','start':False,'grant':False}))
        self.assertEqual(status,202);run=json.loads(body)['run']
        result=self.app.runtime().run(run['run_id'])
        self.assertEqual(result['status'],'SUCCEEDED')
        self.assertIn('answer-current',result['checks'])
        status,_,body=self.request('/api/runs/'+run['run_id']+'/download?kind=report')
        self.assertEqual(status,200);self.assertIn('## 来源',body.decode())
        self.assertEqual(self.app.runtime().external.stats('tenant-demo',run['run_id'])['drafts'],[])

    def test_private_context_cannot_leak_through_run_detail_export_or_controls(self):
        from agent_framework.contracts import TaskContract
        from agent_framework.knowledge import Library,Access
        runtime=self.app.runtime();library=Library(runtime.store)
        actor=Access(self.app.tenant,'alice','project-demo',roles=('curator',))
        asset=library.create(actor,{'kind':'KNOWLEDGE','visibility':'PRIVATE','title':'PRIVATE-CANARY','content':{'text':'PRIVATE-CANARY：仅 Alice 可读的模拟资料。'}})
        library.transition(actor,asset['ref'],'REVIEW');library.transition(actor,asset['ref'],'PUBLISHED')
        state=runtime.submit(TaskContract(tenant_id=self.app.tenant,principal='alice',domain_pack_ref='knowledge-answer@1.0.0',goal='PRIVATE-CANARY'))
        result=runtime.run(state['run_id']);self.assertEqual(result['status'],'SUCCEEDED')
        self.assertIn('PRIVATE-CANARY',result['report']['answer'])
        status,_,body=self.request('/api/runs')
        self.assertEqual(status,200);self.assertNotIn('PRIVATE-CANARY',body.decode())
        self.assertEqual(json.loads(body)['counts']['total'],0)
        for path in ('','/download?kind=report','/download?kind=result','/context-manifests'):
            self.assertEqual(self.request('/api/runs/'+state['run_id']+path)[0],403)
        for action in ('cancel','resume','grant','revoke'):
            self.assertEqual(self.request('/api/runs/'+state['run_id']+'/'+action,'POST','{}')[0],403)
        status,_,body=self.request('/api/library');self.assertNotIn('PRIVATE-CANARY',body.decode())
        self.assertEqual(runtime.store.load(self.app.tenant,state['run_id'])['status'],'SUCCEEDED')


if __name__ == '__main__':
    unittest.main()
