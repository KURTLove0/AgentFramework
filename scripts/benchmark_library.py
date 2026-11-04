"""Measure scoped library reads using disposable synthetic assets and episodes."""
import argparse
import hashlib
import json
from pathlib import Path
from statistics import median
import sys
import tempfile
import time
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from agent_framework.contracts import canonical
from agent_framework.knowledge import SPACE,insert_asset
from agent_framework.knowledge_hub import hub
from agent_framework.store import Store
from agent_framework.web import Application


def seed(app,assets=200,experiences=200,memories=800,body_bytes=8192):
    library=app.library();access=app.library_access()
    with library.store.transaction() as db:
        for kind,count in [('KNOWLEDGE',assets),('EXPERIENCE',experiences)]:
            for index in range(count):
                identity='bench-'+kind.lower()+'-'+str(index)
                key='benchmarkneedle' if index%50==0 else 'ordinary'
                content={'text':key+' KNOWLEDGE_BODY_ONLY_'+'x'*body_bytes} if kind=='KNOWLEDGE' else {'lesson':key+' lesson','category':'evidence-first','supporting_runs':[]}
                body={'title':key+' '+identity,'content':content,'space_ref':SPACE,'source_uri':'local:benchmark','source_version':'1','observed_at':1,'effective_at':0,'effective_until':4102444800,'access_policy_ref':'task-scope-owner@1.0.0','sensitivity':'project','critical':False,'conflict_key':'','supersedes':None,'standard_ref':None}
                insert_asset(db,access,identity,1,kind,body,'DRAFT' if kind=='KNOWLEDGE' else 'EVALUATED')
                db.execute('UPDATE asset_versions SET created=? WHERE tenant=? AND id=?',(index+1,access.tenant,identity))
                if kind=='EXPERIENCE':
                    for attempt in range(2):
                        key=identity+'-evaluation-'+str(attempt)
                        value={'id':key,'ref':identity+'@1','passed':attempt==1,'created_at':attempt+1,'cases':[{'details':'EVALUATION_CASES_ONLY_'+'x'*body_bytes*4}]}
                        db.execute('INSERT INTO experience_evaluations VALUES(?,?,?,?,?,?)',(access.tenant,identity,1,key,'synthetic-hash',canonical(value)))
        for index in range(memories):
            key='benchmarkneedle' if index%50==0 else 'ordinary'
            value={'run_id':'bench-run-'+str(index),'summary':key+' summary '+str(index),'outcome':'SUCCEEDED','domain_pack_ref':'general-assistant@1.0.0','archived_at':index,'actions':[{'details':'EPISODE_BODY_ONLY_'+'x'*body_bytes}]}
            db.execute('INSERT INTO episodic_memories VALUES(?,?,?,?,?,?)',(access.tenant,value['run_id'],access.project,access.environment,access.principal,canonical(value)))


def measure(operation):
    statements=[];decoded=[];connect=Store.connect;loads=json.loads
    def traced(store):
        db=connect(store);db.set_trace_callback(statements.append);return db
    def decode(value,*args,**kwargs):
        if isinstance(value,str):decoded.append(len(value.encode()))
        return loads(value,*args,**kwargs)
    started=time.perf_counter()
    with patch.object(Store,'connect',traced),patch.object(json,'loads',decode):value=operation()
    payload=canonical(value).encode()
    return {'seconds':round(time.perf_counter()-started,6),'selects':sum(s.lstrip().upper().startswith('SELECT') for s in statements),'python_json_input_bytes':sum(decoded),'python_json_decodes':len(decoded),'response_bytes':len(payload),'response_sha256':hashlib.sha256(payload).hexdigest()},value


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets',type=int,default=200);parser.add_argument('--experiences',type=int,default=200)
    parser.add_argument('--memories',type=int,default=800);parser.add_argument('--body-bytes',type=int,default=8192)
    parser.add_argument('--repeats',type=int,default=3);args=parser.parse_args()
    if not(0<=args.assets<=1000 and 0<=args.experiences<=1000 and 0<=args.memories<=10000 and 1<=args.body_bytes<=65536 and 1<=args.repeats<=10) or (args.assets+args.memories+8*args.experiences)*args.body_bytes>128*1024*1024:
        parser.error('Invalid fixture size or synthetic data budget above 128 MiB')
    measurements={}
    with tempfile.TemporaryDirectory(prefix='library-read-benchmark-') as directory:
        app=Application(directory)
        try:
            seed(app,args.assets,args.experiences,args.memories,args.body_bytes)
            for index in range(args.repeats):
                for query in (['','benchmarkneedle'] if index%2==0 else ['benchmarkneedle','']):
                    row,value=measure(lambda:hub(app,query));measurements.setdefault(query or 'all',[]).append(row)
        finally:app.close()
    print(json.dumps({'fixture':vars(args),'queries':{q:{'median_seconds':median(v['seconds'] for v in rows),'measurements':rows} for q,rows in measurements.items()}},indent=2))


if __name__=='__main__':main()
