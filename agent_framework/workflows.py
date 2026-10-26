"""Durable Agent DAGs; a deterministic child identity closes the submit/link crash gap."""
from copy import deepcopy
import json
import threading
import time
from uuid import uuid4

from .agents import agent_ref,text
from .contracts import Budget,TaskContract,canonical,digest,identifier,PolicyDenied,LeaseBusy,LeaseLost
from .definitions import AgentCompiler,domain_for
from .runtime import Runtime,CrashInjected
from .runtime_config import ConfigConflict
from .workflow_rules import validate_options,matches

FLOW_TERMINAL={'SUCCEEDED','FAILED','NEEDS_REVIEW','CANCELLED','EXPIRED'}


def schema(store):
    with store.connect() as db:
        db.executescript('''CREATE TABLE IF NOT EXISTS workflows(tenant TEXT,workspace TEXT,id TEXT,revision INTEGER,data TEXT,archived INTEGER,created REAL,updated REAL,PRIMARY KEY(tenant,id));
        CREATE TABLE IF NOT EXISTS workflow_runs(tenant TEXT,workspace TEXT,principal TEXT,id TEXT,data TEXT,owner TEXT,lease_until REAL DEFAULT 0,cancel_requested INTEGER DEFAULT 0,PRIMARY KEY(tenant,id));
        CREATE TABLE IF NOT EXISTS workflow_events(tenant TEXT,run_id TEXT,seq INTEGER,data TEXT,PRIMARY KEY(tenant,run_id,seq));''')


def event(db,tenant,run,kind,data):
    seq=db.execute('SELECT COALESCE(MAX(seq),0)+1 FROM workflow_events WHERE tenant=? AND run_id=?',(tenant,run)).fetchone()[0]
    db.execute('INSERT INTO workflow_events VALUES(?,?,?,?)',(tenant,run,seq,canonical({'seq':seq,'time':time.time(),'kind':kind,'data':data})))


class Workflows:
    def __init__(self,app):
        self.app=app;self.store=app.runtime().store;schema(self.store)
        self.scope=(app.tenant,app.workspace['id'])

    def validate(self,data):
        if not isinstance(data,dict) or set(data)!={'name','description','nodes'}:raise ValueError('工作流需要名称、说明和节点')
        result={'name':text(data['name'],'工作流名称',100),'description':text(data['description'],'工作流说明',1000,empty=True),'nodes':deepcopy(data['nodes'])}
        nodes=result['nodes']
        if not isinstance(nodes,list) or not 1<=len(nodes)<=12:raise ValueError('工作流需要 1–12 个 Agent 节点')
        ids=set()
        for n in nodes:
            required={'id','name','agent_id','agent_revision','goal','depends_on'}
            if not isinstance(n,dict) or not required<=set(n) or set(n)-required-{'condition','join','retrieval'}:raise ValueError('节点必须指定 Agent 版本、目标及依赖')
            identifier(n['id']);identifier(n['agent_id']);n['name']=text(n['name'],'节点名称',100);n['goal']=text(n['goal'],'节点目标',2000)
            if n['id'] in ids:raise ValueError('节点 ID 不能重复')
            ids.add(n['id'])
            p=self.app.agents.get(n['agent_id'])
            if type(n['agent_revision']) is not int or p['revision']!=n['agent_revision']:raise ConfigConflict('节点 Agent 已更新，请重新选择当前版本')
            if p['archived']:raise ValueError('节点 Agent 已归档')
            self.app.agents.assert_skills_available(p)
            AgentCompiler().compile(p)
            if not isinstance(n['depends_on'],list) or len(n['depends_on'])>11 or len(n['depends_on'])!=len(set(n['depends_on'])):raise ValueError('节点依赖无效')
            validate_options(n)
        for n in nodes:
            if set(n['depends_on'])-ids or n['id'] in n['depends_on']:raise ValueError('依赖须引用其他已存在的节点')
        done=set()
        while len(done)<len(nodes):
            ready=[n['id'] for n in nodes if n['id'] not in done and set(n['depends_on'])<=done]
            if not ready:raise ValueError('工作流存在循环依赖')
            done.update(ready)
        if len(canonical(result).encode())>48000:raise ValueError('工作流过大')
        return result

    def list(self):
        with self.store.connect() as db:rows=db.execute('SELECT * FROM workflows WHERE tenant=? AND workspace=? ORDER BY updated DESC',self.scope).fetchall()
        return [self._row(r) for r in rows]

    @staticmethod
    def _row(row):return {**json.loads(row['data']),'id':row['id'],'revision':row['revision'],'archived':bool(row['archived']),'created_at':row['created'],'updated_at':row['updated']}

    def get(self,identity):
        with self.store.connect() as db:row=db.execute('SELECT * FROM workflows WHERE tenant=? AND workspace=? AND id=?',(*self.scope,identifier(identity))).fetchone()
        if not row:raise KeyError('workflow outside scope')
        return self._row(row)

    def save(self,data,identity=None):
        if not isinstance(data,dict) or set(data)!={'name','description','nodes','revision'}:raise ValueError('工作流字段无效')
        revision=data['revision'];body=self.validate({k:v for k,v in data.items() if k!='revision'})
        if type(revision) is not int or revision<0:raise ValueError('工作流版本无效')
        if identity:self.get(identity)
        elif revision!=0:raise ConfigConflict('新工作流版本应为 0')
        identity=identity or 'workflow-'+uuid4().hex[:16];now=time.time()
        with self.store.transaction() as db:
            row=db.execute('SELECT * FROM workflows WHERE tenant=? AND id=?',(self.app.tenant,identity)).fetchone()
            if (row['revision'] if row else 0)!=revision:raise ConfigConflict('工作流已更新，请重新加载')
            db.execute('INSERT OR REPLACE INTO workflows VALUES(?,?,?,?,?,?,?,?)',(*self.scope,identity,revision+1,canonical(body),row['archived'] if row else 0,row['created'] if row else now,now))
        return self.get(identity)

    def archive(self,identity,revision,archived):
        self.get(identity)
        if type(revision) is not int or type(archived) is not bool:raise ValueError('归档版本无效')
        with self.store.transaction() as db:
            cur=db.execute('UPDATE workflows SET archived=?,revision=revision+1,updated=? WHERE tenant=? AND workspace=? AND id=? AND revision=?',(int(archived),time.time(),*self.scope,identity,revision))
            if cur.rowcount!=1:raise ConfigConflict('工作流已更新')
        return self.get(identity)

    def start(self,identity,data):
        fields={'revision','change_id','grant','consent','mcp_consent','scenarios','max_wall_seconds','request_id'}
        if not isinstance(data,dict) or set(data)-fields:raise ValueError('工作流运行参数无效')
        for key in ('grant','consent','mcp_consent'):
            if key in data and type(data[key]) is not bool:raise ValueError('许可必须为布尔值')
        key=identifier(data.get('request_id') or 'request-'+uuid4().hex[:16])
        # Client retries recover the original run even if Agent/workflow were edited meanwhile.
        run='flowrun-'+digest([*self.scope,self.app.principal,key])[:24]
        request_hash=digest({'workflow_id':identity,**data,'request_id':key})
        try:
            prior=self.run(run)
            if prior['request_hash']!=request_hash:raise ConfigConflict('同一请求 ID 不能用于不同的运行参数')
            return prior
        except KeyError:pass
        w=self.get(identity)
        if w['archived']:raise ValueError('工作流已归档')
        if type(data.get('revision')) is not int or w['revision']!=data['revision']:raise ConfigConflict('工作流已更新，请重新审查')
        definition=self.validate({k:w[k] for k in ('name','description','nodes')})
        profiles={n['id']:self.app.agents.get(n['agent_id']) for n in w['nodes']}
        if any(profiles[n['id']]['revision']!=n['agent_revision'] for n in w['nodes']):raise ConfigConflict('节点 Agent 在启动期间已更新，请重新审查')
        compiled_profiles={n:AgentCompiler().compile(p) for n,p in profiles.items()}
        if any(p['runtime']!='mock' for p in profiles.values()) and not data.get('consent'):raise PolicyDenied('真实 Agent 节点需要模拟上下文发送许可')
        if any(((p.get('definition') or {}).get('native_read_refs') or any(m['enabled'] for m in p['mcp_servers'])) for p in profiles.values()) and not data.get('mcp_consent'):raise PolicyDenied('工作流需要受控 MCP 读取许可')
        max_wall=data.get('max_wall_seconds',1800);Budget(max_wall_seconds=max_wall)
        scenarios=data.get('scenarios',{})
        if not isinstance(scenarios,dict) or set(scenarios)-profiles.keys():raise ValueError('故障场景必须引用工作流节点')
        from .definitions import domain_runtime_settings
        for n,p in profiles.items():
            if scenarios.get(n,'normal') not in domain_runtime_settings(compiled_profiles[n]['domain_pack']['ref'])['scenarios']:raise ValueError('节点领域不支持此故障场景')
        frozen={'definition':definition,'profiles':profiles,'compiled':compiled_profiles,'workflow_id':identity,'revision':w['revision']}
        state={'id':run,'workspace_id':self.scope[1],'project_id':self.app.workspace['project_id'],'principal':self.app.principal,'workflow_id':identity,'name':w['name'],
               'snapshot':frozen,'snapshot_hash':digest(frozen),'created_at':time.time(),'deadline':time.time()+max_wall,'status':'CREATED','request_hash':request_hash,
               'change_id':identifier(data.get('change_id','change-demo-001')),'grant':data.get('grant',False),'scenarios':scenarios,
               'nodes':{n['id']:{'status':'PENDING','run_id':None,'inputs':[]} for n in w['nodes']},'last_error':None}
        with self.store.transaction() as db:
            row=db.execute('SELECT data FROM workflow_runs WHERE tenant=? AND id=?',(self.app.tenant,run)).fetchone()
            if row:
                prior=json.loads(row[0])
                if prior['request_hash']!=request_hash:raise ConfigConflict('请求 ID 已使用')
                return prior
            db.execute('INSERT INTO workflow_runs(tenant,workspace,principal,id,data) VALUES(?,?,?,?,?)',(*self.scope,self.app.principal,run,canonical(state)))
            event(db,self.app.tenant,run,'workflow.created',{'snapshot_hash':state['snapshot_hash']})
        return self.run(run)

    def run(self,identity):
        with self.store.connect() as db:row=db.execute('SELECT * FROM workflow_runs WHERE tenant=? AND workspace=? AND principal=? AND id=?',(*self.scope,self.app.principal,identifier(identity))).fetchone()
        if not row:raise KeyError('workflow run outside scope')
        s=json.loads(row['data'])
        if digest(s['snapshot'])!=s['snapshot_hash']:raise ValueError('工作流快照摘要不匹配')
        return {**s,'cancel_requested':bool(row['cancel_requested']),'lease_active':bool(row['owner'] and row['lease_until']>time.time())}

    def runs(self):
        with self.store.connect() as db:ids=[r[0] for r in db.execute('SELECT id FROM workflow_runs WHERE tenant=? AND workspace=? AND principal=? ORDER BY rowid DESC LIMIT 100',(*self.scope,self.app.principal))]
        return [self.run(i) for i in ids]

    def events(self,identity):
        self.run(identity)
        with self.store.connect() as db:return [json.loads(r[0]) for r in db.execute('SELECT data FROM workflow_events WHERE tenant=? AND run_id=? ORDER BY seq',(self.app.tenant,identity))]

    def _save(self,state,owner,kind,details=None):
        value={k:v for k,v in state.items() if k not in ('lease_active','cancel_requested')}
        with self.store.transaction() as db:
            cur=db.execute('UPDATE workflow_runs SET data=? WHERE tenant=? AND id=? AND owner=? AND lease_until>?',(canonical(value),self.app.tenant,state['id'],owner,time.time()))
            if cur.rowcount!=1:raise LeaseLost('workflow lease lost')
            event(db,self.app.tenant,state['id'],kind,details or {})

    def _verified(self,child):
        self.app.assert_run_access(child)
        if child['status']!='SUCCEEDED' or any(a['status'] in ('DISPATCHED','UNKNOWN','RECONCILING','NEEDS_REVIEW') for a in child['residual_effects']):return False
        if digest({k:v for k,v in child['snapshot'].items() if k!='hash'})!=child['snapshot']['hash']:return False
        AgentCompiler.validate(child['snapshot']['compiled_agent'])
        checks=domain_for(child['snapshot']).task_checks(child,self.store.evidence(child),self.store)
        return bool(checks) and all(c['passed'] for c in checks.values())

    def _stop_children(self,state):
        review=False
        for item in state['nodes'].values():
            if item['run_id'] and item['status']!='SUCCEEDED':
                child=self.store.result(self.app.tenant,item['run_id']);self.app.assert_run_access(child)
                # Stop-only recovery reconciles uncertain effects without cognition or new dispatches.
                if child['status'] not in FLOW_TERMINAL:self.app.runtime().cancel(child['run_id'],self.app.tenant)
                item['status']=self.store.load(self.app.tenant,item['run_id'])['status']
                review=review or item['status']=='NEEDS_REVIEW'
        return review

    def execute(self,identity,pause_after=None):
        state=self.run(identity)
        if state['status'] in FLOW_TERMINAL:return state
        owner=uuid4().hex;lease_seconds=15
        with self.store.transaction() as db:
            cur=db.execute('UPDATE workflow_runs SET owner=?,lease_until=? WHERE tenant=? AND id=? AND (owner IS NULL OR lease_until<=?)',(owner,time.time()+lease_seconds,self.app.tenant,identity,time.time()))
            if cur.rowcount!=1:raise LeaseBusy('工作流仍由其他执行器持有')
        stop=threading.Event()
        def heartbeat():
            while not stop.wait(3):
                with self.store.transaction() as db:db.execute('UPDATE workflow_runs SET lease_until=? WHERE tenant=? AND id=? AND owner=?',(time.time()+lease_seconds,self.app.tenant,identity,owner))
        thread=threading.Thread(target=heartbeat,daemon=True);thread.start();ticks=0
        try:
            state['status']='RUNNING';state['last_error']=None;self._save(state,owner,'workflow.resumed')
            while True:
                job_cancel=self.app.jobs.get(identity,{}).get('cancel')
                cancelled=self.run(identity)['cancel_requested'] or bool(job_cancel and job_cancel.is_set());expired=time.time()>=state['deadline']
                nodes=state['snapshot']['definition']['nodes']
                if set(state['nodes'])!={n['id'] for n in nodes}:raise PolicyDenied('workflow node state binding mismatch')
                for n in nodes:
                    linked=state['nodes'][n['id']]['run_id']
                    if linked and linked!='run-'+digest([identity,n['id']])[:16]:raise PolicyDenied('workflow child identity mismatch')
                # Current source checks apply before completed outputs can feed another Agent.
                for n in nodes:
                    item=state['nodes'][n['id']]
                    if item['status']=='SUCCEEDED' and not self._verified(self.store.result(self.app.tenant,item['run_id'])):
                        self._stop_children(state)
                        state['status']='NEEDS_REVIEW';state['last_error']='上游节点结果不再满足独立验收';self._save(state,owner,'workflow.source_invalidated');return self.run(identity)
                if cancelled or expired:
                    review=self._stop_children(state)
                    state['status']='NEEDS_REVIEW' if review else 'CANCELLED' if cancelled else 'EXPIRED';self._save(state,owner,'workflow.stopped');return self.run(identity)
                ready=None;skipped=False
                for n in nodes:
                    item=state['nodes'][n['id']]
                    if item['status'] in ('SUCCEEDED','SKIPPED'):continue
                    parents=[state['nodes'][d]['status'] for d in n['depends_on']]
                    if any(s not in ('SUCCEEDED','SKIPPED') for s in parents):continue
                    active=not parents or (any(s=='SUCCEEDED' for s in parents) if n.get('join','all')=='any' else all(s=='SUCCEEDED' for s in parents))
                    condition=n.get('condition');decision=None
                    if active and condition:
                        source=state['nodes'][condition['source']]
                        report=self.store.result(self.app.tenant,source['run_id'])['report'] if source['status']=='SUCCEEDED' else {}
                        active=source['status']=='SUCCEEDED' and matches(condition,report)
                        decision={'condition':condition,'source_hash':digest(report),'matched':active}
                    if not active:
                        if item['run_id']:raise PolicyDenied('previously dispatched node cannot become skipped')
                        item.update(status='SKIPPED',routing=decision or {'reason':'upstream-skipped'})
                        skipped=True
                        self._save(state,owner,'node.skipped',{'node_id':n['id'],'routing':item['routing']})
                        continue
                    item['routing']=decision or {'reason':'dependencies-satisfied'};ready=n;break
                if not ready:
                    if skipped:continue
                    if any(i['status'] not in ('SUCCEEDED','SKIPPED') for i in state['nodes'].values()):raise PolicyDenied('workflow has unresolved dependencies')
                    state['status']='SUCCEEDED';self._save(state,owner,'workflow.verified');return self.run(identity)
                node=ready;item=state['nodes'][node['id']];p=state['snapshot']['profiles'][node['id']]
                planner=self.app.agents.planner(p);runtime=self.app.runtime(planner)
                child_id=item['run_id'] or 'run-'+digest([identity,node['id']])[:16]
                item['run_id']=child_id
                inputs=[]
                for parent in node['depends_on']:
                    if state['nodes'][parent]['status']=='SKIPPED':continue
                    prior=self.store.result(self.app.tenant,state['nodes'][parent]['run_id'])
                    inputs.append({'node_id':parent,'run_id':prior['run_id'],'content_hash':digest(prior['report']),'artifact':prior['report']})
                item['inputs']=inputs
                self._save(state,owner,'node.intent',{'node_id':node['id'],'run_id':child_id,'input_hashes':[i['content_hash'] for i in inputs]})
                try:child=self.store.load(self.app.tenant,child_id)
                except KeyError:
                    task=TaskContract(project_id=state['project_id'],tenant_id=self.app.tenant,principal=self.app.principal,change_id=state['change_id'],goal=node['goal'],
                                      agent_ref=agent_ref(p),domain_pack_ref=state['snapshot']['compiled'][node['id']]['domain_pack']['ref'],workflow_inputs=tuple(inputs),
                                      retrieval=node.get('retrieval'),
                                      budget=Budget(max_wall_seconds=max(1,min(600,state['deadline']-time.time()))))
                    child=runtime.submit(task,scenario=state['scenarios'].get(node['id'],'normal'),grant=state['grant'],agent_profile=p,run_id=child_id)
                    self._save(state,owner,'node.submitted',{'node_id':node['id'],'run_id':child_id})
                if (child['task']['principal']!=self.app.principal or child['task']['project_id']!=state['project_id']
                        or child['task']['goal']!=node['goal'] or child['task']['change_id']!=state['change_id']
                        or digest(child['task'].get('workflow_inputs',[]))!=digest(inputs)
                        or child['task'].get('retrieval')!=node.get('retrieval')
                        or child['snapshot']['compiled_agent']['hash']!=state['snapshot']['compiled'][node['id']]['hash']):
                    raise PolicyDenied('child task binding mismatch')
                try:child=runtime.run(child_id,self.app.tenant,pause_after=1)
                except CrashInjected:
                    item['status']='INTERRUPTED';state['status']='INTERRUPTED';state['last_error']='节点写入后中断；租约到期后恢复原任务核对。';self._save(state,owner,'node.interrupted');return self.run(identity)
                item['status']=child['status'];ticks+=1
                if child['status'] in ('WAITING_AUTH','WAITING_INPUT'):
                    state['status']=child['status'];self._save(state,owner,'workflow.waiting',{'node_id':node['id'],'status':child['status']});return self.run(identity)
                if child['status'] in FLOW_TERMINAL and (child['status']!='SUCCEEDED' or not self._verified(child)):
                    state['status']='NEEDS_REVIEW' if child['status'] in ('NEEDS_REVIEW','SUCCEEDED') else child['status'];state['last_error']='节点未通过验收，依赖节点不会执行。';self._save(state,owner,'workflow.node_failed',{'node_id':node['id']});return self.run(identity)
                self._save(state,owner,'node.checkpoint',{'node_id':node['id'],'status':child['status']})
                if pause_after and ticks>=pause_after:
                    state['status']='PAUSED';self._save(state,owner,'workflow.paused');return self.run(identity)
        except (LeaseBusy,LeaseLost):raise
        except Exception as exc:
            state['status']='NEEDS_REVIEW';state['last_error']=str(exc)[:500];self._save(state,owner,'workflow.error');return self.run(identity)
        finally:
            stop.set();thread.join(5)
            with self.store.transaction() as db:db.execute('UPDATE workflow_runs SET owner=NULL,lease_until=0 WHERE tenant=? AND id=? AND owner=?',(self.app.tenant,identity,owner))

    def cancel(self,identity):
        if self.run(identity)['status'] in FLOW_TERMINAL:raise ConfigConflict('工作流已结束')
        with self.store.transaction() as db:db.execute('UPDATE workflow_runs SET cancel_requested=1 WHERE tenant=? AND id=?',(self.app.tenant,identity))

    def grant(self,identity,node_id):
        state=self.run(identity)
        if state['status']!='WAITING_AUTH' or node_id not in state['nodes']:raise ConfigConflict('工作流没有等待此节点授权')
        item=state['nodes'][node_id]
        if item['status']!='WAITING_AUTH' or not item['run_id']:raise ConfigConflict('节点不在等待授权')
        child=self.store.result(self.app.tenant,item['run_id']);self.app.assert_run_access(child)
        pending=next((a for a in child['actions'] if a['status']=='PREPARED' and a['tool_ref']=='report.draft.create@1.0.0'),None)
        if not pending:raise ConfigConflict('没有具体写入提案')
        self.store.grant(child,pending['args_hash']);return pending
