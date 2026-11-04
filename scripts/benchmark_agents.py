"""Measure Agent catalog reads and response serialization with synthetic skills."""
import argparse
from copy import deepcopy
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
from agent_framework.agents import AgentRegistry
from agent_framework import agents as agent_module
from agent_framework.contracts import canonical
from agent_framework.definitions import default_definition
from agent_framework.skills import normalize_package
from agent_framework.store import Store


def seed(registry,heads,bindings,body_bytes):
    packages=[]
    for index in range(bindings):
        name='catalog-method-'+str(index)
        package,_=normalize_package(name,{'SKILL.md':{'encoding':'utf-8','content':'---\nname: '+name+'\ndescription: 整理材料与核对来源\n---\n\n按需核对 [来源](references/source.md)。\n'},
            'references/source.md':{'encoding':'utf-8','content':('catalog-resource-'+str(index)+'\n'+'x'*body_bytes)[:body_bytes]}})
        packages.append({'ref':'skill-catalog-'+str(index)+'@1','skill_id':'skill-catalog-'+str(index),'version':1,'enabled':True,'package':package})
    with registry.store.transaction() as db:
        for index in range(heads):
            name='目录验收助手 '+str(index)
            profile={'name':name,'description':'临时合成数据','runtime':'mock','model':'builtin','options':{},'prompt':'根据提供的资料完成目标，列出依据与信息缺口。',
                'skills':[],'mcp_servers':[],'definition':default_definition(name,'general-assistant@1.0.0'),
                'skill_bindings':[{k:p[k] for k in ('skill_id','version','enabled')} for p in packages],'skill_packages':packages}
            db.execute('INSERT INTO agent_profiles(tenant,id,revision,data,created,updated,archived,workspace_id) VALUES(?,?,?,?,?,?,?,?)',
                (registry.tenant,'agent-catalog-'+str(index),1,canonical(profile),index+1,index+1,0,registry.workspace_id))


def expected_catalog(profiles):
    result=[]
    for source in profiles:
        profile=deepcopy(source);packages=profile.pop('skill_packages',[])
        for item in packages:item['package'].pop('files',None)
        result.append({**profile,'catalog_only':True,'skill_summaries':packages})
    return result


def measure(operation):
    statements=[];decoded=[];connect=Store.connect;loads=agent_module.json.loads
    def traced(store):
        db=connect(store);db.set_trace_callback(statements.append);return db
    def decode(value,*args,**kwargs):
        if isinstance(value,str):decoded.append(len(value.encode()))
        return loads(value,*args,**kwargs)
    started=time.perf_counter()
    with patch.object(Store,'connect',traced),patch.object(agent_module.json,'loads',decode):result=operation()
    payload=canonical({'agents':result}).encode();seconds=time.perf_counter()-started
    return {'seconds':round(seconds,6),'selects':sum(s.lstrip().upper().startswith('SELECT') for s in statements),
        'python_json_input_bytes':sum(decoded),'python_json_decodes':len(decoded),'returned':len(result),'response_bytes':len(payload),
        'response_sha256':hashlib.sha256(payload).hexdigest()},result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--heads',type=int,default=100);parser.add_argument('--bindings',type=int,default=4)
    parser.add_argument('--body-bytes',type=int,default=49152);parser.add_argument('--repeats',type=int,default=3)
    parser.add_argument('--compare',action='store_true');args=parser.parse_args()
    if not(1<=args.heads<=300 and 1<=args.bindings<=8 and 1<=args.body_bytes<=90000 and 1<=args.repeats<=10) or args.heads*args.bindings*args.body_bytes>128*1024*1024 or args.bindings*(args.body_bytes+2000)>512000:
        parser.error('heads 1–300; bindings 1–8; body 1–90000; repeats 1–10; resource budget 128 MiB total and 512 KB per Agent')
    measurements={};compatible=True
    with tempfile.TemporaryDirectory(prefix='agent-catalog-benchmark-') as directory:
        registry=AgentRegistry(directory,'benchmark-tenant',None,None,'benchmark-workspace');seed(registry,args.heads,args.bindings,args.body_bytes)
        operations={'full':registry.list}
        if args.compare:operations['catalog']=registry.catalog
        expected=expected_catalog(registry.list())
        for repeat in range(args.repeats):
            names=list(operations) if repeat%2==0 else list(reversed(operations))
            for name in names:
                measurement,result=measure(operations[name]);measurements.setdefault(name,[]).append(measurement)
                if name=='catalog':compatible=compatible and result==expected
    if not compatible:raise AssertionError('Catalog metadata differs from full profiles')
    print(json.dumps({'agents':args.heads,'skills_per_agent':args.bindings,'reference_bytes_per_skill':args.body_bytes,
        'catalog_matches_projection':compatible if args.compare else None,
        'algorithms':{name:{'median_seconds':median(v['seconds'] for v in rows),'measurements':rows} for name,rows in measurements.items()}},indent=2))


if __name__=='__main__':main()
