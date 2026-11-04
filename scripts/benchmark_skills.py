"""Measure skill-catalog history reads using disposable synthetic packages."""
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
from agent_framework.skills import SkillRegistry,normalize_package,validate_frozen
from agent_framework import skills as skill_module
from agent_framework.store import Store


def seed_catalog(registry,heads=100,versions=20,body_bytes=49152):
    tenant,workspace=registry.scope
    with registry.store.transaction() as db:
        for index in range(heads):
            name='catalog-method-'+str(index).zfill(4);identity='skill-catalog-'+str(index)
            db.execute('INSERT INTO skill_heads VALUES(?,?,?,?,?,?,?,?,?)',(tenant,workspace,identity,name,versions,versions,0,0,index+1))
            for version in range(1,versions+1):
                # Different metadata and references prevent repeated identical
                # JSON values from benefiting SQLite's JSON parse cache.
                label=str(index)+':'+str(version)+'\n'
                package,_=normalize_package(name,{'SKILL.md':{'encoding':'utf-8','content':'---\nname: '+name+'\ndescription: 整理材料时使用的合成方法\nmetadata:\n  version: "'+str(version)+'"\n---\n\n按需读取 [资料](references/source.md)。\n'},
                    'references/source.md':{'encoding':'utf-8','content':(label+'x'*body_bytes)[:body_bytes]}})
                db.execute('INSERT INTO skill_versions VALUES(?,?,?,?,?,?,?,?)',
                    (tenant,workspace,identity,version,'PUBLISHED',package['hash'],canonical(package),version))


def legacy_catalog(registry):
    """Pre-optimization algorithm, retained only for same-database comparison."""
    with registry.store.connect() as db:
        ids=[r[0] for r in db.execute('SELECT id FROM skill_heads WHERE tenant=? AND workspace=? ORDER BY builtin,updated DESC',registry.scope)]
    result=[]
    for identity in ids:
        with registry.store.connect() as db:
            head=db.execute('SELECT * FROM skill_heads WHERE tenant=? AND workspace=? AND id=?',(*registry.scope,identity)).fetchone()
            versions=db.execute('SELECT version,status,hash,created,data FROM skill_versions WHERE tenant=? AND workspace=? AND id=? ORDER BY version DESC',(*registry.scope,identity)).fetchall()
            row=db.execute('SELECT * FROM skill_versions WHERE tenant=? AND workspace=? AND id=? AND version=?',(*registry.scope,identity,head['version'])).fetchone()
        package=json.loads(row['data']);validate_frozen(package)
        if package['hash']!=row['hash']:raise ValueError('Skill 版本摘要不匹配')
        result.append({'id':identity,'name':head['name'],'revision':head['revision'],'version':row['version'],'status':row['status'],
            'archived':bool(head['archived']),'builtin':bool(head['builtin']),'metadata':package['metadata'],'hash':row['hash'],
            'versions':[{k:v[k] for k in ('version','status','hash','created')}|{'metadata':json.loads(v['data'])['metadata']} for v in versions],
            'files':[{'path':p,'size':v['size'],'hash':v['hash'],'encoding':v['encoding']} for p,v in package['files'].items()]})
    return result


def measure(operation):
    statements=[];decodes=[];connect=Store.connect;loads=skill_module.json.loads
    def traced(store):
        db=connect(store);db.set_trace_callback(statements.append);return db
    def decoded(value,*args,**kwargs):
        if isinstance(value,str) and '"format":"agent-skills@1"' in value:decodes.append(len(value.encode()))
        return loads(value,*args,**kwargs)
    started=time.perf_counter()
    with patch.object(Store,'connect',traced),patch.object(skill_module.json,'loads',decoded):result=operation()
    seconds=time.perf_counter()-started
    payload=canonical(result).encode()
    return {'seconds':round(seconds,6),'selects':sum(statement.lstrip().upper().startswith('SELECT') for statement in statements),
        'full_package_json_decodes':len(decodes),'full_package_json_bytes':sum(decodes),
        'returned':len(result),'response_bytes':len(payload),'response_sha256':hashlib.sha256(payload).hexdigest()}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--heads',type=int,default=100);parser.add_argument('--versions',type=int,default=20)
    parser.add_argument('--body-bytes',type=int,default=49152);parser.add_argument('--repeats',type=int,default=3)
    parser.add_argument('--compare',action='store_true',help='Compare the previous algorithm with current reads on the same database')
    args=parser.parse_args()
    if not(1<=args.heads<=500 and 1<=args.versions<=100 and 1<=args.body_bytes<=90000 and 1<=args.repeats<=10) or args.heads*args.versions*args.body_bytes>128*1024*1024:
        parser.error('heads 1–500; versions 1–100; body 1–90000 bytes; repeats 1–10; historical body budget 128 MiB')
    with tempfile.TemporaryDirectory(prefix='skill-catalog-benchmark-') as directory:
        registry=SkillRegistry(Store(Path(directory)/'runtime.sqlite3'),'benchmark-tenant','benchmark-workspace')
        seed_catalog(registry,args.heads,args.versions,args.body_bytes)
        operations={'current':registry.list}
        if args.compare:operations['legacy']=lambda:legacy_catalog(registry)
        measurements={name:[] for name in operations}
        for repeat in range(args.repeats):
            # Alternate order to reduce a consistent warm-cache advantage.
            names=list(operations) if repeat%2==0 else list(reversed(operations))
            for name in names:measurements[name].append(measure(operations[name]))
        same_response=len({item['response_sha256'] for rows in measurements.values() for item in rows})==1
        if not same_response:raise AssertionError('Catalog response changed between reads or algorithms')
    print(json.dumps({'custom_skills':args.heads,'builtin_skills':2,'versions_per_custom_skill':args.versions,
        'reference_bytes_per_package':args.body_bytes,'distinct_version_contents':True,'same_response':same_response,
        'algorithms':{name:{'median_seconds':median(item['seconds'] for item in rows),'measurements':rows} for name,rows in measurements.items()}},indent=2))


if __name__=='__main__':main()
