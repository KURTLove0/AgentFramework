"""Measure narrow knowledge retrieval over isolated synthetic version history."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import statistics
import tempfile
import time

from agent_framework.knowledge import Access,Library,insert_asset


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets',type=int,default=1000)
    parser.add_argument('--versions',type=int,default=5)
    parser.add_argument('--samples',type=int,default=10)
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    if not 1<=args.assets<=10000 or not 1<=args.versions<=20 or not 1<=args.samples<=100:raise ValueError('benchmark bounds exceeded')
    with tempfile.TemporaryDirectory(prefix='agent-retrieval-benchmark-') as directory:
        library=Library(Path(directory)/'runtime.sqlite3');access=Access('benchmark','reviewer','project',roles=('curator',))
        target=library.create(access,{'title':'唯一检索目标','content':{'text':'performance-target-token'},'effective_at':0,'effective_until':4102444800})
        library.transition(access,target['ref'],'REVIEW');library.transition(access,target['ref'],'PUBLISHED')
        body={k:v for k,v in target.items() if k not in {'ref','id','version','kind','status','owner','tenant_id','project_id','environment','visibility','content_hash'}}
        with library.store.transaction() as db:
            for index in range(args.assets):
                for version in range(1,args.versions+1):
                    sample=deepcopy(body);sample['title']='历史资料 '+str(index)
                    sample['content']={'text':'这是一份无关的合成历史资料。'*100}
                    insert_asset(db,access,'benchmark-'+str(index),version,'KNOWLEDGE',sample,'PUBLISHED')
        durations=[]
        for _ in range(args.samples):
            start=time.perf_counter();result=library.search(access,'performance-target-token');durations.append((time.perf_counter()-start)*1000)
            assert [item['ref'] for item in result['items']]==[target['ref']]
        report={'synthetic_versions':args.assets*args.versions+1,'samples':args.samples,'matches':1,
                'median_ms':round(statistics.median(durations),2),'maximum_ms':round(max(durations),2),
                'scope':'single-process narrow retrieval; not a sustained concurrency or full-list benchmark'}
        if args.output:args.output.write_text(json.dumps(report,indent=2))
        print(json.dumps(report,indent=2))


if __name__=='__main__':main()
