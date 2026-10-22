"""Model selectors populated by the installed CLI, never by a static product list."""
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import tempfile
import threading
import time

from .contracts import canonical
from .store import Store


class ModelDiscoveryError(ValueError):
    pass


class ModelCatalog:
    def __init__(self, data_dir, tenant):
        self.store=Store(Path(data_dir)/'runtime.sqlite3')
        self.tenant=tenant
        self.lock=threading.Lock()
        with self.store.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS model_catalog (tenant TEXT, provider TEXT, data TEXT, fetched REAL, PRIMARY KEY(tenant,provider))')

    def cached(self, provider):
        with self.store.connect() as db:
            row=db.execute('SELECT data,fetched FROM model_catalog WHERE tenant=? AND provider=?',(self.tenant,provider)).fetchone()
        return {**json.loads(row['data']),'fetched_at':row['fetched'],'cached':True} if row else None

    def list(self, provider, refresh=False):
        if provider not in {'codex','cursor','mock'}:raise ValueError('不支持的运行时')
        if provider=='mock':return {'provider':'mock','models':[{'id':'builtin','name':'内置确定性规划器','efforts':[]}],'source':'built-in','cached':False,'fetched_at':None}
        with self.lock:
            cached=self.cached(provider)
            if cached and not refresh and time.time()-cached['fetched_at']<300:return cached
            try:
                models=self._codex() if provider=='codex' else self._cursor()
                if not models:raise ModelDiscoveryError('CLI 未返回可选择的模型')
            except (OSError,subprocess.SubprocessError,ValueError,KeyError,TypeError,AttributeError,queue.Empty) as exc:
                # A previous list remains available for display but cannot pretend to be fresh.
                raise ModelDiscoveryError('无法读取 '+provider+' 模型列表，请检查 CLI 登录态、网络与版本后重试') from exc
            data={'provider':provider,'models':models,'source':'codex app-server model/list' if provider=='codex' else 'cursor-agent models'}
            now=time.time()
            with self.store.connect() as db:
                db.execute('INSERT OR REPLACE INTO model_catalog VALUES(?,?,?,?)',(self.tenant,provider,canonical(data),now))
            return {**data,'fetched_at':now,'cached':False}

    def require(self, provider, model):
        if provider=='mock':return
        for item in self.list(provider)['models']:
            if item['id']==model:return item
        raise ValueError('请选择当前 CLI 模型列表中的具体模型')

    @staticmethod
    def _cursor():
        result=subprocess.run(['cursor-agent','models'],capture_output=True,text=True,timeout=20,env={**os.environ,'NO_COLOR':'1'})
        if result.returncode:raise ModelDiscoveryError('Cursor model lookup failed')
        plain=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',result.stdout)
        models=[];seen=set()
        for line in plain.splitlines():
            match=re.fullmatch(r'\s*([A-Za-z0-9][A-Za-z0-9_.:/-]{0,119})\s+-\s+(.+?)\s*',line)
            if not match or match[1] in {'auto','default'} or match[1] in seen:continue
            seen.add(match[1]);models.append({'id':match[1],'name':match[2], 'efforts':[]})
        return models

    @staticmethod
    def _codex():
        with tempfile.TemporaryDirectory(prefix='agent-model-list-') as directory:
            command=['codex','app-server','--stdio']
            for feature in ('plugins','hooks','apps','shell_tool','multi_agent','browser_use','computer_use'):
                command+=['-c',f'features.{feature}=false']
            process=subprocess.Popen(command,cwd=directory,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,start_new_session=True)
            messages=queue.Queue(maxsize=1000)
            def reader():
                try:
                    for line in process.stdout:
                        if len(line)>2*1024*1024:break
                        messages.put_nowait(json.loads(line))
                except (ValueError,queue.Full):pass
                finally:
                    try:messages.put_nowait(None)
                    except queue.Full:pass
            thread=threading.Thread(target=reader,daemon=True);thread.start()
            deadline=time.monotonic()+20
            def send(data):process.stdin.write(canonical(data)+'\n');process.stdin.flush()
            def response(identity):
                while True:
                    data=messages.get(timeout=max(.01,deadline-time.monotonic()))
                    if data is None:raise ModelDiscoveryError('Codex model session ended')
                    if data.get('id')==identity:
                        if 'error' in data:raise ModelDiscoveryError('Codex model request rejected')
                        return data['result']
            try:
                send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'agent-framework-models','version':'0.1.0'}}})
                response(1);send({'method':'initialized'})
                models=[];cursor=None
                for page in range(20):
                    identity=page+2
                    send({'id':identity,'method':'model/list','params':{'limit':100,'includeHidden':False,**({'cursor':cursor} if cursor else {})}})
                    result=response(identity)
                    for row in result['data']:
                        if row.get('hidden'):continue
                        model=row.get('model') or row['id']
                        models.append({'id':model,'name':row.get('displayName',model),'efforts':[e['reasoningEffort'] for e in row.get('supportedReasoningEfforts',[])], 'default_effort':row.get('defaultReasoningEffort'), 'is_default':row.get('isDefault',False)})
                    cursor=result.get('nextCursor')
                    if not cursor:break
                else:raise ModelDiscoveryError('Codex model catalog is too large')
                return list({m['id']:m for m in models}.values())
            finally:
                try:os.killpg(process.pid,signal.SIGTERM)
                except ProcessLookupError:pass
                try:process.wait(timeout=2)
                except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait()
                process.stdin.close();process.stdout.close();thread.join(timeout=1)
