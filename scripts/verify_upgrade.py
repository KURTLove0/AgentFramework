"""Offline upgrade and backup-based rollback acceptance using release launchers."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen

from verify_release import extract_bundle, verify_bundle, sha256, stop_server


def preserved(actual, expected, path='state'):
    """New projections may add fields; every pre-upgrade fact must survive."""
    if isinstance(expected, dict):
        if not isinstance(actual, dict):raise ValueError('upgrade differs: '+path)
        for key, value in expected.items():
            if key not in actual:raise ValueError('upgrade missing: '+path+'.'+key)
            preserved(actual[key], value, path+'.'+key)
    elif isinstance(expected, list):
        if not isinstance(actual, list) or len(actual)!=len(expected):raise ValueError('upgrade differs: '+path)
        for index, value in enumerate(expected):preserved(actual[index], value, path+'.'+str(index))
    elif actual!=expected:raise ValueError('upgrade differs: '+path)


def verify(old_artifact, new_artifact, wheelhouse, report_path):
    old_artifact=old_artifact.resolve();new_artifact=new_artifact.resolve();wheelhouse=wheelhouse.resolve()
    if report_path.exists():raise FileExistsError('upgrade report already exists')
    with tempfile.TemporaryDirectory(prefix='agent-upgrade-',dir='/private/tmp') as temporary:
        root=Path(temporary);caller=root/'caller';caller.mkdir()
        env={k:v for k,v in os.environ.items() if not k.startswith(('PIP_', 'PYTHON'))}
        env.update(PYTHON=sys.executable,PIP_NO_INDEX='1',PIP_FIND_LINKS=wheelhouse.as_uri(),
            PIP_CONFIG_FILE=os.devnull,PIP_DISABLE_PIP_VERSION_CHECK='1',PIP_NO_CACHE_DIR='1',
            AGENT_TENANT='delivery-tenant',AGENT_PRINCIPAL='delivery-user')
        bundles={};versions={};sources={};environments={}
        for key, artifact in [('old',old_artifact),('new',new_artifact)]:
            bundle=extract_bundle(artifact,root/key);wheel,version,source=verify_bundle(bundle)
            bundles[key]=bundle;versions[key]=version;sources[key]=source
            environments[key]=env|{'AGENT_VENV_DIR':str(root/(key+'-venv'))}
            result=subprocess.run(['sh',str(bundle/'scripts/install.sh')],cwd=caller,env=environments[key],
                capture_output=True,text=True,timeout=90)
            if result.returncode:raise RuntimeError(key+' install failed: '+result.stdout+result.stderr)
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        base=f'http://127.0.0.1:{port}';process=None;session=None;current_env=None
        log_path=root/'server.log';data=root/'data';backup=root/'before-upgrade';rollback=root/'rollback'
        with log_path.open('w') as log:
            def start(key, directory):
                nonlocal process,session,current_env
                current_env=environments[key]|{'AGENT_DATA_DIR':str(directory),'AGENT_PORT':str(port)}
                process=subprocess.Popen(['sh',str(bundles[key]/'scripts/start.sh')],cwd=caller,env=current_env,stdout=log,stderr=subprocess.STDOUT)
                deadline=time.monotonic()+15
                while True:
                    if process.poll() is not None:raise RuntimeError(log_path.read_text())
                    try:
                        with urlopen(base+'/api/session',timeout=.5) as response:session=json.load(response)
                        break
                    except OSError:
                        if time.monotonic()>deadline:raise RuntimeError('upgrade startup timeout: '+log_path.read_text())
                        time.sleep(.05)
                if session['version']!=versions[key] or session['tenant']!='delivery-tenant':raise ValueError('wrong installed version or tenant')
            def stop():
                if not stop_server(process):raise RuntimeError('upgrade server did not stop gracefully')
            def api(path, payload=None):
                headers={'X-Agent-Workspace':session['workspace']['id']}
                if payload is not None:headers.update({'Content-Type':'application/json','X-Agent-Token':session['csrf_token']})
                with urlopen(Request(base+path,data=None if payload is None else json.dumps(payload).encode(),headers=headers),timeout=10) as response:
                    return json.load(response)
            def settled(path,status):
                deadline=time.monotonic()+30
                while True:
                    detail=api(path)
                    if detail['run']['status']==status and not(detail.get('job') or {}).get('active') and not detail.get('queue'):return detail
                    if time.monotonic()>deadline:raise ValueError('upgrade fixture did not settle: '+json.dumps(detail,ensure_ascii=False))
                    time.sleep(.05)
            def inventory(directory):
                return {str(p.relative_to(directory)):sha256(p) for p in directory.rglob('*') if p.is_file()}
            try:
                start('old',data)
                workspace=session['workspace']['id']
                definition=api('/api/agent-definition-default?domain=general-assistant@1.0.0')['definition']
                agent=api('/api/agents',{'name':'跨版本验收助手','description':'离线模拟','runtime':'mock','model':'builtin',
                    'options':{},'prompt':'按目标交付。','skills':[],'mcp_servers':[],'revision':0,'definition':definition})
                task=api('/api/tasks',{'goal':'升级前完成的普通任务','agent_id':agent['id'],'agent_revision':agent['revision'],
                    'request_id':'upgrade-original-task'})['run']['run_id']
                settled('/api/tasks/'+task,'SUCCEEDED')
                business=api('/api/runs',{'runtime':'mock','start':True})['run']['run_id']
                settled('/api/runs/'+business,'SUCCEEDED')
                definition=api('/api/agent-definition-default?domain=change-assessment@2.0.0')['definition']
                flow_agent=api('/api/agents',{'name':'跨版本工作流助手','description':'离线模拟','runtime':'mock','model':'builtin',
                    'options':{},'prompt':'核对模拟变更。','skills':[],'mcp_servers':[],'revision':0,'definition':definition})
                workflow=api('/api/workflows',{'name':'跨版本等待授权流程','description':'升级不应自动授权','revision':0,
                    'nodes':[{'id':'review','name':'核对提案','agent_id':flow_agent['id'],'agent_revision':flow_agent['revision'],
                    'goal':'评估模拟变更并准备草稿','depends_on':[]}]})
                flow=api('/api/workflows/'+workflow['id']+'/start',{'revision':workflow['revision'],'request_id':'upgrade-original-flow',
                    'change_id':'upgrade-change','grant':False,'max_wall_seconds':3600})['run']['id']
                settled('/api/workflow-runs/'+flow,'WAITING_AUTH')
                draft=api('/api/task-draft',{'revision':0,'draft':{'goal':'升级前未提交的草稿','agent_id':agent['id']}})
                def snapshot():
                    details={}
                    for identity in (task,business):
                        d=api('/api/runs/'+identity)
                        details[identity]={'run':d['run'],'external':d['external']}
                    d=api('/api/workflow-runs/'+flow)
                    child=api('/api/runs/'+d['run']['nodes']['review']['run_id'])
                    return {'workspace':session['workspace'],'agents':api('/api/agents')['agents'],
                        'draft':api('/api/task-draft'),'workflow':api('/api/workflows/'+workflow['id']),
                        'flow':{'run':d['run'],'events':d['events']},'child':{'run':child['run'],'external':child['external']},'tasks':details}
                baseline=snapshot()
                if len(baseline['tasks'][business]['external']['drafts'])!=1 or baseline['child']['external']['drafts']:
                    raise ValueError('upgrade baseline simulated writes differ')
                stop();shutil.copytree(data,backup);backup_hashes=inventory(backup)
                if inventory(data)!=backup_hashes:raise ValueError('stopped full-directory backup differs')
                start('new',data);preserved(snapshot(),baseline)
                if session['workspace']['id']!=workspace:raise ValueError('upgrade lost workspace')
                # A new task proves that migrated data is writable, not merely readable.
                new_task=api('/api/tasks',{'goal':'升级后创建并完成的任务','agent_id':agent['id'],
                    'agent_revision':agent['revision'],'request_id':'upgrade-new-task'})['run']['run_id']
                settled('/api/tasks/'+new_task,'SUCCEEDED')
                preserved(snapshot(),baseline)
                stop();upgraded_hashes=inventory(data)
                # Rollback restores the complete old snapshot; newer data stays intact.
                shutil.copytree(backup,rollback)
                if inventory(rollback)!=backup_hashes:raise ValueError('rollback copy differs')
                start('old',rollback);preserved(snapshot(),baseline)
                run_ids={item['run_id'] for item in api('/api/runs')['runs']}
                if new_task in run_ids:raise ValueError('rollback accidentally used upgraded data')
                stop()
                if inventory(data)!=upgraded_hashes or inventory(backup)!=backup_hashes:
                    raise ValueError('rollback changed upgraded data or original backup')
                # Reopen the same migrated store to check migration repeatability.
                start('new',data);preserved(snapshot(),baseline);settled('/api/tasks/'+new_task,'SUCCEEDED');stop()
                report={'verified_at':datetime.now(timezone.utc).isoformat(),'from_version':versions['old'],'to_version':versions['new'],
                    'old_artifact':str(old_artifact),'old_sha256':sha256(old_artifact),'new_artifact':str(new_artifact),'new_sha256':sha256(new_artifact),
                    'offline_install':True,'actual_bundle_launchers':True,'upgrade_same_data_directory':True,
                    'old_records_preserved':True,'new_task_completed':new_task,'second_new_version_start':True,
                    'rollback':'old-version-with-complete-pre-upgrade-directory-copy',
                    'backup_unchanged':True,'upgraded_data_preserved_during_rollback':True,
                    'waiting_workflow_not_authorized':True,'original_simulated_drafts':1,'baseline':baseline,
                    'backup_sha256':backup_hashes,'test_data':'temporary-isolated-directories','external_model_calls':0}
                with report_path.open('x') as output:json.dump(report,output,ensure_ascii=False,indent=2);output.write('\n')
                return report
            finally:
                if process is not None and process.poll() is None:stop_server(process)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('old_artifact',type=Path);parser.add_argument('new_artifact',type=Path)
    parser.add_argument('--wheelhouse',type=Path,required=True);parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    report=verify(args.old_artifact,args.new_artifact,args.wheelhouse,args.report)
    print(json.dumps({key:value for key,value in report.items() if key not in ('baseline','backup_sha256')},ensure_ascii=False,indent=2))


if __name__=='__main__':main()
