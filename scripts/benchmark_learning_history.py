"""Measure proposal summaries on disposable history, without a model call."""
import argparse
import json
from pathlib import Path
import statistics
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from agent_framework import learning
from agent_framework.contracts import canonical
from agent_framework.web import Application


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--records',type=int,default=400)
    parser.add_argument('--body-kib',type=int,default=32)
    parser.add_argument('--repeats',type=int,default=3)
    args=parser.parse_args()
    if not 1<=args.records<=10000 or not 1<=args.body_kib<=128 or not 1<=args.repeats<=10:parser.error('Use 1–10000 records, 1–128 KiB and 1–10 repeats')
    with tempfile.TemporaryDirectory(prefix='learning-history-benchmark-') as temporary:
        app=Application(temporary)
        try:
            service=learning.Learning(app)
            with service.store.transaction() as db:
                for index in range(args.records):
                    value={'request_id':'request-'+str(index),'run_id':None,'agent_revision':1,'runtime':'mock','created_at':index,
                           'agent':{'name':'合成历史助手'},'error':None,'source_context':{'text':'x'*(args.body_kib*1024)},'output':{'summary':'合成摘要'}}
                    db.execute('INSERT INTO learning_proposals VALUES(?,?,?,?,?,?,?,?,?,?)',(*service._scope(),'proposal-'+str(index),value['request_id'],'ontology','',2,'DRAFT',canonical(value)))
            measurements=[];connect=service.store.connect;loads=json.loads
            for _ in range(args.repeats):
                queries=[];decoded=[]
                def traced():
                    db=connect();db.set_trace_callback(lambda sql:queries.append(sql) if sql.lstrip().upper().startswith('SELECT') else None);return db
                def decode(value,*a,**kw):decoded.append(len(value.encode() if isinstance(value,str) else value));return loads(value,*a,**kw)
                start=time.perf_counter()
                with patch.object(service.store,'connect',traced),patch.object(learning.json,'loads',decode):result=service.list()
                measurements.append({'seconds':time.perf_counter()-start,'selects':len(queries),'decoded_json_bytes':sum(decoded),'returned':len(result),'response_bytes':len(canonical(result).encode())})
            print(json.dumps({'records':args.records,'body_kib':args.body_kib,'model_calls':0,'measurements':measurements,'median_seconds':statistics.median(m['seconds'] for m in measurements)},ensure_ascii=False,indent=2))
        finally:app.close()


if __name__=='__main__':main()
