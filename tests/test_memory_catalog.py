"""Private episode history paging keeps a stable window and legacy callers."""
import base64
from dataclasses import replace
import http.client
import json
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from agent_framework import memory
from agent_framework.contracts import canonical
from agent_framework.knowledge_hub import hub
from agent_framework.web import Application,WebServer
from scripts.benchmark_library import seed


class MemoryCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        seed(self.app,assets=0,experiences=0,memories=137,body_bytes=4096)
        self.store=self.app.library().store;self.access=self.app.library_access()

    def page(self,query='',limit=50,cursor=None,access=None):
        return memory.page(self.store,access or self.access,query,limit=limit,cursor=cursor)

    def append(self,identity='new-record',summary='ordinary newest',access=None):
        access=access or self.access;body={'run_id':identity,'summary':summary,'outcome':'SUCCEEDED','domain_pack_ref':'general-assistant@1.0.0','archived_at':0,'actions':[]}
        with self.store.transaction() as db:db.execute('INSERT INTO episodic_memories VALUES(?,?,?,?,?,?)',(access.tenant,identity,access.project,access.environment,access.principal,canonical(body)))

    def test_all_records_are_reachable_in_stable_newest_first_pages(self):
        cursor=None;seen=[];sizes=[]
        while True:
            page=self.page(cursor=cursor);self.assertEqual(page['total'],137);self.assertEqual(page['filtered_total'],137);self.assertEqual(page['offset'],len(seen));self.assertEqual(page['newer_count'],0)
            seen.extend(e['run_id'] for e in page['episodes']);sizes.append(len(page['episodes']))
            if not page['has_more']:self.assertIsNone(page['next_cursor']);break
            cursor=page['next_cursor']
        self.assertEqual(sizes,[50,50,37]);self.assertEqual(seen,['bench-run-'+str(i) for i in range(136,-1,-1)])

    def test_search_counts_matches_and_preserves_summary_only_matching(self):
        one=self.page('benchmarkneedle',2);two=self.page('benchmarkneedle',2,one['next_cursor'])
        self.assertEqual(one['filtered_total'],3);self.assertEqual(one['total'],137)
        self.assertEqual([e['run_id'] for e in one['episodes']+two['episodes']],['bench-run-100','bench-run-50','bench-run-0'])
        self.assertEqual(two['offset'],2);self.assertFalse(two['has_more'])
        self.assertEqual(self.page('EPISODE_BODY_ONLY')['filtered_total'],0)
        self.assertEqual(self.page('!!!')['filtered_total'],137)

    def test_new_records_do_not_shift_the_active_window_or_previous_page(self):
        first=self.page();self.append();self.append('second-new')
        next_page=self.page(cursor=first['next_cursor']);back=self.page(cursor=first['cursor'])
        self.assertEqual(next_page['newer_count'],2);self.assertEqual(back['newer_count'],2);self.assertEqual(next_page['total'],137)
        self.assertEqual(back['episodes'],first['episodes']);self.assertEqual(next_page['episodes'][0]['run_id'],'bench-run-86')
        latest=self.page();self.assertEqual(latest['total'],139);self.assertEqual(latest['episodes'][0]['run_id'],'second-new')

    def test_cursors_cannot_be_reused_for_different_query_limit_or_scope(self):
        cursor=self.page(limit=2)['next_cursor']
        for kwargs in [{'query':'ordinary','limit':2},{'limit':3},{'limit':2,'access':replace(self.access,principal='other')},{'limit':2,'access':replace(self.access,tenant='other')},{'limit':2,'access':replace(self.access,project='other')}]:
            with self.subTest(kwargs=kwargs),self.assertRaises(ValueError):self.page(cursor=cursor,**kwargs)

    def test_invalid_sizes_queries_and_cursor_shapes_are_rejected(self):
        for limit in [0,51,True,1.5,'-1','1.0','５０','9999']:
            with self.subTest(limit=limit),self.assertRaises(ValueError):self.page(limit=limit)
        for query in [None,{},'x'*2001]:
            with self.subTest(query=query),self.assertRaises(ValueError):self.page(query)
        original=self.page()['cursor'];value=json.loads(base64.urlsafe_b64decode(original+'='*(-len(original)%4)))
        bad=['bad','x'*2049,42]
        for change in [{'upper':True},{'before':0},{'before':value['upper']+2},{'upper':-1},{'v':True},{'extra':1}]:bad.append(base64.urlsafe_b64encode(canonical({**value,**change}).encode()).decode())
        for cursor in bad:
            with self.subTest(cursor=str(cursor)[:50]),self.assertRaises(ValueError):self.page(cursor=cursor)

    def test_only_selected_full_bodies_are_decoded(self):
        original=json.loads;decoded=[]
        def track(value,*args,**kwargs):
            if isinstance(value,str) and 'EPISODE_BODY_ONLY_' in value:decoded.append(value)
            return original(value,*args,**kwargs)
        with patch.object(json,'loads',track):page=self.page('benchmarkneedle',2)
        self.assertEqual(len(decoded),2);self.assertEqual(len(page['episodes']),2)

    def test_other_scope_records_do_not_affect_counts_or_parsing(self):
        with self.store.transaction() as db:
            for index,(tenant,project,environment,owner) in enumerate([(self.access.tenant,self.access.project,'test','other'),('other',self.access.project,'test',self.access.principal),(self.access.tenant,'other','test',self.access.principal),(self.access.tenant,self.access.project,'production',self.access.principal)]):
                db.execute('INSERT INTO episodic_memories VALUES(?,?,?,?,?,?)',(tenant,'foreign-'+str(index),project,environment,owner,'INVALID_UNAUTHORIZED_JSON'))
        self.assertEqual(self.page()['total'],137);self.assertEqual(self.page('benchmarkneedle')['filtered_total'],3)

    def test_counts_summaries_and_full_records_share_one_read_snapshot(self):
        from agent_framework import knowledge
        tokenise=knowledge.tokens;changed=[]
        def change_during_match(value):
            if value=='benchmarkneedle summary 100' and not changed:
                changed.append(True);self.append('concurrent-new')
                with self.store.transaction() as db:
                    raw=db.execute("SELECT data FROM episodic_memories WHERE run_id='bench-run-100'").fetchone()[0]
                    record=json.loads(raw);record['actions']=[]
                    db.execute("UPDATE episodic_memories SET data=? WHERE run_id='bench-run-100'",(canonical(record),))
            return tokenise(value)
        with patch.object(knowledge,'tokens',side_effect=change_during_match):current=self.page('benchmarkneedle',2)
        self.assertTrue(changed);self.assertEqual(current['total'],137);self.assertEqual(current['newer_count'],0)
        self.assertIn('EPISODE_BODY_ONLY_',current['episodes'][0]['actions'][0]['details'])
        again=self.page('benchmarkneedle',2,current['cursor']);self.assertEqual(again['newer_count'],1);self.assertEqual(again['episodes'][0]['actions'],[])

    def test_empty_window_can_report_new_records_without_silently_replacing_it(self):
        access=replace(self.access,principal='new-owner');empty=self.page(access=access)
        self.assertEqual(empty['episodes'],[]);self.assertEqual(empty['total'],0);self.assertFalse(empty['has_more'])
        self.append('new-owner-record',access=access);again=self.page(cursor=empty['cursor'],access=access)
        self.assertEqual(again['episodes'],[]);self.assertEqual(again['newer_count'],1);self.assertEqual(self.page(access=access)['total'],1)

    def test_legacy_episode_and_hub_shapes_remain_compatible(self):
        self.assertEqual(len(memory.episodes(self.store,self.access)),12)
        legacy=hub(self.app);self.assertEqual(legacy['counts']['episodes'],50);self.assertNotIn('episode_page',legacy['memory'])
        current=hub(self.app,memory_page=True);self.assertEqual(current['counts']['episodes'],137);self.assertEqual(len(current['memory']['episodes']),50);self.assertTrue(current['memory']['episode_page']['has_more'])
        self.assertEqual(current['knowledge'],legacy['knowledge']);self.assertEqual(current['capabilities'],legacy['capabilities'])

    def server(self):
        server=WebServer(('127.0.0.1',0),self.app);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join(3)))
        def get(path):
            connection=http.client.HTTPConnection('127.0.0.1',server.server_address[1],timeout=5)
            try:connection.request('GET',path,headers={'X-Agent-Workspace':self.app.workspace['id']});response=connection.getresponse();return response.status,json.loads(response.read())
            finally:connection.close()
        return get

    def test_http_explicit_memory_pages_and_invalid_requests(self):
        get=self.server();status,legacy=get('/api/memory');self.assertEqual(status,200);self.assertEqual(set(legacy),{'episodes'});self.assertEqual(len(legacy['episodes']),12)
        status,first=get('/api/memory?view=page&limit=50');self.assertEqual(status,200);self.assertEqual(first['total'],137)
        status,second=get('/api/memory?'+urlencode({'view':'page','limit':50,'cursor':first['next_cursor']}));self.assertEqual(status,200);self.assertEqual(second['offset'],50)
        for url in ['/api/memory?view=invalid','/api/memory?view=page&limit=0','/api/memory?view=page&cursor=invalid','/api/memory?view=page&limit=1&limit=2','/api/memory?cursor=invalid','/api/memory?view=page&cursor=','/api/memory?view=page&limit=&limit=2']:
            self.assertEqual(get(url)[0],400,url)

    def test_http_hub_opt_in_and_paged_memory_scope(self):
        get=self.server();status,first=get('/api/knowledge-hub?memory_page=1');self.assertEqual(status,200);page=first['memory']['episode_page'];self.assertEqual(first['counts']['episodes'],137)
        status,second=get('/api/knowledge-hub?'+urlencode({'memory_page':1,'memory_cursor':page['next_cursor']}));self.assertEqual(status,200);self.assertEqual(second['memory']['episode_page']['offset'],50)
        for url in ['/api/knowledge-hub?memory_page=2','/api/knowledge-hub?memory_cursor=invalid','/api/knowledge-hub?memory_page=1&memory_limit=0','/api/knowledge-hub?memory_page=1&memory_page=0','/api/knowledge-hub?memory_page=&memory_page=1','/api/knowledge-hub?memory_page=1&memory_cursor=']:
            self.assertEqual(get(url)[0],400,url)


if __name__=='__main__':unittest.main()
