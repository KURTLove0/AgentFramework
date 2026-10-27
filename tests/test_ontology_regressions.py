"""Ontology lifecycle regressions, including the complete HTTP authoring flow."""
from copy import deepcopy
import http.client
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import quote, urlencode

from agent_framework.contracts import PolicyDenied
from agent_framework.knowledge import Access
from agent_framework.knowledge_hub import hub
from agent_framework.learning import Learning
from agent_framework.ontology import expand, export_jsonld, mock_ontology, sources_current, validate_ontology
from agent_framework.ontology_model import object_set
from agent_framework.web import Application, WebServer
from test_job_ontology import content, profile


class OntologyFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name)
        self.addCleanup(self.app.close)
        self.lib = self.app.library()
        self.access = self.app.library_access()
        self.agent = self.app.agents.save(profile())
        self.source = self.knowledge('发布质量来源', '变更 C001 产出报告 R001。')

    def publish(self, asset):
        self.lib.transition(self.access, asset['ref'], 'REVIEW')
        return self.lib.transition(self.access, asset['ref'], 'PUBLISHED')

    def knowledge(self, title, text, **kwargs):
        return self.publish(self.lib.create(self.access, dict(
            title=title, content={'text': text}, effective_at=0,
            effective_until=time.time() + 3 * 365 * 86400, **kwargs)))

    def generate(self, refs=None, **kwargs):
        return Learning(self.app).generate(dict(
            request_id='ontology-regression', purpose='ontology',
            source_refs=refs or [self.source['ref']], agent_id=self.agent['id'],
            agent_revision=self.agent['revision'], operational=True, **kwargs))

    def asset(self, value=None):
        service = Learning(self.app)
        proposal = self.generate()
        value = deepcopy(value or content(self.source['ref']))
        proposal = service.save(proposal['id'], dict(revision=proposal['revision'], output=value))
        deposited = service.deposit(proposal['id'], dict(revision=proposal['revision'], item_ids=['ontology']))
        return self.publish(self.lib.get(self.access, deposited['receipt']['assets'][0]['ref']))


class OntologyRegressionTests(OntologyFixture):
    def test_retrieval_keeps_the_pinned_source_version_after_a_new_publication(self):
        value = content(self.source['ref'])
        value['concepts'][0]['aliases'] = ['frozen-source-alias']
        asset = self.asset(value)
        newer = self.knowledge('新版资料', '新版独有规则', id=self.source['id'], supersedes=self.source['ref'])

        self.assertTrue(sources_current(self.lib, self.access, asset))
        self.assertEqual(expand(self.lib, self.access, 'frozen-source-alias')['source_refs'], [self.source['ref']])
        hits = self.lib.search(self.access, 'frozen-source-alias')['items']
        self.assertEqual([item['ref'] for item in hits], [self.source['ref']])
        self.assertEqual([item['ref'] for item in self.lib.search(self.access, '新版独有规则')['items']], [newer['ref']])
        self.assertEqual([item['ref'] for item in self.lib.search(self.access)['items']], [newer['ref']])
        self.assertEqual(object_set(self.lib, self.access, asset)['total'], 2)

    def test_a_revoked_pinned_source_is_not_replaced_with_a_newer_version(self):
        asset = self.asset()
        self.knowledge('新版资料', '新版独有规则', id=self.source['id'], supersedes=self.source['ref'])
        self.lib.transition(self.access, self.source['ref'], 'WITHDRAWN')
        self.assertFalse(sources_current(self.lib, self.access, asset))
        self.assertEqual(expand(self.lib, self.access, '唯一变更别名')['concepts'], [])
        self.assertEqual(self.lib.search(self.access, '唯一变更别名')['items'], [])
        with self.assertRaises(PolicyDenied):
            object_set(self.lib, self.access, asset)

    def test_qa_cites_the_frozen_source_and_waits_for_input_after_revocation(self):
        value = content(self.source['ref'])
        value['concepts'][0]['aliases'] = ['C++']
        self.asset(value)
        self.knowledge('新版资料', '新版独有规则', id=self.source['id'], supersedes=self.source['ref'])
        agent = self.app.agents.save(profile('知识问答', 'knowledge-answer@1.0.0'))

        def answer():
            state = self.app.create(dict(goal='C++', start=False, agent_id=agent['id'], agent_revision=agent['revision']))['run']
            return self.app.runtime().run(state['run_id'])

        result = answer()
        self.assertEqual(result['status'], 'SUCCEEDED')
        self.assertEqual({citation['asset_ref'] for citation in result['report']['citations']}, {self.source['ref']})
        self.assertEqual(result['report']['answer'], self.source['content']['text'])
        self.assertTrue(all(check['passed'] for check in result['checks'].values()))
        self.lib.transition(self.access, self.source['ref'], 'WITHDRAWN')
        waiting = answer()
        self.assertEqual(waiting['status'], 'WAITING_INPUT')
        self.assertIsNone(waiting['report'])

    def test_concepts_and_objects_share_the_ontology_validity_window(self):
        asset = self.asset()
        cases = [(asset['effective_at'] - 1, False), (asset['effective_at'], True),
                 (asset['effective_until'] - 1, True), (asset['effective_until'], False)]
        for now, active in cases:
            with self.subTest(now=now, active=active), patch('time.time', return_value=now):
                self.assertTrue(sources_current(self.lib, self.access, asset))
                self.assertEqual(bool(expand(self.lib, self.access, '唯一变更别名')['concepts']), active)
                if active:
                    self.assertEqual(object_set(self.lib, self.access, asset)['total'], 2)
                else:
                    with self.assertRaises(PolicyDenied):
                        object_set(self.lib, self.access, asset)

    def test_short_labels_and_aliases_reach_only_their_grounded_sources(self):
        unrelated = self.knowledge('其他资料', '完全无关的主题。')
        value = content(self.source['ref'])
        value['concepts'][0].update(label='R', aliases=['A', 'C++', 'C#', 'API'])
        asset = self.asset(value)
        for query in ['R', ' r ', 'A', 'a', 'C++', ' c# ', 'API']:
            with self.subTest(query=query):
                match = expand(self.lib, self.access, query, max_hops=0)['concepts']
                self.assertEqual([item['id'] for item in match], ['change'])
                self.assertEqual(match[0]['match_score'], 1)
                self.assertEqual([item['ref'] for item in self.lib.search(self.access, query)['items']], [self.source['ref']])
                view = hub(self.app, query)
                self.assertEqual([item['ref'] for item in view['knowledge']], [self.source['ref']])
                self.assertEqual([item['ref'] for item in view['ontologies']], [asset['ref']])
                self.assertNotIn(unrelated['ref'], [item['ref'] for item in view['knowledge']])

    def test_nonempty_queries_without_tokens_do_not_list_all_knowledge(self):
        other = self.knowledge('其他资料', '另外一个主题。')
        for query in ['Z', 'C++', '!!!', '+']:
            with self.subTest(query=query):
                self.assertEqual(self.lib.search(self.access, query)['items'], [])
                self.assertEqual(hub(self.app, query)['knowledge'], [])
        self.assertEqual({item['ref'] for item in self.lib.search(self.access, '  ')['items']},
                         {self.source['ref'], other['ref']})

    def test_same_title_sources_generate_publish_and_export_separate_concepts(self):
        second = self.knowledge(self.source['title'], '第二份资料的不同事实。')
        third = self.knowledge(' ' + self.source['title'] + ' ', '第三份资料的不同事实。')
        refs = [self.source['ref'], second['ref'], third['ref']]
        service = Learning(self.app)
        for operational in [False, True]:
            with self.subTest(operational=operational):
                proposal = service.generate(dict(
                    request_id='same-title-' + str(operational), purpose='ontology', source_refs=refs,
                    agent_id=self.agent['id'], agent_revision=self.agent['revision'], operational=operational))
                self.assertEqual(proposal['status'], 'DRAFT')
                nodes = proposal['output']['concepts']
                self.assertEqual(len(nodes), 3)
                self.assertEqual(len({node['label'].strip().casefold() for node in nodes}), 3)
                self.assertEqual({node['source_refs'][0] for node in nodes}, set(refs))
                for node in nodes:
                    self.assertEqual(node['definition'], self.lib.get(self.access, node['source_refs'][0])['content']['text'])
                deposited = service.deposit(proposal['id'], dict(revision=proposal['revision'], item_ids=['ontology']))
                asset = self.publish(self.lib.get(self.access, deposited['receipt']['assets'][0]['ref']))
                validate_ontology(asset['content'], set(refs))
                self.assertEqual(len(export_jsonld(asset)['@graph']), 4)

    def test_generated_names_also_avoid_existing_disambiguation_suffixes(self):
        context = {'sources': [dict(ref=ref, title=title, content={'text': ref}) for ref, title in [
            ('a@1', 'Shared'), ('b@1', 'Shared (c@1)'), ('c@1', ' shared ')]]}
        value = mock_ontology(context)
        validate_ontology(value, {'a@1', 'b@1', 'c@1'})
        self.assertEqual(value, mock_ontology(context))
        self.assertEqual(len({node['label'].strip().casefold() for node in value['concepts']}), 3)

    def test_pinned_versions_and_short_aliases_still_obey_principal_scope(self):
        value = content(self.source['ref'])
        value['concepts'][0]['aliases'] = ['C++']
        self.asset(value)
        other = Access(self.access.tenant, 'other', self.access.project)
        self.assertEqual(expand(self.lib, other, 'C++')['concepts'], [])
        self.assertEqual(self.lib.search(other, 'C++')['items'], [])


class OntologyFlowHTTPTests(OntologyFixture):
    def setUp(self):
        super().setUp()
        self.server = WebServer(('127.0.0.1', 0), self.app)
        self.addCleanup(self.server.server_close)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(self.server.shutdown)

    def request(self, path, data=None, expected=200):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        headers = {'Content-Type': 'application/json', 'X-Agent-Token': self.app.token}
        connection.request('GET' if data is None else 'POST', path,
                           None if data is None else json.dumps(data), headers)
        response = connection.getresponse()
        body = json.loads(response.read())
        result_headers = dict(response.getheaders())
        connection.close()
        self.assertEqual(response.status, expected, body)
        return body, result_headers

    def lifecycle(self, ref, action):
        return self.request('/api/knowledge/assets/' + quote(ref) + '/' + action, {})[0]

    def test_generate_edit_deposit_publish_revise_search_preview_and_export(self):
        second = self.knowledge(self.source['title'], '第二份来源的业务说明。')
        proposal, _ = self.request('/api/learning-proposals', dict(
            request_id='http-complete-flow', purpose='ontology', source_refs=[self.source['ref'], second['ref']],
            agent_id=self.agent['id'], agent_revision=self.agent['revision'], operational=True), expected=201)
        self.assertEqual(proposal['status'], 'DRAFT')
        self.assertEqual(len({node['label'] for node in proposal['output']['concepts']}), 2)

        value = content(self.source['ref'])
        value['concepts'][0].update(label='R', aliases=['A', 'C++', 'C#'])
        report, _ = self.request('/api/ontology-validate', dict(content=value, source_refs=[self.source['ref'], second['ref']]))
        self.assertTrue(report['conforms'])
        path = '/api/learning-proposals/' + proposal['id']
        proposal, _ = self.request(path, dict(revision=proposal['revision'], output=value))
        deposit = dict(revision=proposal['revision'], item_ids=['ontology'])
        deposited, _ = self.request(path + '/deposit', deposit)
        repeated, _ = self.request(path + '/deposit', deposit)
        self.assertEqual(deposited['receipt'], repeated['receipt'])
        ref = deposited['receipt']['assets'][0]['ref']
        self.request('/api/ontologies/' + quote(ref) + '/objects', expected=403)
        self.lifecycle(ref, 'review')
        self.lifecycle(ref, 'publish')

        prefix = '/api/ontologies/' + quote(ref)
        objects, _ = self.request(prefix + '/objects?type_id=change&query=C001')
        self.assertEqual([item['id'] for item in objects['items']], ['change-1'])
        preview, _ = self.request(prefix + '/action-preview', dict(
            action_id='draft', object_id='change-1', agent_id=self.agent['id'], agent_revision=self.agent['revision']))
        self.assertTrue(preview['available_to_agent'])
        self.assertFalse(preview['executed'])

        value['description'] = '经修订的业务对象本体'
        revised, _ = self.request(prefix + '/revise', dict(content=value), expected=201)
        self.assertEqual(revised['version'], 2)
        self.lifecycle(revised['ref'], 'review')
        self.lifecycle(revised['ref'], 'publish')
        self.knowledge('更新来源', '新版独有规则', id=self.source['id'], supersedes=self.source['ref'])
        query = urlencode({'query': 'C++'})
        expanded, _ = self.request('/api/ontology-search?' + query)
        self.assertEqual({item['ontology_ref'] for item in expanded['concepts']}, {revised['ref']})
        hits, _ = self.request('/api/knowledge/search', {'query': 'C++'})
        self.assertEqual([item['ref'] for item in hits['items']], [self.source['ref']])
        view, _ = self.request('/api/knowledge-hub?' + query)
        self.assertEqual([item['ref'] for item in view['knowledge']], [self.source['ref']])

        document, headers = self.request('/api/ontologies/' + quote(revised['ref']) + '/export')
        self.assertIn('application/ld+json', headers['Content-Type'])
        self.assertIn('ontology.jsonld', headers['Content-Disposition'])
        self.assertEqual(document['@graph'][0]['owl:versionInfo'], '2')
        self.assertIn('sh:NodeShape', {node.get('@type') for node in document['@graph']})
        self.lifecycle(self.source['ref'], 'withdraw')
        self.assertFalse(self.request('/api/ontologies/' + quote(revised['ref']) + '/validate')[0]['conforms'])
        self.assertEqual(self.request('/api/knowledge/search', {'query': 'C++'})[0]['items'], [])
        self.request('/api/ontologies/' + quote(revised['ref']) + '/objects', expected=403)

    def test_expired_ontology_blocks_objects_and_action_preview_but_keeps_history(self):
        asset = self.asset()
        prefix = '/api/ontologies/' + quote(asset['ref'])
        with patch('time.time', return_value=asset['effective_until']):
            report, _ = self.request(prefix + '/validate')
            self.assertFalse(report['conforms'])
            self.assertTrue(report['sources_current'])
            self.assertIn('AssetEffectiveConstraint', {result['constraint'] for result in report['results']})
            self.request(prefix + '/objects', expected=403)
            self.request(prefix + '/action-preview', dict(
                action_id='draft', object_id='change-1', agent_id=self.agent['id'], agent_revision=self.agent['revision']), expected=403)
            self.assertEqual(self.request('/api/ontology-search?' + urlencode({'query': '唯一变更别名'}))[0]['concepts'], [])
            self.assertIn('@graph', self.request(prefix + '/export')[0])
