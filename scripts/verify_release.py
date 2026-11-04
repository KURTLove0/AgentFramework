"""Verify a wheel or bundle in a fresh, offline-installed environment."""
import argparse
from datetime import datetime,timezone
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path,PurePosixPath
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import unquote,urljoin,urlsplit
from urllib.request import Request,urlopen
import zipfile

ROOT=Path(__file__).resolve().parents[1]
MAX_BYTES=32*1024*1024
MAX_MEMBERS=2048


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_name(name):
    if (not isinstance(name,str) or not name or name.startswith('/') or '\\' in name
            or ':' in name or any(part in ('','.','..') for part in name.split('/'))):
        raise ValueError('unsafe artifact member: '+str(name))
    return PurePosixPath(name)


def wheel_manifest(wheel):
    with zipfile.ZipFile(wheel) as archive:
        entries=archive.infolist()
        if len(entries)>MAX_MEMBERS or sum(item.file_size for item in entries)>MAX_BYTES:
            raise ValueError('wheel exceeds verification budget')
        if len({item.filename for item in entries})!=len(entries):raise ValueError('duplicate wheel member')
        result={};version=None
        for item in entries:
            safe_name(item.filename.rstrip('/'))
            if stat.S_ISLNK(item.external_attr>>16):raise ValueError('wheel contains a symlink')
            if not item.filename.startswith(('agent_framework/','bounded_agent_mvp-')):
                raise ValueError('unexpected wheel package')
            if item.filename.endswith('/'):continue
            if item.filename.startswith('agent_framework/'):
                result[item.filename]=hashlib.sha256(archive.read(item)).hexdigest()
            elif item.filename.endswith('.dist-info/METADATA'):
                versions=re.findall(r'^Version: (.+)$',archive.read(item).decode(),re.M)
                if len(versions)!=1 or version is not None:raise ValueError('ambiguous wheel version')
                version=versions[0]
        if not version or not result:raise ValueError('wheel metadata missing')
        return version,result


def extract_bundle(artifact,destination):
    destination.mkdir()
    names=set();roots=set();total=0
    with tarfile.open(artifact,'r:gz') as archive:
        for item in archive:
            name=item.name.rstrip('/');relative=safe_name(name)
            if name in names:raise ValueError('duplicate bundle member')
            names.add(name);roots.add(relative.parts[0]);total+=item.size
            if len(names)>MAX_MEMBERS or total>MAX_BYTES:raise ValueError('bundle exceeds verification budget')
            if not(item.isdir() or item.isfile()):raise ValueError('bundle contains a link or special file')
            target=destination.joinpath(*relative.parts)
            if item.isdir():target.mkdir(parents=True,exist_ok=True)
            else:
                target.parent.mkdir(parents=True,exist_ok=True)
                stream=archive.extractfile(item)
                if stream is None:raise ValueError('bundle member unreadable')
                with stream,target.open('xb') as output:shutil.copyfileobj(stream,output)
    if len(roots)!=1:raise ValueError('bundle must have one root')
    return destination/next(iter(roots))


def verify_bundle(bundle):
    expected={}
    for line in (bundle/'SHA256SUMS').read_text().splitlines():
        match=re.fullmatch(r'([0-9a-f]{64})  (.+)',line)
        if not match:raise ValueError('invalid bundle checksum line')
        name=match[2];safe_name(name)
        if name in expected:raise ValueError('duplicate bundle checksum')
        expected[name]=match[1]
    actual={str(path.relative_to(bundle)):sha256(path) for path in bundle.rglob('*') if path.is_file() and path!=bundle/'SHA256SUMS'}
    if actual!=expected:raise ValueError('bundle checksum or inventory mismatch')
    manifest=json.loads((bundle/'release.json').read_text())
    name=manifest.get('wheel');safe_name(name)
    if len(PurePosixPath(name).parts)!=1:raise ValueError('wheel must be inside bundle root')
    wheel=bundle/name
    version,source=wheel_manifest(wheel)
    if (manifest.get('version')!=version or manifest.get('contains_runtime_data') is not False
            or manifest.get('wheel_sha256')!=sha256(wheel) or manifest.get('source_sha256')!=source):
        raise ValueError('bundle source manifest mismatch')
    if bundle.name!='agent-framework-'+version:raise ValueError('bundle version directory mismatch')
    return wheel,version,source


class UIResources(HTMLParser):
    def __init__(self):
        super().__init__();self.paths=[]
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag=='script' and attrs.get('src'):self.paths.append(attrs['src'])
        if tag=='link' and ('stylesheet' in attrs.get('rel','').split() or attrs.get('as')=='font'):
            if attrs.get('href'):self.paths.append(attrs['href'])


def verify_resources(base,source):
    pending=['/'];seen=set()
    while pending:
        path=pending.pop()
        if path in seen:continue
        seen.add(path)
        if len(seen)>128:raise ValueError('UI resource graph exceeds budget')
        with urlopen(base+path,timeout=5) as response:body=response.read()
        filename='index.html' if path=='/' else unquote(urlsplit(path).path).lstrip('/')
        safe_name(filename)
        expected=source.get('agent_framework/webui/'+filename)
        if not expected or hashlib.sha256(body).hexdigest()!=expected:raise ValueError('installed UI bytes differ: '+path)
        refs=[]
        if path=='/':
            parser=UIResources();parser.feed(body.decode());refs=parser.paths
        elif path.endswith('.css'):
            refs=re.findall(r'url\(\s*["\']?([^"\')\s]+)',body.decode())
        for ref in refs:
            if ref.startswith(('data:','#')):continue
            target=urlsplit(urljoin(base+path,ref))
            if target.scheme!='http' or target.netloc!=urlsplit(base).netloc:raise ValueError('unexpected external UI resource')
            pending.append(target.path)
    return len(seen)


def stop_server(process,timeout=8):
    """Reap the owned server even when graceful shutdown times out."""
    if process.poll() is not None:return False
    process.send_signal(signal.SIGINT)
    try:process.wait(timeout)
    except subprocess.TimeoutExpired:
        process.kill();process.wait();return False
    return True


def wait_for_session(process,base,log_path,version):
    deadline=time.monotonic()+15
    while True:
        if process.poll() is not None:raise RuntimeError('installed server exited:\n'+log_path.read_text())
        try:
            with urlopen(base+'/api/session',timeout=.5) as response:session=json.load(response)
            break
        except OSError:
            if time.monotonic()>deadline:raise RuntimeError('installed startup timed out:\n'+log_path.read_text())
            time.sleep(.05)
    if (session['version']!=version or session['tenant']!='delivery-tenant' or session['principal']!='delivery-user'):
        raise ValueError('installed session scope differs')
    return session


def verify_restart_state(api,expected):
    """Check durable reads first, then prove old requests cannot change them."""
    def equal(actual,wanted,label):
        if actual!=wanted:raise ValueError('installed restart differs: '+label)
    def reads():
        equal(api('/api/runtime-config')['settings'],expected['settings'],'runtime settings')
        equal(api('/api/runtime-config/requests/installed-settings')['receipt'],expected['settings_receipt'],'runtime receipt')
        equal(api('/api/task-draft'),expected['draft'],'task draft')
        equal(api('/api/agents/'+expected['agent']['id']),expected['agent'],'agent')
        equal(api('/api/agents/save-requests/installed-agent'),expected['agent_receipt'],'agent receipt')
        equal(len(api('/api/agents')['agents']),1,'agent count')
        equal(api('/api/runs')['counts']['total'],2,'task count')
        receipt=api('/api/task-submissions/installed-task')
        equal(receipt['submission'],expected['submission'],'task receipt')
        equal(receipt['run'],expected['task_run'],'task history')
        detail=api('/api/runs/'+expected['business_run']['run_id'])
        equal(detail['run'],expected['business_run'],'business history')
        equal(detail['external'],expected['external'],'simulated external write')
    reads()
    settings=api('/api/runtime-config',expected['settings_payload'])
    equal(settings['receipt'],expected['settings_receipt'],'replayed runtime receipt')
    equal(settings['settings'],expected['settings'],'replay must preserve newer settings')
    equal(api('/api/agents',expected['agent_payload']),expected['agent_receipt'],'replayed agent receipt')
    task=api('/api/tasks',expected['task_payload'])
    equal(task['submission'],expected['submission'],'replayed task identity')
    equal(task['run'],expected['task_run'],'replayed task history')
    equal(task['task_draft'],expected['draft'],'replay must preserve independent draft')
    reads()


def workflow_recovery_snapshot(api,fixture):
    """Capture durable workflow facts through the installed service only."""
    def read(path):return api(path,workspace=fixture['workspace'])
    runs=[]
    for index,identity in enumerate(fixture['roots']):
        detail=read('/api/workflow-runs/'+identity)
        if (detail.get('job') or {}).get('active') or detail['queue'] is not None:
            raise ValueError('workflow recovery snapshot requires settled dispatches')
        if detail['run']['nodes']['review']['run_id']!=fixture['children'][index]:
            raise ValueError('workflow recovery child identity changed')
        child=read('/api/tasks/'+fixture['children'][index])
        receipt=read('/api/workflow-starts/installed-flow-'+str(index))
        if receipt['run']!=detail['run']:raise ValueError('workflow start receipt differs')
        runs.append({'run':detail['run'],'events':detail['events'],'children':detail['children'],
            'child_run':child['run'],'external':child['external']})
    return {'workflow':read('/api/workflows/'+fixture['workflow']), 'runs':runs,
        'workflow_count':read('/api/workflow-runs?limit=50')['total'],
        'child_count':read('/api/runs')['counts']['total']}


def verify_workflow_recovery(api,fixture,expected,proposal):
    """Read before replay, then verify replay cannot create another write."""
    def check():
        if workflow_recovery_snapshot(api,fixture)!=expected:
            raise ValueError('installed workflow recovery differs')
    check()
    api('/api/workflow-runs/'+fixture['roots'][1]+'/grant',proposal,workspace=fixture['workspace'])
    check()


def verify_browser_journeys(api,base,environment,output):
    """Exercise the installed service; create all fixtures through its public API."""
    if api('/api/runtime-config')['settings']['default_runtime']!='mock':
        raise ValueError('installed browser checks require the mock runtime')
    results={}
    def run(name,variables,directory):
        directory.mkdir(parents=True,exist_ok=True)
        browser=subprocess.run(['node',str(ROOT/'tests'/('verify_'+name+'.cjs'))],
            cwd=ROOT,env=environment|variables,text=True,capture_output=True,timeout=120)
        (directory/'browser.log').write_text(browser.stdout+browser.stderr)
        if browser.returncode:raise RuntimeError('installed '+name+' browser check failed:\n'+browser.stdout+browser.stderr)
        evidence=json.loads((directory/'results.json').read_text())
        if not evidence.get('checks') or evidence.get('errors')!=[]:
            raise ValueError('installed '+name+' browser evidence is incomplete')
        results[name]={'results':str(directory/'results.json'),'checks':len(evidence['checks']),
            'layouts':sum(len(evidence.get(key,[])) for key in ('layouts','cleanupLayouts','storageLayouts','pendingLayouts'))}
    run('task_submissions',{'TASK_SUBMISSION_URL':base,'TASK_SUBMISSION_OUTPUT':str(output)},output)
    def workspace(name):
        return api('/api/workspaces',{'name':name,'business':'隔离验收','scenario':'安装后任务流程',
            'description':'临时合成数据，仅使用 mock 运行时','revision':0})['id']
    opening=workspace('安装后首次任务验收')
    directory=output/'task-opening'
    run('task_opening',{'TASK_OPENING_URL':base+'?workspace_id='+opening,
        'TASK_OPENING_OUTPUT':str(directory)},directory)
    for suite,label,count in [('task_names','名称',4),('task_archive','归档',4),('task_favorites','收藏',51)]:
        selected=workspace('安装后任务'+label+'验收');other=workspace('安装后'+label+'空白切换空间')
        definition=api('/api/agent-definition-default?domain=general-assistant@1.0.0',workspace=selected)['definition']
        agent=api('/api/agents',{'name':label+'恢复验收助手','description':'合成数据验收',
            'runtime':'mock','model':'builtin','options':{},'prompt':'按目标交付。','skills':[],
            'mcp_servers':[],'revision':0,'definition':definition},workspace=selected)
        roots=[]
        for offset in range(0,count,4):
            batch=[]
            for index in range(offset,min(offset+4,count)):
                task=api('/api/tasks',{'goal':f'历史目标-{index:04d}','agent_id':agent['id'],
                    'agent_revision':agent['revision'],'request_id':f'installed-{suite}-{index}'},workspace=selected)
                batch.append(task['run']['run_id'])
            deadline=time.monotonic()+20
            while True:
                details=[api('/api/tasks/'+identity,workspace=selected) for identity in batch]
                if all(item['run']['status']=='SUCCEEDED' and not item['conversation']['active'] for item in details):break
                if time.monotonic()>deadline:raise ValueError('installed '+suite+' fixture tasks did not complete')
                time.sleep(.05)
            roots.extend(batch)
        directory=output/suite.replace('_','-');directory.mkdir(parents=True,exist_ok=True)
        (directory/'fixture.json').write_text(json.dumps({'workspace':selected,'other_workspace':other,'roots':roots}))
        run(suite,{'RUN_HISTORY_URL':base,'RUN_HISTORY_OUTPUT':str(directory)},directory)
        results[suite]['fixture_tasks']=count
    selected=workspace('安装后多轮导出验收')
    definition=api('/api/agent-definition-default?domain=general-assistant@1.0.0',workspace=selected)['definition']
    agent=api('/api/agents',{'name':'导出交付验收助手','description':'安装后多轮任务导出',
        'runtime':'mock','model':'builtin','options':{},'prompt':'按目标交付。','skills':[],
        'mcp_servers':[],'revision':0,'definition':definition},workspace=selected)
    goals=['整理交付内容，保留原文与换行 😀\n'+('中文说明与 English 内容。'*25)+'\n```text\n<原文标记>\n```','用于切换任务的独立结果']
    roots=[api('/api/tasks',{'goal':goal,'agent_id':agent['id'],'agent_revision':agent['revision'],
        'request_id':'installed-export-'+str(index)},workspace=selected)['run']['run_id'] for index,goal in enumerate(goals)]
    def completed(identity,turns):
        deadline=time.monotonic()+20
        while True:
            detail=api('/api/tasks/'+identity,workspace=selected);conversation=detail['conversation']
            if (len(conversation['turns'])==turns and not conversation['active']
                    and all(turn['status']=='SUCCEEDED' for turn in conversation['turns'])):return detail
            if time.monotonic()>deadline:raise ValueError('installed export fixture did not complete')
            time.sleep(.05)
    detail=completed(roots[0],1);completed(roots[1],1)
    followup='补充第二轮交付说明 😀\n'+('逐项核对：保留每轮要求与实际回复。\n'*80)+'结束标记：完整第二轮。'
    api('/api/tasks/'+roots[0]+'/messages',{'content':followup,'request_id':'installed-export-followup',
        'revision':detail['conversation']['revision']},workspace=selected)
    detail=completed(roots[0],2);name='安装后两轮交付记录'
    api('/api/tasks/'+roots[0]+'/name',{'name':name,'revision':detail['conversation']['task_name']['revision']},workspace=selected)
    api('/api/tasks/'+roots[0]+'/archive',{'archived':True,'revision':detail['conversation']['archive']['revision']},workspace=selected)
    directory=output/'installed-exports';directory.mkdir(parents=True,exist_ok=True)
    (directory/'fixture.json').write_text(json.dumps({'workspace':selected,'roots':roots,'name':name,'contents':[goals[0],followup]},ensure_ascii=False))
    run('installed_exports',{'INSTALLED_EXPORT_URL':base,'INSTALLED_EXPORT_OUTPUT':str(directory),
        'INSTALLED_EXPORT_PYTHON':str(Path(environment['AGENT_VENV_DIR'])/'bin/python')},directory)
    results['installed_exports'].update(fixture_tasks=2,fixture_execution_records=3)
    selected=workspace('安装后工作流恢复验收')
    definition=api('/api/agent-definition-default?domain=change-assessment@2.0.0',workspace=selected)['definition']
    agent=api('/api/agents',{'name':'安装后流程核对助手','description':'模拟变更与提案核对',
        'runtime':'mock','model':'builtin','options':{},'prompt':'按模拟证据执行并保留独立验收。','skills':[],
        'mcp_servers':[],'revision':0,'definition':definition},workspace=selected)
    workflow=api('/api/workflows',{'name':'安装后流程恢复与授权','description':'公开接口创建的隔离模拟流程',
        'revision':0,'nodes':[{'id':'review','name':'核对变更提案','agent_id':agent['id'],
        'agent_revision':agent['revision'],'goal':'评估模拟变更并准备草稿，写入前等待明确授权。','depends_on':[]}]},workspace=selected)
    roots=[api('/api/workflows/'+workflow['id']+'/start',{'revision':workflow['revision'],
        'request_id':'installed-flow-'+str(index),'change_id':'installed-flow-change-'+str(index),
        'grant':False,'consent':False,'mcp_consent':False},workspace=selected)['run']['id'] for index in range(2)]
    deadline=time.monotonic()+20
    while True:
        details=[api('/api/workflow-runs/'+identity,workspace=selected) for identity in roots]
        if all(item['run']['status']=='WAITING_AUTH' and not (item.get('job') or {}).get('active')
                and item['queue'] is None for item in details):break
        if time.monotonic()>deadline:raise ValueError('installed workflow fixtures did not reach authorization wait')
        time.sleep(.05)
    directory=output/'installed-workflows';directory.mkdir(parents=True,exist_ok=True)
    (directory/'fixture.json').write_text(json.dumps({'workspace':selected,'workflow':workflow['id'],
        'roots':roots,'children':[item['run']['nodes']['review']['run_id'] for item in details]},ensure_ascii=False))
    run('installed_workflows',{'INSTALLED_FLOW_URL':base,'INSTALLED_FLOW_OUTPUT':str(directory),
        'INSTALLED_FLOW_PYTHON':str(Path(environment['AGENT_VENV_DIR'])/'bin/python')},directory)
    results['installed_workflows'].update(fixture_workflows=1,fixture_workflow_runs=2,fixture_child_tasks=2)
    directory=output/'chat-drafts'
    run('chat_drafts',{'CHAT_DRAFT_URL':base,'CHAT_DRAFT_OUTPUT':str(directory)},directory)
    return results


def verify(artifact,wheelhouse,report_path=None,browser_check=False):
    artifact=artifact.resolve();wheelhouse=wheelhouse.resolve()
    if report_path:
        report_path=report_path.resolve()
        if report_path.exists():raise FileExistsError('verification report already exists')
        if not report_path.parent.is_dir():raise ValueError('verification report parent must exist')
    if not wheelhouse.is_dir():raise ValueError('provide a local dependency wheelhouse')
    with tempfile.TemporaryDirectory(prefix='agent installed delivery ',dir='/private/tmp' if Path('/private/tmp').is_dir() else None) as temp:
        root=Path(temp)
        if artifact.name.endswith('.tar.gz'):
            bundle=extract_bundle(artifact,root/'unpacked')
            wheel,version,source=verify_bundle(bundle);scope='bundled-install-and-start-scripts'
        else:
            version,source=wheel_manifest(artifact);scope='wheel-with-current-source-launchers'
            bundle=root/'wheel installation';(bundle/'scripts').mkdir(parents=True)
            wheel=bundle/artifact.name;shutil.copy2(artifact,wheel)
            for name in ('install.sh','start.sh'):shutil.copy2(ROOT/'scripts'/name,bundle/'scripts'/name)
            (bundle/'requirements.txt').write_text('PyYAML==6.0.3\n./'+wheel.name+'\n')
        shadow=root/'caller project';(shadow/'agent_framework').mkdir(parents=True)
        marker=root/'caller-code-ran'
        poison='from pathlib import Path\nPath('+repr(str(marker))+').write_text("unexpected")\nraise RuntimeError("caller import executed")\n'
        (shadow/'agent_framework/__init__.py').write_text('')
        for name in ('agent_framework/__main__.py','json.py','venv.py','pip.py'):(shadow/name).write_text(poison)
        environment={key:value for key,value in os.environ.items() if not key.startswith('PIP_')}
        environment.update(PYTHON=sys.executable,PYTHONPATH=str(shadow),PYTHONHOME=str(shadow/'invalid python home'),
            PIP_NO_INDEX='1',PIP_FIND_LINKS=wheelhouse.as_uri(),PIP_CONFIG_FILE=os.devnull,
            PIP_DISABLE_PIP_VERSION_CHECK='1',PIP_NO_CACHE_DIR='1',AGENT_VENV_DIR=str(root/'clean environment'))
        installed=subprocess.run(['sh',str(bundle/'scripts/install.sh')],cwd=shadow,env=environment,text=True,capture_output=True,timeout=90)
        if installed.returncode:raise RuntimeError('fresh offline installation failed:\n'+installed.stdout+installed.stderr)
        python=Path(environment['AGENT_VENV_DIR'])/'bin/python'
        probe="""import importlib,json,pkgutil,sys
from pathlib import Path
import agent_framework,yaml
prefix=Path(sys.prefix).resolve()
assert Path(yaml.__file__).resolve().is_relative_to(prefix)
assert yaml.__version__=='6.0.3'
count=0
for item in pkgutil.walk_packages(agent_framework.__path__,'agent_framework.'):
 if item.name.endswith('.__main__'):continue
 module=importlib.import_module(item.name)
 assert Path(module.__file__).resolve().is_relative_to(prefix),item.name
 count+=1
print(json.dumps({'version':agent_framework.__version__,'modules':count,'yaml_version':yaml.__version__}))
"""
        result=subprocess.run([str(python),'-I','-c',probe],cwd=shadow,env=environment,capture_output=True,text=True,timeout=20,check=True)
        modules=json.loads(result.stdout)
        if modules['version']!=version:raise ValueError('installed version differs')
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        environment.update(AGENT_PORT=str(port),AGENT_DATA_DIR=str(root/'external runtime data'),
                           AGENT_TENANT='delivery-tenant',AGENT_PRINCIPAL='delivery-user')
        with (root/'server.log').open('w') as log:
            process=subprocess.Popen(['sh',str(bundle/'scripts/start.sh')],cwd=shadow,env=environment,stdout=log,stderr=subprocess.STDOUT)
            try:
                base=f'http://127.0.0.1:{port}'
                session=wait_for_session(process,base,root/'server.log',version)
                def api(path,data=None,*,workspace=None):
                    headers={'X-Agent-Workspace':workspace or session['workspace']['id']}
                    if data is not None:headers.update({'Content-Type':'application/json','X-Agent-Token':session['csrf_token']})
                    request=Request(base+path,data=None if data is None else json.dumps(data).encode(),headers=headers)
                    with urlopen(request,timeout=10) as response:return json.load(response)
                if api('/api/runs')['counts']['total']!=0 or api('/api/agents')['agents'] or api('/api/workflows')['workflows']:
                    raise ValueError('new installation contains user or demo records')
                resources=verify_resources(base,source)
                definition=api('/api/agent-definition-default?domain=general-assistant@1.0.0')['definition']
                payload={'name':'安装验收助手','description':'隔离数据验证','runtime':'mock','model':'builtin','options':{},'prompt':'按目标交付。','skills':[],'mcp_servers':[],'revision':0,'definition':definition,'request_id':'installed-agent'}
                agent=api('/api/agents',payload)
                if api('/api/agents',payload)['id']!=agent['id']:raise ValueError('installed Agent save replay differs')
                settings_payload={'default_runtime':'mock','revision':0,'request_id':'installed-settings','profiles':{
                    'codex':{'model':'delivery-codex','reasoning_effort':'ultra','timeout':.5,'max_attempts':2},
                    'cursor':{'model':'delivery-cursor','timeout':1.5,'max_attempts':2},
                    'qoder':{'model':'delivery-qoder','timeout':.125,'max_attempts':2}}}
                settings_receipt=api('/api/runtime-config',settings_payload)['receipt']
                newer_settings={**settings_payload,'revision':1,'request_id':'installed-settings-newer',
                    'profiles':{**settings_payload['profiles'],'cursor':{**settings_payload['profiles']['cursor'],'timeout':2.5}}}
                settings=api('/api/runtime-config',newer_settings)['settings']
                original_draft=api('/api/task-draft',{'revision':0,'draft':{'goal':'受理后清理的草稿','agent_id':agent['id']}})
                task={'goal':'验证安装后任务提交恢复','agent_id':agent['id'],'agent_revision':1,'request_id':'installed-task',
                      'clear_draft':True,'draft_revision':original_draft['revision']}
                first=api('/api/tasks',task)
                if api('/api/tasks',task)['run']['run_id']!=first['run']['run_id']:raise ValueError('installed task replay differs')
                if api('/api/task-submissions/installed-task')['run']['run_id']!=first['run']['run_id']:raise ValueError('installed task receipt differs')
                if first['task_draft']['draft'] is not None:raise ValueError('installed task did not clear its reviewed draft')
                draft=api('/api/task-draft',{'revision':first['task_draft']['revision'],
                    'draft':{'goal':'重启后仍需保留的独立草稿','agent_id':agent['id'],'step':1}})
                business=api('/api/runs',{'runtime':'mock','start':True})['run']['run_id']
                deadline=time.monotonic()+10
                while True:
                    detail=api('/api/runs/'+business)
                    if detail['run']['status']=='SUCCEEDED' and not(detail.get('job') or {}).get('active'):break
                    if time.monotonic()>deadline:raise ValueError('installed worker failed: '+json.dumps(detail['run'],ensure_ascii=False))
                    time.sleep(.05)
                if len(detail['external']['drafts'])!=1:raise ValueError('installed simulated write was not verified')
                export=root/'installed-export.zip'
                with urlopen(base+'/api/runs/'+business+'/download?kind=bundle',timeout=10) as response:export.write_bytes(response.read())
                subprocess.run([str(python),'-I','-m','agent_framework','verify-export',str(export)],cwd=shadow,env=environment,capture_output=True,text=True,check=True,timeout=10)
                deadline=time.monotonic()+10
                while True:
                    task_detail=api('/api/runs/'+first['run']['run_id'])
                    if task_detail['run']['status']=='SUCCEEDED' and not(task_detail.get('job') or {}).get('active'):break
                    if time.monotonic()>deadline:raise ValueError('installed conversation did not finish')
                    time.sleep(.05)
                expected={'settings_payload':settings_payload,'settings_receipt':settings_receipt,'settings':settings,
                    'draft':draft,'agent_payload':payload,'agent':api('/api/agents/'+agent['id']),
                    'agent_receipt':api('/api/agents/save-requests/installed-agent'),'task_payload':task,
                    'submission':first['submission'],'task_run':task_detail['run'],'business_run':detail['run'],'external':detail['external']}
                restarts=[]
                for draft_state in ('saved','discarded'):
                    if draft_state=='discarded':
                        expected['draft']=api('/api/task-draft/discard',{'revision':expected['draft']['revision']})
                        if expected['draft']['draft'] is not None or expected['draft']['revision']<=draft['revision']:
                            raise ValueError('installed draft discard did not retain its version')
                    previous=session
                    if not stop_server(process):raise RuntimeError('installed server did not shut down gracefully')
                    process=subprocess.Popen(['sh',str(bundle/'scripts/start.sh')],cwd=shadow,env=environment,stdout=log,stderr=subprocess.STDOUT)
                    session=wait_for_session(process,base,root/'server.log',version)
                    if session['workspace']['id']!=previous['workspace']['id'] or session['csrf_token']==previous['csrf_token']:
                        raise ValueError('installed restart did not preserve workspace with a new session')
                    verify_restart_state(api,expected)
                    restarts.append({'draft_state':draft_state,'draft_revision':expected['draft']['revision'],
                        'new_process_session':True,'graceful_shutdown':True,'settings_revision':settings['revision'],
                        'settings_and_receipts_preserved':True,'agent_and_receipt_preserved':True,
                        'task_history_and_receipt_preserved':True,'task_count_after_replay':2,'simulated_drafts_after_replay':1})
                if not stop_server(process):raise RuntimeError('installed server did not stop before backup')
                original_data=Path(environment['AGENT_DATA_DIR'])
                source_hashes={name:sha256(original_data/name) for name in ('runtime.sqlite3','mock-business.sqlite3')}
                def installed_cli(*args):
                    result=subprocess.run([str(python),'-I','-m','agent_framework',*map(str,args)],
                        cwd=shadow,env=environment,capture_output=True,text=True,check=True,timeout=30)
                    return json.loads(result.stdout)
                backup=root/'installed backup.zip';restored_data=root/'restored runtime data'
                if not installed_cli('--data-dir',original_data,'backup',backup)['valid']:raise ValueError('installed backup failed')
                inspected=installed_cli('verify-backup',backup)
                expected_counts={'execution_records':2,'conversations':1,'agents':1,'workspaces':1,
                    'workflows':0,'workflow_runs':0,'saved_task_drafts':0,'runtime_configurations':1,'business_drafts':1}
                catalog=inspected['contents']['workspaces']
                if (not inspected['valid'] or inspected['contents']['counts']!=expected_counts
                        or catalog['total']!=1 or catalog['has_more'] or len(catalog['items'])!=1
                        or catalog['items'][0]['id']!=session['workspace']['id']
                        or catalog['items'][0]['tenant']!=session['tenant']):
                    raise ValueError('installed backup contents differ')
                restored=installed_cli('restore-backup',backup,restored_data)
                if not restored['valid']:raise ValueError('installed restore failed')
                restored_hashes={name:sha256(restored_data/name) for name in source_hashes}
                rejected=subprocess.run([str(python),'-I','-m','agent_framework','restore-backup',str(backup),str(restored_data)],
                    cwd=shadow,env=environment,capture_output=True,text=True,timeout=30)
                if (rejected.returncode!=1 or '不会覆盖' not in rejected.stderr
                        or restored_hashes!={name:sha256(restored_data/name) for name in restored_hashes}):
                    raise ValueError('installed restore did not preserve an existing target')
                if source_hashes!={name:sha256(original_data/name) for name in source_hashes}:raise ValueError('installed backup or restore changed original data')
                environment['AGENT_DATA_DIR']=str(restored_data)
                process=subprocess.Popen(['sh',str(bundle/'scripts/start.sh')],cwd=shadow,env=environment,stdout=log,stderr=subprocess.STDOUT)
                previous=session;session=wait_for_session(process,base,root/'server.log',version)
                if session['workspace']['id']!=previous['workspace']['id'] or session['csrf_token']==previous['csrf_token']:
                    raise ValueError('installed restore session differs')
                verify_restart_state(api,expected)
                browser_output=None
                workflow_recovery=None
                if browser_check:
                    browser_output=(report_path.parent/(report_path.stem+'-browser')) if report_path else root/'browser'
                    browser_suites=verify_browser_journeys(api,base,environment,browser_output)
                    evidence=json.loads((browser_output/'installed-workflows/results.json').read_text())
                    fixture=evidence['fixture']
                    proposal=next(item['body'] for item in evidence['posts'] if item['url'].endswith('/grant'))
                    flow_expected=workflow_recovery_snapshot(api,fixture)
                    if ([item['run']['status'] for item in flow_expected['runs']]!=['CANCELLED','SUCCEEDED']
                            or flow_expected['workflow_count']!=2 or flow_expected['child_count']!=2):
                        raise ValueError('installed workflow recovery baseline differs')
                    previous=session
                    if not stop_server(process):raise RuntimeError('installed workflow restart did not stop gracefully')
                    process=subprocess.Popen(['sh',str(bundle/'scripts/start.sh')],cwd=shadow,env=environment,stdout=log,stderr=subprocess.STDOUT)
                    session=wait_for_session(process,base,root/'server.log',version)
                    if session['csrf_token']==previous['csrf_token']:raise ValueError('workflow restart reused session')
                    verify_workflow_recovery(api,fixture,flow_expected,proposal)
                    if not stop_server(process):raise RuntimeError('installed workflow backup did not stop gracefully')
                    flow_source=Path(environment['AGENT_DATA_DIR'])
                    flow_hashes={name:sha256(flow_source/name) for name in source_hashes}
                    flow_backup=root/'workflow backup.zip';flow_restored=root/'workflow restored data'
                    if not installed_cli('--data-dir',flow_source,'backup',flow_backup)['valid']:raise ValueError('workflow backup failed')
                    flow_contents=installed_cli('verify-backup',flow_backup)
                    if not flow_contents['valid'] or flow_contents['contents']['counts']['workflow_runs']!=2:
                        raise ValueError('workflow backup contents differ')
                    if not installed_cli('restore-backup',flow_backup,flow_restored)['valid']:raise ValueError('workflow restore failed')
                    if flow_hashes!={name:sha256(flow_source/name) for name in flow_hashes}:raise ValueError('workflow backup changed original data')
                    environment['AGENT_DATA_DIR']=str(flow_restored);previous=session
                    process=subprocess.Popen(['sh',str(bundle/'scripts/start.sh')],cwd=shadow,env=environment,stdout=log,stderr=subprocess.STDOUT)
                    session=wait_for_session(process,base,root/'server.log',version)
                    if session['csrf_token']==previous['csrf_token']:raise ValueError('workflow restore reused session')
                    verify_workflow_recovery(api,fixture,flow_expected,proposal)
                    workflow_recovery={'same_browser_created_records':True,'process_restart':True,'backup_restore':True,
                        'reads_before_and_after_grant_replay':True,'original_databases_unchanged':True,
                        'fixture':fixture,'snapshot':flow_expected,'backup_counts':flow_contents['contents']['counts']}
                if marker.exists():raise ValueError('caller Python code executed')
                report={'verified_at':datetime.now(timezone.utc).isoformat(),'artifact':str(artifact),'artifact_sha256':sha256(artifact),
                    'version':version,'scope':scope,'fresh_offline_install':True,'all_modules':modules,
                    'ui_resources_matching_wheel':resources,'clean_startup_runs':0,'agent_save_replay':True,
                    'task_submission_replay_and_lookup':True,'isolated_business_worker':True,'verified_simulated_drafts':1,
                    'installed_export_verifier':True,'caller_code_executed':False,'test_data':'temporary-isolated-directories',
                    'restart_checks':restarts,
                    'backup_restore_checks':{'installed_cli':True,'contents':inspected['contents'],
                        'original_databases_unchanged':True,'existing_target_rejected_unchanged':True,
                        'restored_server_started':True,'settings_drafts_history_receipts_and_replays_preserved':True,
                        'browser_uses_restored_data':browser_check},
                    'dependency_wheels':{path.name:sha256(path) for path in wheelhouse.glob('*.whl')}}
                if browser_output:
                    report['browser_results']=str(browser_output/'results.json')
                    report['browser_suites']=browser_suites
                    report['workflow_recovery_checks']=workflow_recovery
            finally:
                stop_server(process)
        if report_path:
            with report_path.open('x') as output:json.dump(report,output,ensure_ascii=False,indent=2);output.write('\n')
        return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifact',type=Path,help='Built wheel or release tar.gz')
    parser.add_argument('--wheelhouse',type=Path,required=True,help='Local PyYAML dependency wheels; verification never downloads')
    parser.add_argument('--report',type=Path,help='New JSON evidence file')
    parser.add_argument('--browser-check',action='store_true',help='Run task submission, opening, naming, archiving, favorites, multi-turn exports, workflow recovery and chat draft checks against the installed server; requires development browser dependencies')
    args=parser.parse_args()
    print(json.dumps(verify(args.artifact,args.wheelhouse,args.report,args.browser_check),ensure_ascii=False,indent=2))


if __name__=='__main__':main()
