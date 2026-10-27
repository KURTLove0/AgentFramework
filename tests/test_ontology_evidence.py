from copy import deepcopy
import unittest

from agent_framework.contracts import PolicyDenied
from agent_framework.knowledge import Access
from agent_framework.ontology import revise
from agent_framework.ontology_evidence import read, save, records
from agent_framework.runtime_config import ConfigConflict
from test_ontology_regressions import OntologyFixture
import test_audit_improvements as audit


class OntologyEvidenceTests(OntologyFixture):
    def payload(self, **kw):
        return dict(path='relation:change:PRODUCES:report', source_ref=self.source['ref'], quote='产出报告 R001', reviewed=False, revision=0) | kw

    def test_quotes_are_bound_to_assertion_source_hash_offsets_and_human_review(self):
        asset = self.asset()
        initial = read(self.lib, self.access, asset['ref'])
        self.assertTrue(initial['editable'])
        self.assertTrue(any(a['path'] == 'property:change:score' for a in initial['assertions']))
        record = save(self.lib, self.access, asset['ref'], self.payload())
        self.assertEqual(self.source['content']['text'][record['start']:record['end']], record['quote'])
        self.assertEqual(record['source_hash'], self.source['content_hash'])
        self.assertIsNone(record['reviewer'])
        reviewed = save(self.lib, self.access, asset['ref'], self.payload(revision=1, reviewed=True))
        self.assertEqual(reviewed['revision'], 2)
        self.assertEqual(reviewed['reviewer'], self.access.principal)
        self.assertEqual(len(read(self.lib, self.access, asset['ref'])['records']), 1)
        with self.assertRaises(ConfigConflict):
            save(self.lib, self.access, asset['ref'], self.payload())

    def test_fabricated_quotes_unknown_paths_and_unrelated_sources_are_rejected(self):
        asset = self.asset()
        unrelated = self.knowledge('其他事实', '其他资料原文。')
        for kw in [dict(quote='来源没有说过的事实'), dict(path='concept:missing'), dict(source_ref=unrelated['ref']), dict(reviewed='yes')]:
            with self.subTest(kw=kw), self.assertRaises(ValueError):
                save(self.lib, self.access, asset['ref'], self.payload(**kw))
        self.assertEqual(read(self.lib, self.access, asset['ref'])['records'], [])

    def test_evidence_is_private_versioned_and_withdrawn_sources_block_new_reviews(self):
        asset = self.asset()
        save(self.lib, self.access, asset['ref'], self.payload())
        next_version = revise(self.lib, self.access, asset['ref'], dict(content=deepcopy(asset['content'])))
        self.assertEqual(read(self.lib, self.access, next_version['ref'])['records'], [])
        other = Access(self.access.tenant, 'other', self.access.project, roles=('curator',))
        with self.assertRaises(KeyError):
            read(self.lib, other, asset['ref'])
        with self.assertRaises(KeyError):
            records(self.lib, other, asset)
        with self.assertRaises(KeyError):
            save(self.lib, other, asset['ref'], self.payload())
        self.lib.transition(self.access, self.source['ref'], 'WITHDRAWN')
        history = read(self.lib, self.access, asset['ref'])
        self.assertFalse(history['editable'])
        self.assertEqual(history['sources'], [])
        self.assertEqual(len(history['records']), 1)
        with self.assertRaises(ConfigConflict):
            save(self.lib, self.access, asset['ref'], self.payload(revision=1))


class OntologyEvidenceHTTPTests(OntologyFixture):
    setUp = audit.AuditImprovementHTTPTests.setUp
    request = audit.AuditImprovementHTTPTests.request
    payload = OntologyEvidenceTests.payload

    def test_quote_review_roundtrips_through_http_and_jsonld_export(self):
        asset = self.asset()
        prefix = '/api/ontologies/' + asset['ref']
        view, _ = self.request(prefix + '/evidence')
        self.assertTrue(view['editable'])
        record, _ = self.request(prefix + '/evidence', self.payload(reviewed=True))
        self.assertTrue(record['reviewed'])
        self.request(prefix + '/evidence', self.payload(), expected=409)
        document, _ = self.request(prefix + '/export')
        evidence = [n for n in document['@graph'] if n.get('@type') == 'af:AssertionEvidence']
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]['rdf:value'], self.payload()['quote'])
        self.assertTrue(evidence[0]['af:reviewed'])
