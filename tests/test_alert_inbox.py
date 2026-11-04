"""Every private pending alert remains actionable beyond the old recent list."""
import base64
from copy import copy
import http.client
import json
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from agent_framework.agent_evaluation import AgentEvaluations
from agent_framework.contracts import canonical
from agent_framework.web import Application,WebServer


def seed_alerts(app,open_count=61,acknowledged_count=230):
    service=AgentEvaluations(app)
    with service.store.transaction() as db:
        for i in range(open_count+acknowledged_count):
            value={'id':'inbox-alert-'+str(i),'evaluation_id':'inbox-evaluation-'+str(i),'run_id':'inbox-run-'+str(i),
                   'agent_id':'inbox-agent-'+str(i%2),'agent_name':'提醒助手 '+str(i%2),'score':40,'threshold':80,
                   'reasons':['验收未通过'],'message':'待核对记录 '+str(i),'padding':'ALERT_BODY_ONLY_'+'x'*2048}
            db.execute('INSERT INTO agent_alerts VALUES(?,?,?,?,?,?,?,?)',(*service.scope,value['id'],value['evaluation_id'],canonical(value),None if i<open_count else i+1,i//2+1))


class AlertInboxTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.service=AgentEvaluations(self.app);seed_alerts(self.app)

    def test_old_pending_alerts_are_not_hidden_by_new_acknowledged_records(self):
        legacy=self.service.overview()
        self.assertEqual(legacy['open_alert_count'],61);self.assertTrue(all(a['acknowledged_at'] for a in legacy['alerts']))
        page=self.service.alert_page()
        self.assertEqual(page['counts'],{'open':61,'acknowledged':230,'all':291})
        self.assertEqual(len(page['alerts']),50);self.assertEqual(page['alerts'][0]['id'],'inbox-alert-60')
        self.assertTrue(all(a['acknowledged_at'] is None for a in page['alerts']))

    def test_every_alert_can_be_paged_once_and_statuses_filter_before_limit(self):
        for status,count in [('open',61),('acknowledged',230),('all',291)]:
            ids=[];cursor=None
            while True:
                page=self.service.alert_page(status,limit=17,cursor=cursor);ids.extend(a['id'] for a in page['alerts'])
                if not page['has_more']:self.assertIsNone(page['next_cursor']);break
                cursor=page['next_cursor']
            self.assertEqual(len(ids),count);self.assertEqual(len(set(ids)),count)
        self.assertEqual(ids,['inbox-alert-'+str(i) for i in range(290,-1,-1)])

    def test_agent_filter_and_counts_apply_before_paging(self):
        page=self.service.alert_page(agent_id='inbox-agent-0')
        self.assertEqual(page['counts'],{'open':31,'acknowledged':115,'all':146})
        self.assertEqual(len(page['alerts']),31);self.assertTrue(all(a['agent_id']=='inbox-agent-0' for a in page['alerts']))
        self.assertEqual({a['id'] for a in page['agents']},{'inbox-agent-0','inbox-agent-1'})
        self.assertEqual(self.service.alert_page(agent_id='missing')['alerts'],[])

    def test_acknowledgement_keeps_first_timestamp_and_full_history(self):
        first=self.service.alert_page();identity=first['alerts'][0]['id']
        receipt=self.service.acknowledge(identity);again=self.service.acknowledge(identity)
        self.assertTrue(receipt['acknowledged']);self.assertEqual(receipt['acknowledged_at'],again['acknowledged_at'])
        self.assertEqual(self.service.alert_page()['counts']['open'],60)
        self.assertNotIn(identity,[a['id'] for a in self.service.alert_page()['alerts']])
        self.assertEqual(self.service.alert_page('acknowledged')['counts'],{'open':60,'acknowledged':231,'all':291})

    def test_acknowledging_previous_page_does_not_skip_the_next_page(self):
        first=self.service.alert_page();self.service.acknowledge(first['alerts'][0]['id'])
        second=self.service.alert_page(cursor=first['next_cursor'])
        self.assertEqual([a['id'] for a in second['alerts']],['inbox-alert-'+str(i) for i in range(10,-1,-1)])

    def test_invalid_parameters_and_reused_cursors_are_rejected(self):
        cursor=self.service.alert_page(limit=2)['next_cursor']
        for kwargs in [{'status':'invalid'},{'status':[]},{'limit':0},{'limit':51},{'limit':True},{'limit':'５０'},{'limit':'1000'},{'cursor':'bad'},{'cursor':''},{'cursor':42},{'cursor':cursor,'limit':3},{'cursor':cursor,'limit':2,'status':'all'},{'cursor':cursor,'limit':2,'agent_id':'inbox-agent-0'}]:
            with self.subTest(kwargs=kwargs),self.assertRaises(ValueError):self.service.alert_page(**kwargs)
        value=json.loads(base64.urlsafe_b64decode(cursor+'='*(-len(cursor)%4)))
        for extra in [{'before':True},{'before':0},{'v':True},{'extra':1}]:
            bad=base64.urlsafe_b64encode(canonical({**value,**extra}).encode()).decode()
            with self.assertRaises(ValueError):self.service.alert_page(limit=2,cursor=bad)

    def test_other_scopes_neither_leak_nor_decode(self):
        with self.service.store.transaction() as db:
            for i,scope in enumerate([('other',*self.service.scope[1:]),(self.app.tenant,'other',self.app.principal),(self.app.tenant,self.service.scope[1],'other')]):
                db.execute('INSERT INTO agent_alerts VALUES(?,?,?,?,?,?,?,?)',(*scope,'foreign-'+str(i),'foreign-eval-'+str(i),'INVALID_PRIVATE_JSON',None,999))
        self.assertEqual(self.service.alert_page(agent_id='inbox-agent-0')['counts']['open'],31)
        cursor=self.service.alert_page()['next_cursor'];other=copy(self.service);other.scope=(self.app.tenant,self.service.scope[1],'other')
        with self.assertRaises(ValueError):other.alert_page(cursor=cursor)
        with self.assertRaises(KeyError):self.service.acknowledge('foreign-2')

    def test_only_one_page_of_full_alerts_is_decoded(self):
        original=json.loads;decoded=[]
        def load(value,*args,**kwargs):
            if isinstance(value,str) and 'ALERT_BODY_ONLY_' in value:decoded.append(value)
            return original(value,*args,**kwargs)
        with patch.object(json,'loads',side_effect=load):page=self.service.alert_page(limit=7)
        self.assertEqual(len(page['alerts']),7);self.assertEqual(len(decoded),7)

    def test_counts_and_alerts_share_one_read_snapshot(self):
        connect=self.service.store.connect;changed=[]
        def traced():
            db=connect()
            def trace(sql):
                if sql.startswith('SELECT rowid,data,acknowledged') and not changed:
                    changed.append(True)
                    with connect() as writer:writer.execute("UPDATE agent_alerts SET acknowledged=123 WHERE id='inbox-alert-60'")
            db.set_trace_callback(trace);return db
        with patch.object(self.service.store,'connect',side_effect=traced):page=self.service.alert_page()
        self.assertTrue(changed);self.assertEqual(page['counts']['open'],61)
        self.assertEqual(page['alerts'][0]['id'],'inbox-alert-60');self.assertIsNone(page['alerts'][0]['acknowledged_at'])
        self.assertEqual(self.service.alert_page()['counts']['open'],60)

    def test_http_paging_and_validation(self):
        server=WebServer(('127.0.0.1',0),self.app);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join(3)))
        def get(path):
            connection=http.client.HTTPConnection('127.0.0.1',server.server_address[1],timeout=5)
            try:connection.request('GET',path);reply=connection.getresponse();return reply.status,json.loads(reply.read())
            finally:connection.close()
        status,page=get('/api/agent-alerts');self.assertEqual(status,200);self.assertEqual(len(page['alerts']),50)
        status,next_page=get('/api/agent-alerts?'+urlencode({'cursor':page['next_cursor']}));self.assertEqual(status,200);self.assertEqual(len(next_page['alerts']),11)
        for query in ['status=bad','limit=0','cursor=','status=open&status=all','limit=&limit=2','agent_id=bad%20identifier']:
            self.assertEqual(get('/api/agent-alerts?'+query)[0],400,query)


if __name__=='__main__':unittest.main()
