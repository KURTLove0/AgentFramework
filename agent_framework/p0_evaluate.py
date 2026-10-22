"""Offline P0 equivalence matrix, including an actual worker exit/restart.

python3 -m agent_framework.p0_evaluate --output .agent-data/p0-review
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import time
from uuid import uuid4

from .cli import export_result
from .contracts import TaskContract, TOOLS, canonical
from .definitions import ADAPTERS, default_definition
from .evaluate import EXPECTED
from .runtime import CrashInjected, Runtime, legacy_registry_snapshot


def fixture_profile(adapter):
    definition = default_definition('P0 模拟评估岗位')
    definition['adapter_bindings'] = {ref: adapter for ref in TOOLS}
    return {'id':'agent-0123456789abcdef', 'revision':1, 'archived':False, 'name':'P0 模拟评估岗位',
            'description':'P0 mock equivalence', 'runtime':'mock', 'model':'builtin', 'options':{},
            'prompt':'根据模拟证据评估并创建草稿', 'skills':[], 'mcp_servers':[], 'definition':definition}


def submit(runtime, scenario, adapter, legacy):
    if legacy:
        # Construct a historical fixture with the unchanged v1 serializer. Production
        # submission has no legacy bypass. No existing database/snapshot is migrated.
        task = TaskContract()
        runtime.external.seed(task.to_dict())
        return runtime.store.create(task, legacy_registry_snapshot(), scenario, grant=scenario != 'denied')
    p = fixture_profile(adapter)
    return runtime.submit(TaskContract(agent_ref=p['id']+'@1'),scenario=scenario,agent_profile=p)


def frozen_identity(action):
    return {key:action[key] for key in ('logical_id','args','args_hash')}


def main(argv=None):
    parser = argparse.ArgumentParser(description='P0 岗位编译与统一动作治理模拟等价矩阵')
    parser.add_argument('--output',type=Path,default=Path('.agent-data/p0-review'))
    parser.add_argument('--worker', action='store_true',help=argparse.SUPPRESS)
    parser.add_argument('--legacy', action='store_true',help=argparse.SUPPRESS)
    parser.add_argument('--adapter', choices=ADAPTERS, default=ADAPTERS[0],help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.worker:
        runtime = Runtime(args.output,lease_seconds=.8,tool_timeout=.3)
        state = submit(runtime,'crash-after-write',args.adapter,args.legacy)
        print(state['run_id'],flush=True)
        try:
            runtime.run(state['run_id'])
        except CrashInjected:
            action = next(a for a in runtime.store.actions(state) if a['tool_ref']==TOOLS[2])
            (args.output/'before-restart.json').write_text(canonical({'snapshot':state['snapshot'],'action':frozen_identity(action)}))
            return 75
        return 1
    root=args.output.resolve()/('p0-'+uuid4().hex[:10]);root.mkdir(parents=True)
    rows=[]
    for mode,adapter in [('legacy',ADAPTERS[0])]+[('compiled',a) for a in ADAPTERS]:
        for scenario,expected in EXPECTED.items():
            directory=root/(mode+'-'+adapter.split('@')[0])/scenario
            runtime=Runtime(directory)
            crash_exit=None;identity_unchanged=True
            if scenario=='crash-after-write':
                command=[sys.executable,'-m','agent_framework.p0_evaluate','--worker','--output',str(directory),'--adapter',adapter]
                if mode=='legacy':command.append('--legacy')
                crashed=subprocess.run(command,text=True,capture_output=True,timeout=15)
                crash_exit=crashed.returncode
                if crash_exit!=75:raise RuntimeError(crashed.stderr+crashed.stdout)
                run_id=crashed.stdout.strip()
                before=json.loads((directory/'before-restart.json').read_text())
                time.sleep(.85)
                # New interpreter restores the persisted snapshot, not a passed planner/config.
                resumed=subprocess.run([sys.executable,'-m','agent_framework','--data-dir',str(directory),'resume',run_id],
                                       text=True,capture_output=True,timeout=15)
                if resumed.returncode:raise RuntimeError(resumed.stderr+resumed.stdout)
                result=runtime.store.result('tenant-demo',run_id)
                after=next(a for a in result['actions'] if a['logical_id']==before['action']['logical_id'])
                identity_unchanged=before['snapshot']==result['snapshot'] and before['action']==frozen_identity(after)
            else:
                state=submit(runtime,scenario,adapter,mode=='legacy')
                snapshot=canonical(state['snapshot'])
                result=runtime.run(state['run_id'])
                identity_unchanged=canonical(result['snapshot'])==snapshot
            stats=runtime.external.stats('tenant-demo',result['run_id'])
            drafts=0 if scenario in ('read-fails','denied','missing-evidence') else 1
            calls=2 if scenario=='source-changed' else drafts
            checks_passed=all(c['passed'] for c in result['checks'].values()) and len(result['checks'])==3
            row={'mode':mode,'adapter':adapter,'scenario':scenario,'run_id':result['run_id'],
                 'expected_status':expected,'status':result['status'],'draft_count':len(stats['drafts']),
                 'write_calls':stats['calls'].get(TOOLS[2],0),'checks_passed':checks_passed,
                 'snapshot_and_intent_unchanged':identity_unchanged,'crash_exit':crash_exit}
            row['passed']=(result['status']==expected and row['draft_count']==drafts and row['write_calls']==calls
                           and identity_unchanged and (checks_passed if expected=='SUCCEEDED' else not checks_passed))
            export_result(runtime,result,directory/'export');rows.append(row)
            print(f"{'PASS' if row['passed'] else 'FAIL'} {mode}/{adapter}/{scenario}: {result['status']} drafts={row['draft_count']} writes={row['write_calls']}",flush=True)
    summary={'generated_at':datetime.now(timezone.utc).isoformat(),'scope':'synthetic context + deterministic cognition + simulated Tool/CLI/MCP',
             'passed':sum(r['passed'] for r in rows),'total':len(rows),'cases':rows}
    path=root/'summary.json';path.write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    print('summary='+str(path))
    return 0 if summary['passed']==summary['total'] else 1


if __name__=='__main__':raise SystemExit(main())
