"""Scoped read cost and compatibility for experience and episodic memory lists."""
from dataclasses import replace
import json
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical
from agent_framework.experience import ExperienceService
from agent_framework.knowledge import Library
from agent_framework.knowledge_hub import hub
from agent_framework.memory import episodes
from agent_framework import knowledge as knowledge_module
from agent_framework.store import Store
from agent_framework.web import Application
from scripts.benchmark_library import seed,measure


class LibraryReadTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.library=self.app.library();self.access=self.app.library_access()
        seed(self.app,assets=8,experiences=12,memories=120,body_bytes=4096)
        self.service=ExperienceService(self.library.store)

    def decode(self,operation):
        values=[];loads=json.loads
        def record(value,*args,**kwargs):
            if isinstance(value,str):values.append(value)
            return loads(value,*args,**kwargs)
        with patch.object(json,'loads',record):result=operation()
        return result,values

    def legacy_episodes(self,query='',limit=12):
        with self.library.store.connect() as db:
            rows=db.execute('SELECT data FROM episodic_memories WHERE tenant=? AND project=? AND environment=? AND principal=? ORDER BY rowid DESC',(self.access.tenant,self.access.project,self.access.environment,self.access.principal)).fetchall()
        terms=set(knowledge_module.tokens(query));result=[]
        for row in rows:
            value=json.loads(row[0])
            if not terms or terms.intersection(knowledge_module.tokens(value['summary'])):result.append(value)
            if len(result)==limit:break
        return result

    def test_experience_reads_only_experience_bodies_and_latest_evaluation_metadata(self):
        result,decoded=self.decode(lambda:self.service.list(self.access))
        self.assertEqual(len(result),12)
        self.assertFalse(any('KNOWLEDGE_BODY_ONLY_' in value or 'EVALUATION_CASES_ONLY_' in value for value in decoded))
        self.assertTrue(all(a['latest_evaluation']['passed'] is True for a in result))
        self.assertTrue(all(a['latest_evaluation']['id']==a['id']+'-evaluation-1' for a in result))

    def test_experience_query_count_does_not_grow_per_asset(self):
        measurements,result=measure(lambda:self.service.list(self.access))
        self.assertEqual(len(result),12);self.assertLessEqual(measurements['selects'],2)

    def test_hub_decodes_each_asset_body_once_and_does_not_decode_evaluation_cases(self):
        record=Library._record;seen=[]
        def track(row):seen.append((row['id'],row['version']));return record(row)
        with patch.object(Library,'_record',side_effect=track):result,decoded=self.decode(lambda:hub(self.app))
        self.assertEqual(len(result['experience']),12);self.assertEqual(len(seen),20);self.assertEqual(len(set(seen)),20)
        self.assertFalse(any('EVALUATION_CASES_ONLY_' in value for value in decoded))

    def test_hub_counts_and_episode_limits_remain_compatible(self):
        all_items=hub(self.app);filtered=hub(self.app,'benchmarkneedle')
        self.assertEqual(all_items['counts'],filtered['counts']);self.assertEqual(all_items['counts']['episodes'],50)
        self.assertEqual(len(all_items['memory']['episodes']),50)
        self.assertEqual(filtered['memory']['episodes'],self.legacy_episodes('benchmarkneedle',50))
        self.assertEqual(len(filtered['knowledge']),1);self.assertEqual(len(filtered['experience']),1)

    def test_latest_evaluation_is_insertion_order_not_timestamp_or_success(self):
        asset=self.service.list(self.access)[0]
        with self.library.store.transaction() as db:
            value={'id':'last-failed','ref':asset['ref'],'passed':False,'created_at':-1,'cases':['LARGE_UNUSED_CASE']}
            db.execute('INSERT INTO experience_evaluations VALUES(?,?,?,?,?,?)',(self.access.tenant,asset['id'],asset['version'],value['id'],'hash',canonical(value)))
        found=next(a for a in self.service.list(self.access) if a['ref']==asset['ref'])
        self.assertEqual(found['latest_evaluation'],{'id':'last-failed','passed':False,'created_at':-1})

    def test_evaluation_metadata_belongs_to_the_exact_asset_version(self):
        asset=self.service.list(self.access)[0]
        with self.library.store.transaction() as db:
            row=db.execute('SELECT * FROM asset_versions WHERE tenant=? AND id=?',(self.access.tenant,asset['id'])).fetchone()
            db.execute('INSERT INTO asset_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',(row['tenant'],row['id'],2,row['project'],row['environment'],row['owner'],row['visibility'],row['kind'],row['space'],'CANDIDATE',row['data'],row['hash'],999))
        items={a['ref']:a for a in self.service.list(self.access)}
        self.assertNotIn('latest_evaluation',items[asset['id']+'@2']);self.assertEqual(items[asset['ref']]['latest_evaluation'],asset['latest_evaluation'])

    def test_asset_status_and_evaluation_metadata_share_a_read_snapshot(self):
        original=Library._record;changed=[]
        def mutate_after_read(row):
            result=original(row)
            if row['kind']=='EXPERIENCE' and not changed:
                changed.append(result['ref'])
                with self.library.store.transaction() as db:
                    db.execute("UPDATE asset_versions SET status='WITHDRAWN' WHERE tenant=? AND id=?",(self.access.tenant,result['id']))
                    value={'id':'concurrent-failure','ref':result['ref'],'passed':False,'created_at':-1}
                    db.execute('INSERT INTO experience_evaluations VALUES(?,?,?,?,?,?)',(self.access.tenant,result['id'],result['version'],value['id'],'hash',canonical(value)))
            return result
        with patch.object(Library,'_record',side_effect=mutate_after_read):items=self.service.list(self.access)
        first=next(a for a in items if a['ref']==changed[0]);self.assertEqual(first['status'],'EVALUATED');self.assertTrue(first['latest_evaluation']['passed'])
        latest=next(a for a in self.service.list(self.access) if a['ref']==changed[0]);self.assertEqual(latest['status'],'WITHDRAWN');self.assertFalse(latest['latest_evaluation']['passed'])

    def test_private_other_scope_records_are_not_decoded_or_included(self):
        with self.library.store.transaction() as db:
            db.execute("UPDATE asset_versions SET visibility='PRIVATE' WHERE kind='EXPERIENCE'")
            row=db.execute("SELECT * FROM asset_versions WHERE kind='EXPERIENCE' LIMIT 1").fetchone()
            for i,(tenant,project,environment,owner) in enumerate([(self.access.tenant,self.access.project,self.access.environment,'other-user'),('other-tenant',self.access.project,self.access.environment,self.access.principal),(self.access.tenant,'other-project',self.access.environment,self.access.principal),(self.access.tenant,self.access.project,'production',self.access.principal)]):
                identity='foreign-experience-'+str(i)
                db.execute('INSERT INTO asset_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',(tenant,identity,1,project,environment,owner,'PRIVATE','EXPERIENCE',row['space'],'EVALUATED','INVALID_UNAUTHORIZED_JSON','hash',999))
                db.execute('INSERT INTO experience_evaluations VALUES(?,?,?,?,?,?)',(tenant,identity,1,'foreign-evaluation-'+str(i),'hash','INVALID_UNAUTHORIZED_JSON'))
                db.execute('INSERT INTO episodic_memories VALUES(?,?,?,?,?,?)',(tenant,'foreign-run-'+str(i),project,environment,owner,'INVALID_UNAUTHORIZED_JSON'))
        self.assertEqual(len(self.service.list(self.access)),12)
        self.assertEqual(self.service.list(replace(self.access,principal='not-an-owner')),[])
        self.assertEqual(episodes(self.library.store,self.access,'benchmarkneedle',50),self.legacy_episodes('benchmarkneedle',50))

    def test_episode_matching_order_and_limits_match_the_existing_contract(self):
        for query in ['', 'benchmarkneedle','ordinary','!!!','Z','notpresent']:
            for limit in [1,12,50]:
                with self.subTest(query=query,limit=limit):self.assertEqual(episodes(self.library.store,self.access,query,limit),self.legacy_episodes(query,limit))

    def test_episode_search_does_not_decode_nonmatching_full_bodies(self):
        result,decoded=self.decode(lambda:episodes(self.library.store,self.access,'benchmarkneedle',50))
        full=[json.loads(v) for v in decoded if 'EPISODE_BODY_ONLY_' in v]
        self.assertEqual(len(result),3);self.assertEqual(full,result)

    def test_episode_empty_search_only_decodes_requested_records(self):
        result,decoded=self.decode(lambda:episodes(self.library.store,self.access,'',12))
        self.assertEqual(len(result),12);self.assertEqual(len(decoded),12)

    def test_episode_filter_uses_summary_not_other_body_fields(self):
        self.assertEqual(episodes(self.library.store,self.access,'EPISODE_BODY_ONLY',50),[])

    def test_episode_projection_and_body_reads_share_a_snapshot(self):
        tokenise=knowledge_module.tokens;changed=[]
        def change_during_match(value):
            if value=='benchmarkneedle summary 100' and not changed:
                changed.append(True)
                with self.library.store.transaction() as db:
                    raw=db.execute("SELECT data FROM episodic_memories WHERE run_id='bench-run-100'").fetchone()[0];record=json.loads(raw);record['actions']=[{'details':'changed-after-summary'}]
                    db.execute("UPDATE episodic_memories SET data=? WHERE run_id='bench-run-100'",(canonical(record),))
            return tokenise(value)
        with patch.object(knowledge_module,'tokens',side_effect=change_during_match):result=episodes(self.library.store,self.access,'benchmarkneedle',1)
        self.assertTrue(changed);self.assertIn('EPISODE_BODY_ONLY_',result[0]['actions'][0]['details'])
        self.assertEqual(episodes(self.library.store,self.access,'benchmarkneedle',1)[0]['actions'][0]['details'],'changed-after-summary')

    def test_episode_parameter_validation_remains_explicit(self):
        for query,limit in [(None,12),('x'*2001,12),('',0),('',51),('',True)]:
            with self.subTest(query=query,limit=limit),self.assertRaises(ValueError):episodes(self.library.store,self.access,query,limit)


if __name__=='__main__':unittest.main()
