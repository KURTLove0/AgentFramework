"""Regression coverage for scoring, explicit activation and failed-result recovery."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import threading
import unittest
from unittest.mock import patch

from agent_framework.agent_evaluation import AgentEvaluations
from agent_framework.contracts import PolicyDenied
from agent_framework.knowledge import Access, Library
from agent_framework.knowledge_hub import hub
from agent_framework.learning import Learning
from agent_framework.ontology import activate, expand, revise
from agent_framework.ontology_model import object_set
from agent_framework.runtime_config import ConfigConflict
from agent_framework.web import WebServer
from test_job_ontology import content, profile
from test_ontology_regressions import OntologyFixture
import test_ontology_regressions as ontology_regressions


class AuditImprovementTests(OntologyFixture):
    def failed_proposal(self):
        raw = content(self.source['ref'])
        raw['model']['objects'][0]['values']['score'] = 200
        for obj in raw['model']['objects']:
            obj['values'] = [{'property_id': key, 'values': [value]} for key, value in obj['values'].items()]
        with patch('agent_framework.learning.agent_generate', return_value=(raw, {'model_calls': 1, 'usage': []})) as generator:
            with self.assertRaises(ValueError):
                self.generate()
            self.assertEqual(generator.call_count, 1)
        return Learning(self.app).get(Learning(self.app).list()[0]['id'])

    def test_offline_normal_tasks_do_not_receive_quality_scores_or_alerts(self):
        agent = self.app.agents.save(profile('离线任务', 'general-assistant@1.0.0'))
        created = self.app.start_task(dict(goal='计算 12345 乘以 6789', agent_id=agent['id'], agent_revision=1, request_id='offline-score'), start=False)
        result = self.app.runtime().run(created['run']['run_id'])
        self.assertEqual(result['status'], 'SUCCEEDED')
        overview = AgentEvaluations(self.app).overview()
        report = overview['reports'][0]
        self.assertIsNone(report['score'])
        self.assertEqual(report['verdict'], 'SIMULATED')
        self.assertEqual(report['assessment']['quality_status'], 'SIMULATION_ONLY')
        self.assertEqual(overview['agents'][0]['sample_count'], 0)
        self.assertEqual(overview['agents'][0]['simulated'], 1)
        self.assertEqual(overview['open_alert_count'], 0)

    def test_real_normal_tasks_label_structure_checks_without_claiming_quality(self):
        catalog = dict(models=[dict(id='fixture', name='Fixture', efforts=['low'])], source='fixture')
        data = profile('模型任务', 'general-assistant@1.0.0')
        data.update(runtime='codex', model='fixture', options=dict(timeout=5, max_attempts=1, reasoning_effort='low'))
        with patch('agent_framework.model_catalog.ModelCatalog.list', return_value=catalog):
            agent = self.app.agents.save(data)
        answer = dict(kind='result', summary='交付已保存', result=dict(title='结果', content='仅用于测试格式与引用的正文。', citations=[], limitations=[]))
        with patch('agent_framework.llm.CodexTransport.generate', return_value=(json.dumps(answer), {'usage': {'input_tokens': 1, 'output_tokens': 1}})):
            created = self.app.start_task(dict(goal='完成复杂业务判断', agent_id=agent['id'], agent_revision=1, request_id='structure-score'), start=False)
            self.app.runtime().run(created['run']['run_id'])
        report = AgentEvaluations(self.app).overview()['reports'][0]
        self.assertEqual(report['assessment']['scope'], 'STRUCTURAL')
        self.assertEqual(report['assessment']['quality_status'], 'NOT_ASSESSED')
        self.assertEqual(report['assessment']['label'], '结构检查分')

    def test_historical_offline_scores_are_presented_without_mutating_audit_records(self):
        agent = self.app.agents.save(profile('历史离线任务', 'general-assistant@1.0.0'))
        created = self.app.start_task(dict(goal='原始离线任务', agent_id=agent['id'], agent_revision=1, request_id='old-score'), start=False)
        self.app.runtime().run(created['run']['run_id'])
        service = AgentEvaluations(self.app)
        report = service.overview()['reports'][0]
        from agent_framework.contracts import canonical
        historical = {k: v for k, v in report.items() if k != 'assessment'}
        historical.update(score=100, verdict='PASS', rubric='job-history@2.0.0')
        with self.lib.store.transaction() as db:
            db.execute('UPDATE agent_evaluations SET data=? WHERE id=?', (canonical(historical), report['id']))
        visible = service.overview()['reports'][0]
        self.assertIsNone(visible['score'])
        self.assertEqual(visible['historical_score'], 100)
        self.assertEqual(service.get(report['id'])['verdict'], 'SIMULATED')
        with self.lib.store.connect() as db:
            raw = json.loads(db.execute('SELECT data FROM agent_evaluations WHERE id=?', (report['id'],)).fetchone()[0])
        self.assertEqual(raw['score'], 100)

    def test_withdrawal_does_not_roll_back_until_explicit_scoped_activation(self):
        old = self.asset()
        value = deepcopy(old['content'])
        value['concepts'][0]['aliases'] = ['新别名']
        new = self.publish(revise(self.lib, self.access, old['ref'], dict(content=value)))
        self.lib.transition(self.access, new['ref'], 'WITHDRAWN')
        self.assertEqual(expand(self.lib, self.access, '唯一变更别名')['concepts'], [])
        with self.assertRaises(PolicyDenied):
            object_set(self.lib, self.access, old)
        old_view = next(a for a in hub(self.app)['ontologies'] if a['ref'] == old['ref'])
        self.assertFalse(old_view['usable'])
        self.assertEqual(old_view['active_ref'], new['ref'])
        with self.assertRaises(ConfigConflict):
            activate(self.lib, self.access, old['ref'], dict(expected_active_ref=old['ref']))
        other = Access(self.access.tenant, 'other', self.access.project, roles=('curator',))
        with self.assertRaises(KeyError):
            activate(self.lib, other, old['ref'], dict(expected_active_ref=new['ref']))
        active = activate(self.lib, self.access, old['ref'], dict(expected_active_ref=new['ref']))
        self.assertTrue(active['usable'])
        reopened = Library(self.app.runtime().store)
        self.assertEqual(reopened.active_ontology_ref(self.access, old['id']), old['ref'])
        self.assertTrue(expand(reopened, self.access, '唯一变更别名')['concepts'])
        with self.lib.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM asset_events WHERE event='ontology.activated'").fetchone()[0], 1)

    def test_legacy_publication_history_does_not_revive_a_withdrawn_replacement(self):
        old = self.asset()
        new = self.publish(revise(self.lib, self.access, old['ref'], dict(content=old['content'])))
        self.lib.transition(self.access, new['ref'], 'WITHDRAWN')
        with self.lib.store.transaction() as db:
            db.execute('DELETE FROM ontology_activation')
        self.assertEqual(self.lib.active_ontology_ref(self.access, old['id']), new['ref'])
        self.assertEqual(expand(self.lib, self.access, '唯一变更别名')['concepts'], [])

    def test_expired_ontology_read_model_explains_why_browsing_is_disabled(self):
        asset = self.asset()
        with patch('time.time', return_value=asset['effective_until']):
            view = next(a for a in hub(self.app)['ontologies'] if a['ref'] == asset['ref'])
        self.assertTrue(view['sources_current'])
        self.assertFalse(view['effective'])
        self.assertFalse(view['usable'])
        self.assertEqual(view['unavailable_reason'], '本体已过期')

    def test_repair_is_idempotent_and_cannot_deposit_unfixed_constraints(self):
        failed = self.failed_proposal()
        self.assertTrue(failed['repairable'])
        service = Learning(self.app)
        with ThreadPoolExecutor(max_workers=2) as pool:
            repaired = list(pool.map(lambda _: service.repair(failed['id'], dict(revision=failed['revision'])), range(2)))
        self.assertEqual(repaired[0]['id'], repaired[1]['id'])
        draft = repaired[0]
        self.assertEqual(draft['repair_of'], failed['id'])
        with self.assertRaises(ValueError):
            service.deposit(draft['id'], dict(revision=draft['revision'], item_ids=['ontology']))
        fixed = deepcopy(draft['output'])
        fixed['model']['objects'][0]['values']['score'] = 90
        saved = service.save(draft['id'], dict(revision=draft['revision'], output=fixed))
        self.assertEqual(service.repair(failed['id'], dict(revision=failed['revision']))['revision'], saved['revision'])
        deposited = service.deposit(saved['id'], dict(revision=saved['revision'], item_ids=['ontology']))
        asset = self.publish(self.lib.get(self.access, deposited['receipt']['assets'][0]['ref']))
        self.assertEqual(asset['provenance']['repair_of'], failed['id'])
        self.assertEqual(object_set(self.lib, self.access, asset)['total'], 2)
        self.assertEqual(service.get(failed['id'])['status'], 'FAILED')
        self.assertEqual(len(service.list()), 2)

    def test_repair_refuses_withdrawn_sources_and_wrong_revisions(self):
        failed = self.failed_proposal()
        service = Learning(self.app)
        with self.assertRaises(ConfigConflict):
            service.repair(failed['id'], dict(revision=0))
        self.lib.transition(self.access, self.source['ref'], 'WITHDRAWN')
        with self.assertRaises(ValueError):
            service.repair(failed['id'], dict(revision=failed['revision']))
        self.assertEqual(len(service.list()), 1)


class AuditImprovementHTTPTests(OntologyFixture):
    request = ontology_regressions.OntologyFlowHTTPTests.request
    lifecycle = ontology_regressions.OntologyFlowHTTPTests.lifecycle
    failed_proposal = AuditImprovementTests.failed_proposal

    def setUp(self):
        OntologyFixture.setUp(self)
        self.server = WebServer(('127.0.0.1', 0), self.app)
        self.addCleanup(self.server.server_close)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(self.server.shutdown)

    def test_http_repair_and_explicit_activation_preserve_validation(self):
        failed = self.failed_proposal()
        draft, _ = self.request('/api/learning-proposals/' + failed['id'] + '/repair', dict(revision=failed['revision']), expected=201)
        self.request('/api/learning-proposals/' + draft['id'] + '/deposit', dict(revision=draft['revision'], item_ids=['ontology']), expected=400)
        draft['output']['model']['objects'][0]['values']['score'] = 90
        saved, _ = self.request('/api/learning-proposals/' + draft['id'], dict(revision=draft['revision'], output=draft['output']))
        receipt, _ = self.request('/api/learning-proposals/' + draft['id'] + '/deposit', dict(revision=saved['revision'], item_ids=['ontology']))
        ref = receipt['receipt']['assets'][0]['ref']
        self.lifecycle(ref, 'review')
        self.lifecycle(ref, 'publish')
        active, _ = self.request('/api/ontologies/' + ref + '/activate', dict(expected_active_ref=ref))
        self.assertTrue(active['usable'])
        self.request('/api/ontologies/' + ref + '/activate', dict(expected_active_ref=None), expected=409)
