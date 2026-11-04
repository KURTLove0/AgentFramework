"""Durable Agent DAGs; a deterministic child identity closes the submit/link crash gap."""
from copy import deepcopy
import json
import logging
import threading
import time
from uuid import uuid4

from .agents import agent_ref,text
from .contracts import Budget,TaskContract,canonical,digest,identifier,PolicyDenied,LeaseBusy,LeaseLost
from .definitions import AgentCompiler,domain_for
from .runtime import Runtime,CrashInjected
from .runtime_config import ConfigConflict
from .workflow_rules import validate_options,matches
from .workflow_agents import prepare_drafts,check_sources
from .workspaces import assert_workspace_active

FLOW_TERMINAL={'SUCCEEDED','FAILED','NEEDS_REVIEW','CANCELLED','EXPIRED'}


class WorkflowSaveReceiptNotFound(KeyError):
    """The scoped save request has no committed receipt yet."""


class WorkflowStartReceiptNotFound(KeyError):
    """No run has been committed for this scoped submission identifier."""


class WorkflowRunNotFound(KeyError):
    """A scoped run row is absent, distinct from malformed stored data."""


def schema(store):
    with store.connect() as db:
        db.executescript('''CREATE TABLE IF NOT EXISTS workflows(tenant TEXT,workspace TEXT,id TEXT,revision INTEGER,data TEXT,archived INTEGER,created REAL,updated REAL,PRIMARY KEY(tenant,id));
        CREATE TABLE IF NOT EXISTS workflow_runs(tenant TEXT,workspace TEXT,principal TEXT,id TEXT,data TEXT,owner TEXT,lease_until REAL DEFAULT 0,cancel_requested INTEGER DEFAULT 0,PRIMARY KEY(tenant,id));
        CREATE TABLE IF NOT EXISTS workflow_events(tenant TEXT,run_id TEXT,seq INTEGER,data TEXT,PRIMARY KEY(tenant,run_id,seq));''')
        db.execute('CREATE TABLE IF NOT EXISTS workflow_saves(tenant TEXT,workspace TEXT,principal TEXT,request_id TEXT,request_hash TEXT,response TEXT,PRIMARY KEY(tenant,workspace,principal,request_id))')
        db.execute('CREATE INDEX IF NOT EXISTS workflow_run_scope ON workflow_runs(tenant,workspace,principal)')
        db.execute('''CREATE TABLE IF NOT EXISTS workflow_dispatches(
            tenant TEXT,run_id TEXT,generation INTEGER,reason TEXT,requested REAL,error TEXT,
            PRIMARY KEY(tenant,run_id))''')


def event(db,tenant,run,kind,data):
    seq=db.execute('SELECT COALESCE(MAX(seq),0)+1 FROM workflow_events WHERE tenant=? AND run_id=?',(tenant,run)).fetchone()[0]
    db.execute('INSERT INTO workflow_events VALUES(?,?,?,?)',(tenant,run,seq,canonical({'seq':seq,'time':time.time(),'kind':kind,'data':data})))


class Workflows:
    def __init__(self,app):
        self.app=app;self.store=app.runtime().store;schema(self.store)
        self.scope=(app.tenant,app.workspace['id'])

    def validate(self,data,draft_profiles=None):
        if not isinstance(data,dict) or not {'name','description','nodes'}<=set(data) or set(data)-{'name','description','nodes','agent_drafts'}:raise ValueError('工作流需要名称、说明和节点')
        drafts=data.get('agent_drafts',[])
        if draft_profiles is None:drafts,draft_profiles,_,_=prepare_drafts(self.app,drafts)
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
            p=draft_profiles.get(n['agent_id']) or self.app.agents.get(n['agent_id'])
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
        if set(draft_profiles)-{n['agent_id'] for n in nodes}:raise ValueError('新智能体必须绑定至少一个流程节点')
        if drafts:result['agent_drafts']=deepcopy(drafts)
        if len(canonical(result).encode())>48000:raise ValueError('工作流过大')
        return result

    def list(self):
        with self.store.connect() as db:rows=db.execute('SELECT * FROM workflows WHERE tenant=? AND workspace=? ORDER BY updated DESC',self.scope).fetchall()
        return [self._row(r) for r in rows]

    def page(self, **options):
        from .workflow_catalog import page
        return page(self, **options)

    def attention(self):
        from .workflow_catalog import attention
        return attention(self)

    @staticmethod
    def _row(row):return {**json.loads(row['data']),'id':row['id'],'revision':row['revision'],'archived':bool(row['archived']),'created_at':row['created'],'updated_at':row['updated']}

    def get(self,identity):
        with self.store.connect() as db:row=db.execute('SELECT * FROM workflows WHERE tenant=? AND workspace=? AND id=?',(*self.scope,identifier(identity))).fetchone()
        if not row:raise KeyError('workflow outside scope')
        return self._row(row)

    def save(self,data,identity=None):
        if not isinstance(data,dict) or not {'name','description','nodes','revision'}<=set(data) or set(data)-{'name','description','nodes','revision','agent_drafts','request_id'}:raise ValueError('工作流字段无效')
        revision=data['revision'];key=data.get('request_id');request_hash=digest({'identity':identity,'data':{k:v for k,v in data.items() if k!='request_id'}})
        def receipt(db):
            if key is None:return None
            row=db.execute('SELECT request_hash,response FROM workflow_saves WHERE tenant=? AND workspace=? AND principal=? AND request_id=?',(*self.scope,self.app.principal,identifier(key))).fetchone()
            if row and row['request_hash']!=request_hash:raise ConfigConflict('同一次保存的内容已改变，请发起新的保存')
            return json.loads(row['response']) if row else None
        with self.store.connect() as db:prior=receipt(db)
        if prior:return prior
        drafts,profiles,sources,config_revision=prepare_drafts(self.app,data.get('agent_drafts',[]))
        definition={k:v for k,v in data.items() if k not in ('revision','request_id')}
        if drafts:definition['agent_drafts']=drafts
        body=self.validate(definition,profiles)
        if drafts and key is None:raise ValueError('创建流程智能体需要保存请求标识')
        if type(revision) is not int or revision<0:raise ValueError('工作流版本无效')
        if identity:self.get(identity)
        elif revision!=0:raise ConfigConflict('新工作流版本应为 0')
        identity=identity or 'workflow-'+uuid4().hex[:16];now=time.time()
        with self.store.transaction() as db:
            assert_workspace_active(db,*self.scope)
            prior=receipt(db)
            if prior:return prior
            check_sources(db,self.app,sources,config_revision)
            for node in body['nodes']:
                if node['agent_id'] in profiles:continue
                current=db.execute('SELECT revision,archived FROM agent_profiles WHERE tenant=? AND workspace_id=? AND id=?',(*self.scope,node['agent_id'])).fetchone()
                if not current or current['archived'] or current['revision']!=node['agent_revision']:raise ConfigConflict('节点 Agent 已更新或停用，请重新选择')
            row=db.execute('SELECT * FROM workflows WHERE tenant=? AND id=?',(self.app.tenant,identity)).fetchone()
            if (row['revision'] if row else 0)!=revision:raise ConfigConflict('工作流已更新，请重新加载')
            if row and row['archived']:raise ConfigConflict('工作流已归档，请先恢复或另存为新流程')
            mapping={alias:'agent-'+uuid4().hex[:16] for alias in profiles}
            for alias,profile in profiles.items():
                value={k:v for k,v in profile.items() if k not in ('id','revision','archived')}
                db.execute('INSERT INTO agent_profiles(tenant,id,revision,data,created,updated,archived,workspace_id) VALUES(?,?,?,?,?,?,?,?)',
                    (self.app.tenant,mapping[alias],1,canonical(value),now,now,0,self.app.workspace['id']))
            for node in body['nodes']:node['agent_id']=mapping.get(node['agent_id'],node['agent_id'])
            body.pop('agent_drafts',None)
            db.execute('INSERT OR REPLACE INTO workflows VALUES(?,?,?,?,?,?,?,?)',(*self.scope,identity,revision+1,canonical(body),row['archived'] if row else 0,row['created'] if row else now,now))
            response={**body,'id':identity,'revision':revision+1,'archived':bool(row['archived']) if row else False,'created_at':row['created'] if row else now,'updated_at':now}
            if key is not None:db.execute('INSERT INTO workflow_saves VALUES(?,?,?,?,?,?)',(*self.scope,self.app.principal,key,request_hash,canonical(response)))
        return response

    def save_request(self,request_id):
        # Return the original committed definition. Current state is a separate
        # read, so a later edit/archive cannot be mistaken for this receipt.
        with self.store.connect() as db:
            row=db.execute('SELECT response FROM workflow_saves WHERE tenant=? AND workspace=? AND principal=? AND request_id=?',
                           (*self.scope,self.app.principal,identifier(request_id))).fetchone()
        if not row:raise WorkflowSaveReceiptNotFound('workflow save receipt not found')
        return {'request_id':request_id,'saved':json.loads(row['response'])}

    def archive(self,identity,revision,archived):
        self.get(identity)
        if type(revision) is not int or type(archived) is not bool:raise ValueError('归档版本无效')
        with self.store.transaction() as db:
            cur=db.execute('UPDATE workflows SET archived=?,revision=revision+1,updated=? WHERE tenant=? AND workspace=? AND id=? AND revision=?',(int(archived),time.time(),*self.scope,identity,revision))
            if cur.rowcount!=1:raise ConfigConflict('工作流已更新')
        return self.get(identity)

    def start(self,identity,data):
        fields={'revision','change_id','grant','consent','mcp_consent','scenarios','max_wall_seconds','request_id','execution_mode'}
        if not isinstance(data,dict) or set(data)-fields:raise ValueError('工作流运行参数无效')
        for key in ('grant','consent','mcp_consent'):
            if key in data and type(data[key]) is not bool:raise ValueError('许可必须为布尔值')
        key=identifier(data.get('request_id') or 'request-'+uuid4().hex[:16])
        # Client retries recover the original run even if Agent/workflow were edited meanwhile.
        run=self.start_identity(key)
        request_hash=digest({'workflow_id':identity,**data,'request_id':key})
        try:
            prior=self.run(run)
            if prior['request_hash']!=request_hash:raise ConfigConflict('同一请求 ID 不能用于不同的运行参数')
            return prior
        except WorkflowRunNotFound:pass
        w=self.get(identity)
        if w['archived']:raise ValueError('工作流已归档')
        if type(data.get('revision')) is not int or w['revision']!=data['revision']:raise ConfigConflict('工作流已更新，请重新审查')
        definition=self.validate({k:w[k] for k in ('name','description','nodes')})
        profiles={n['id']:self.app.agents.get(n['agent_id']) for n in w['nodes']}
        if any(profiles[n['id']]['revision']!=n['agent_revision'] for n in w['nodes']):raise ConfigConflict('节点 Agent 在启动期间已更新，请重新审查')
        if data.get('execution_mode') not in (None,'direct'):raise ValueError('工作流执行方式无效')
        if not isinstance(data.get('scenarios',{}),dict):raise ValueError('故障场景必须为节点配置对象')
        direct=data.get('execution_mode')=='direct' or all((p.get('definition') or {}).get('domain_pack_ref')=='general-assistant@1.0.0' for p in profiles.values())
        if direct and (data.get('grant') or any(s!='normal' for s in data.get('scenarios',{}).values())):raise ValueError('按目标执行的工作流不接受预先写入授权或故障场景')
        modes={n:'direct' if direct or (p.get('definition') or {}).get('domain_pack_ref')=='general-assistant@1.0.0' else None for n,p in profiles.items()}
        compiled_profiles={n:AgentCompiler().compile(p,execution_mode=modes[n]) for n,p in profiles.items()}
        if any(p['runtime']!='mock' for p in profiles.values()) and not data.get('consent'):raise PolicyDenied('真实智能体节点需要允许模型处理本流程上下文')
        if any(((p.get('definition') or {}).get('native_read_refs') or any(m['enabled'] for m in p['mcp_servers'])) for p in profiles.values()) and not data.get('mcp_consent'):raise PolicyDenied('工作流需要受控 MCP 读取许可')
        max_wall=data.get('max_wall_seconds',1800);Budget(max_wall_seconds=max_wall)
        scenarios=data.get('scenarios',{})
        if not isinstance(scenarios,dict) or set(scenarios)-profiles.keys():raise ValueError('故障场景必须引用工作流节点')
        from .definitions import domain_runtime_settings
        for n,p in profiles.items():
            if scenarios.get(n,'normal') not in domain_runtime_settings(compiled_profiles[n]['domain_pack']['ref'])['scenarios']:raise ValueError('节点领域不支持此故障场景')
        frozen={'definition':definition,'profiles':profiles,'compiled':compiled_profiles,'workflow_id':identity,'revision':w['revision']}
        if any(modes.values()):frozen['execution_modes']=modes
        state={'id':run,'workspace_id':self.scope[1],'project_id':self.app.workspace['project_id'],'principal':self.app.principal,'workflow_id':identity,'name':w['name'],
               'snapshot':frozen,'snapshot_hash':digest(frozen),'created_at':time.time(),'deadline':time.time()+max_wall,'status':'CREATED','request_hash':request_hash,
               'change_id':identifier(data.get('change_id',run if direct else 'change-demo-001')),'grant':data.get('grant',False),'scenarios':scenarios,
               'nodes':{n['id']:{'status':'PENDING','run_id':None,'inputs':[]} for n in w['nodes']},'last_error':None}
        with self.store.transaction() as db:
            row=db.execute('SELECT data FROM workflow_runs WHERE tenant=? AND id=?',(self.app.tenant,run)).fetchone()
            if row:
                prior=json.loads(row[0])
                if prior['request_hash']!=request_hash:raise ConfigConflict('请求 ID 已使用')
                return prior
            assert_workspace_active(db,*self.scope)
            current=db.execute('SELECT revision,archived FROM workflows WHERE tenant=? AND workspace=? AND id=?',(*self.scope,identity)).fetchone()
            if not current or current['archived'] or current['revision']!=w['revision']:
                raise ConfigConflict('工作流在启动期间已更新或归档，请重新审查后启动')
            for profile in profiles.values():self.app.agents.assert_submission_current(db,profile)
            db.execute('INSERT INTO workflow_runs(tenant,workspace,principal,id,data) VALUES(?,?,?,?,?)',(*self.scope,self.app.principal,run,canonical(state)))
            event(db,self.app.tenant,run,'workflow.created',{'snapshot_hash':state['snapshot_hash']})
            self._request_dispatch(db,run,'start')
        return self.run(run)

    def start_identity(self,request_id):
        return 'flowrun-'+digest([*self.scope,self.app.principal,identifier(request_id)])[:24]

    def start_request(self,request_id):
        # Resolve the existing deterministic identity without creating a request,
        # changing dispatch state, or revalidating a later workflow definition.
        try:return self.run(self.start_identity(request_id))
        except WorkflowRunNotFound as exc:raise WorkflowStartReceiptNotFound('workflow start receipt not found') from exc

    def dispatch_request(self,identity):
        with self.store.connect() as db:
            row=db.execute('''SELECT d.* FROM workflow_dispatches d JOIN workflow_runs r
                ON r.tenant=d.tenant AND r.id=d.run_id
                WHERE r.tenant=? AND r.workspace=? AND r.principal=? AND r.id=?''',
                (*self.scope,self.app.principal,identifier(identity))).fetchone()
        return dict(row) if row else None

    def _request_dispatch(self,db,identity,reason,*,force=False):
        assert_workspace_active(db,*self.scope)
        row=db.execute('SELECT data,cancel_requested FROM workflow_runs WHERE tenant=? AND workspace=? AND principal=? AND id=?',
                       (*self.scope,self.app.principal,identifier(identity))).fetchone()
        if not row:raise KeyError('workflow run outside scope')
        if json.loads(row['data'])['status'] in FLOW_TERMINAL:raise ConfigConflict('工作流已结束，请新建运行')
        if row['cancel_requested']:
            if reason=='grant':raise ConfigConflict('工作流正在取消，不能新增授权')
            reason='cancel'
        prior=db.execute('SELECT * FROM workflow_dispatches WHERE tenant=? AND run_id=?',(self.app.tenant,identity)).fetchone()
        if row['cancel_requested'] and prior and prior['reason']!='cancel':force=True
        if prior and not prior['error'] and not force:return dict(prior)
        if prior and not force:reason=prior['reason']
        generation=prior['generation']+1 if prior else 1;now=time.time()
        db.execute('INSERT OR REPLACE INTO workflow_dispatches VALUES(?,?,?,?,?,NULL)',(self.app.tenant,identity,generation,reason,now))
        event(db,self.app.tenant,identity,'workflow.dispatch_requested',{'generation':generation,'reason':reason})
        return {'generation':generation,'reason':reason,'requested':now,'error':None}

    def request_dispatch(self,identity,reason='resume'):
        self.run(identity)
        with self.store.transaction() as db:return self._request_dispatch(db,identity,reason)

    def dispatch_error(self,identity,generation,message):
        self.run(identity)
        with self.store.transaction() as db:
            changed=db.execute('UPDATE workflow_dispatches SET error=? WHERE tenant=? AND run_id=? AND generation=?',
                               (message,self.app.tenant,identity,generation)).rowcount
            if changed:event(db,self.app.tenant,identity,'workflow.dispatch_failed',{'generation':generation,'error':message})

    def run(self,identity,*,db=None):
        with self.store.read_snapshot(db) as db:row=db.execute('''SELECT r.*,
            COALESCE((SELECT MAX(e.seq) FROM workflow_events e WHERE e.tenant=r.tenant AND e.run_id=r.id),0) AS state_revision
            FROM workflow_runs r WHERE r.tenant=? AND r.workspace=? AND r.principal=? AND r.id=?''',(*self.scope,self.app.principal,identifier(identity))).fetchone()
        if not row:raise WorkflowRunNotFound('workflow run outside scope')
        s=json.loads(row['data'])
        if digest(s['snapshot'])!=s['snapshot_hash']:raise ValueError('工作流快照摘要不匹配')
        return {**s,'revision':row['state_revision'],'cancel_requested':bool(row['cancel_requested']),'lease_active':bool(row['owner'] and row['lease_until']>time.time())}

    def runs(self):
        with self.store.connect() as db:ids=[r[0] for r in db.execute('SELECT id FROM workflow_runs WHERE tenant=? AND workspace=? AND principal=? ORDER BY rowid DESC LIMIT 100',(*self.scope,self.app.principal))]
        return [self.run(i) for i in ids]

    def events(self,identity):
        self.run(identity)
        with self.store.connect() as db:return [json.loads(r[0]) for r in db.execute('SELECT data FROM workflow_events WHERE tenant=? AND run_id=? ORDER BY seq',(self.app.tenant,identity))]

    def current_child(self,run_id,*,db=None):
        """Resolve a node's latest conversation turn without changing its frozen root."""
        root=self.store.result(self.app.tenant,run_id,db=db);self.app.assert_run_access(root)
        if root['task'].get('execution_mode') not in ('direct','conversation'):return root
        from .task_conversations import TaskConversations
        current=TaskConversations(self.app).view(run_id,db=db,live=db is None)['active_run_id']
        if current==run_id:return root
        child=self.store.result(self.app.tenant,current,db=db);self.app.assert_run_access(child)
        self._assert_turn(root,child)
        return child

    def _assert_turn(self,root,child):
        run_id=root['run_id']
        if (child['task'].get('source_run_id')!=run_id or (child['task'].get('conversation_context') or {}).get('task_id')!=run_id
            or digest(child['snapshot'].get('agent_profile'))!=digest(root['snapshot'].get('agent_profile'))
            or digest(child['task'].get('workflow_inputs',[]))!=digest(root['task'].get('workflow_inputs',[]))
            or child['task'].get('retrieval')!=root['task'].get('retrieval')):
            raise PolicyDenied('workflow conversation binding mismatch')

    def accepted_child(self,item):
        root=self.store.result(self.app.tenant,item['run_id']);self.app.assert_run_access(root)
        output=item.get('output_run_id') or root['run_id']
        if output==root['run_id']:return root
        child=self.store.result(self.app.tenant,output);self.app.assert_run_access(child);self._assert_turn(root,child)
        return child

    def continue_after_reply(self,root_id):
        from .task_conversations import TaskConversations
        view=TaskConversations(self.app).view(root_id)
        if view['active'] or view['queued_count']:return
        # The history shown in the UI is bounded; recovery must include older runs.
        with self.store.connect() as db:
            identities=[r[0] for r in db.execute("SELECT id FROM workflow_runs WHERE tenant=? AND workspace=? AND principal=? AND json_extract(data,'$.status')='WAITING_INPUT'",(*self.scope,self.app.principal))]
        for identity in identities:
            state=self.run(identity)
            if state['lease_active'] or (self.app.job(identity) or {}).get('active'):continue
            if any(item['run_id']==root_id for item in state['nodes'].values()):
                try:self.app.schedule_flow(identity)
                except (ConfigConflict,LeaseBusy):pass

    def _reply_ready(self,state):
        from .task_conversations import TaskConversations
        for item in state['nodes'].values():
            if not item['run_id'] or item['status'] in ('SUCCEEDED','SKIPPED'):continue
            view=TaskConversations(self.app).view(item['run_id'])
            if not view['active'] and not view['queued_count'] and view['status']=='SUCCEEDED':return True
        return False

    def _children_busy(self,state):
        for item in state['nodes'].values():
            if not item['run_id'] or item['status'] in ('SUCCEEDED','SKIPPED'):continue
            try:child=self.current_child(item['run_id'])
            except KeyError:continue  # The intent can precede durable child creation.
            if (self.app.job(child['run_id']) or {}).get('active') or self.app.lease(child['run_id'])['active']:return True
        return False

    @staticmethod
    def tick(app):
        """Recover accepted work and missed reply wakeups without resuming user waits."""
        if app.closed:return
        with app.runtime().store.connect() as db:
            rows=db.execute("""SELECT id,workspace FROM workflow_runs r WHERE tenant=? AND principal=? AND
                (json_extract(data,'$.status') IN ('CREATED','RUNNING','WAITING_INPUT') OR
                 (cancel_requested=1 AND json_extract(data,'$.status') NOT IN ('SUCCEEDED','FAILED','NEEDS_REVIEW','CANCELLED','EXPIRED')) OR
                 EXISTS(SELECT 1 FROM workflow_dispatches d WHERE d.tenant=r.tenant AND d.run_id=r.id))
                ORDER BY rowid""",(app.tenant,app.principal)).fetchall()
        for row in rows:
            with app.lock:
                if app.closed or not app.has_job_capacity():return
                job=app.job(row['id']) or {}
                if job.get('active'):continue
            try:
                flows=app.scoped(row['workspace']).workflows();state=flows.run(row['id'])
                request=flows.dispatch_request(row['id'])
                if state['status'] in FLOW_TERMINAL:
                    with flows.store.transaction() as db:db.execute('DELETE FROM workflow_dispatches WHERE tenant=? AND run_id=?',(app.tenant,row['id']))
                    continue
                if request and request['error']:continue
                if job.get('state') in ('ERROR','CRASHED') and not job.get('retryable'):
                    if not request or request['generation']<=job.get('dispatch_generation',request['generation']):continue
                if state['lease_active'] or flows._children_busy(state):continue
                if not request and not state['cancel_requested'] and state['status'] not in ('CREATED','RUNNING'):
                    if state['status']!='WAITING_INPUT' or not flows._reply_ready(state):continue
                if not request:flows.request_dispatch(row['id'],'recovery')
                flows.app.enqueue_flow(row['id'])
            except (KeyError,ConfigConflict,LeaseBusy):continue
            except Exception:
                logging.getLogger(__name__).exception('Workflow recovery failed for %s',row['id'])

    def _save(self,state,owner,kind,details=None):
        value={k:v for k,v in state.items() if k not in ('lease_active','cancel_requested','revision')}
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
                child=self.current_child(item['run_id']);self.app.assert_run_access(child)
                # Stop-only recovery reconciles uncertain effects without cognition or new dispatches.
                if child['status'] not in FLOW_TERMINAL:
                    if (self.app.job(child['run_id']) or {}).get('active'):self.app.mutate(child['run_id'],'cancel')
                    else:self.app.runtime().cancel(child['run_id'],self.app.tenant)
                item['status']=self.store.load(self.app.tenant,child['run_id'])['status']
                review=review or item['status']=='NEEDS_REVIEW'
        return review

    def execute(self,identity,pause_after=None):
        state=self.run(identity)
        if state['status'] in FLOW_TERMINAL:return state
        owner=uuid4().hex;lease_seconds=15
        with self.store.transaction() as db:
            cur=db.execute('UPDATE workflow_runs SET owner=?,lease_until=? WHERE tenant=? AND id=? AND (owner IS NULL OR lease_until<=?)',(owner,time.time()+lease_seconds,self.app.tenant,identity,time.time()))
            if cur.rowcount!=1:raise LeaseBusy('工作流仍由其他执行器持有')
            request=db.execute('SELECT generation,reason,requested FROM workflow_dispatches WHERE tenant=? AND run_id=?',(self.app.tenant,identity)).fetchone()
            generation=request['generation'] if request else None
        finished=False
        def finish():
            nonlocal finished
            result=self.run(identity);finished=True
            return result
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
                    if item['status']=='SUCCEEDED' and not self._verified(self.accepted_child(item)):
                        self._stop_children(state)
                        state['status']='NEEDS_REVIEW';state['last_error']='上游节点结果不再满足独立验收';self._save(state,owner,'workflow.source_invalidated');return finish()
                if cancelled or expired:
                    review=self._stop_children(state)
                    state['status']='NEEDS_REVIEW' if review else 'CANCELLED' if cancelled else 'EXPIRED';self._save(state,owner,'workflow.stopped');return finish()
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
                        report=self.accepted_child(source)['report'] if source['status']=='SUCCEEDED' else {}
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
                    state['status']='SUCCEEDED';self._save(state,owner,'workflow.verified');return finish()
                node=ready;item=state['nodes'][node['id']];p=state['snapshot']['profiles'][node['id']]
                planner=self.app.agents.planner(p);runtime=self.app.runtime(planner)
                child_id=item['run_id'] or 'run-'+digest([identity,node['id']])[:16]
                item['run_id']=child_id
                inputs=[]
                for parent in node['depends_on']:
                    if state['nodes'][parent]['status']=='SKIPPED':continue
                    prior=self.accepted_child(state['nodes'][parent])
                    inputs.append({'node_id':parent,'run_id':prior['run_id'],'content_hash':digest(prior['report']),'artifact':prior['report']})
                item['inputs']=inputs
                self._save(state,owner,'node.intent',{'node_id':node['id'],'run_id':child_id,'input_hashes':[i['content_hash'] for i in inputs]})
                try:child=self.store.load(self.app.tenant,child_id)
                except KeyError:
                    task=TaskContract(project_id=state['project_id'],tenant_id=self.app.tenant,principal=self.app.principal,change_id=state['change_id'],goal=node['goal'],
                                      agent_ref=agent_ref(p),domain_pack_ref=state['snapshot']['compiled'][node['id']]['domain_pack']['ref'],workflow_inputs=tuple(inputs),
                                      execution_mode=state['snapshot'].get('execution_modes',{}).get(node['id']),
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
                effective=self.current_child(child_id)
                cancellation=effective.get('cancellation')
                if cancellation and cancellation['pending']:
                    item['status']='INTERRUPTED' if cancellation['error'] else 'CANCELLING'
                    state['status']='INTERRUPTED' if cancellation['error'] else 'WAITING_INPUT'
                    state['last_error']='节点停止处理受阻，请打开原任务重试停止。' if cancellation['error'] else '节点正在停止，已有结果与记录保留。'
                    self._save(state,owner,'node.cancellation_pending',{'node_id':node['id'],'run_id':effective['run_id']});return finish()
                interruption=effective.get('interruption')
                if interruption and not (request and request['reason'] in {'resume','grant'} and request['requested']>=interruption['at']):
                    item['status']='INTERRUPTED';state['status']='INTERRUPTED';state['last_error']=interruption['message']
                    self._save(state,owner,'node.interrupted',{'node_id':node['id'],'run_id':effective['run_id'],'code':interruption['code']});return finish()
                if (self.app.job(effective['run_id']) or {}).get('active') or self.app.lease(effective['run_id'])['active']:
                    state['status']='WAITING_INPUT';state['last_error']='节点正在处理补充信息，完成后将继续工作流。';self._save(state,owner,'workflow.conversation_pending');return finish()
                runtime=self.app.runtime()
                cancel_state={'at':0,'value':False}
                def child_cancelled():
                    if self.app.closed or bool(self.app.jobs.get(identity,{}).get('cancel') and self.app.jobs[identity]['cancel'].is_set()):return True
                    if time.monotonic()-cancel_state['at']>.1:
                        with self.store.connect() as db:cancel_state['value']=bool(db.execute('SELECT cancel_requested FROM workflow_runs WHERE tenant=? AND id=?',(self.app.tenant,identity)).fetchone()[0])
                        cancel_state['at']=time.monotonic()
                    return cancel_state['value']
                runtime.cancel_requested=child_cancelled
                try:child=runtime.run(effective['run_id'],self.app.tenant,pause_after=1)
                except CrashInjected:
                    item['status']='INTERRUPTED';state['status']='INTERRUPTED';state['last_error']='节点写入后中断；租约到期后恢复原任务核对。';self._save(state,owner,'node.interrupted');return finish()
                item['status']=child['status'];ticks+=1
                if child['status']=='SUCCEEDED':item['output_run_id']=child['run_id']
                if child_cancelled():
                    review=self._stop_children(state);state['status']='NEEDS_REVIEW' if review else 'CANCELLED';self._save(state,owner,'workflow.stopped');return finish()
                if child['status'] in ('WAITING_AUTH','WAITING_INPUT'):
                    state['status']=child['status'];self._save(state,owner,'workflow.waiting',{'node_id':node['id'],'status':child['status']});return finish()
                if child['status'] in FLOW_TERMINAL and (child['status']!='SUCCEEDED' or not self._verified(child)):
                    state['status']='WAITING_INPUT' if child['task'].get('execution_mode') in ('direct','conversation') and child['status'] in ('FAILED','EXPIRED','CANCELLED') else 'NEEDS_REVIEW' if child['status'] in ('NEEDS_REVIEW','SUCCEEDED') else child['status'];state['last_error']='节点未完成，请打开节点任务补充或重试。完成后将继续流程。' if state['status']=='WAITING_INPUT' else '节点未通过验收，依赖节点不会执行。';self._save(state,owner,'workflow.node_failed',{'node_id':node['id']});return finish()
                self._save(state,owner,'node.checkpoint',{'node_id':node['id'],'status':child['status']})
                if pause_after and ticks>=pause_after:
                    state['status']='PAUSED';self._save(state,owner,'workflow.paused');return finish()
        except (LeaseBusy,LeaseLost):raise
        except Exception as exc:
            state['status']='NEEDS_REVIEW';state['last_error']=str(exc)[:500];self._save(state,owner,'workflow.error');return finish()
        finally:
            stop.set();thread.join(5)
            with self.store.transaction() as db:
                released=db.execute('UPDATE workflow_runs SET owner=NULL,lease_until=0 WHERE tenant=? AND id=? AND owner=?',(self.app.tenant,identity,owner)).rowcount
                if released and finished and generation is not None:
                    db.execute('DELETE FROM workflow_dispatches WHERE tenant=? AND run_id=? AND generation=?',(self.app.tenant,identity,generation))

    def cancel(self,identity):
        if self.run(identity)['status'] in FLOW_TERMINAL:raise ConfigConflict('工作流已结束')
        with self.store.transaction() as db:
            self._request_dispatch(db,identity,'cancel',force=True)
            db.execute('UPDATE workflow_runs SET cancel_requested=1 WHERE tenant=? AND id=?',(self.app.tenant,identity))

    def grant_token(self,identity,node_id,child,pending,*,db=None):
        # Bind the displayed proposal, not just a mutable node or argument hash.
        prior=self.store.get_grant(child,db=db)
        return digest({'scope':[*self.scope,self.app.principal],'workflow':identity,'node':node_id,
                       'run':child['run_id'],'snapshot':child['snapshot']['hash'],
                       'grant':prior,'grant_expired':bool(prior and prior['expires_at']<=time.time()),
                       'proposal':{key:pending[key] for key in ('logical_id','tool_ref','args','args_hash','resource')}})

    def grant(self,identity,node_id,proposal_token):
        identifier(node_id)
        if not isinstance(proposal_token,str) or len(proposal_token)!=64 or any(c not in '0123456789abcdef' for c in proposal_token):
            raise ValueError('请刷新运行详情并审查具体提案后授权')
        self.run(identity)
        with self.store.transaction() as db:
            # Re-read all mutable state under the same writer lock as the grant
            # and dispatch. A changed proposal or conversation turn is not consent.
            state=self.run(identity,db=db)
            prior_receipt=db.execute("SELECT data FROM workflow_events WHERE tenant=? AND run_id=? AND json_extract(data,'$.kind')='workflow.granted' AND json_extract(data,'$.data.proposal_token')=? AND json_extract(data,'$.data.node_id')=? ORDER BY seq DESC LIMIT 1",
                                     (self.app.tenant,identity,proposal_token,node_id)).fetchone()
            if prior_receipt:return json.loads(prior_receipt['data'])['data']['proposal']
            if state['cancel_requested'] or state['status'] in FLOW_TERMINAL:raise ConfigConflict('工作流正在取消或已结束，不能新增授权')
            if state['status']!='WAITING_AUTH' or node_id not in state['nodes']:raise ConfigConflict('工作流没有等待此节点授权')
            item=state['nodes'][node_id]
            if item['status']!='WAITING_AUTH' or not item['run_id']:raise ConfigConflict('节点不在等待授权')
            child=self.current_child(item['run_id'],db=db)
            if (child.get('cancellation') or {}).get('pending'):raise ConfigConflict('节点任务正在停止，不能新增授权')
            if child['status']!='WAITING_AUTH':raise ConfigConflict('节点任务状态已变化，请刷新运行详情')
            pending=next((a for a in child['actions'] if a['status']=='PREPARED' and a['tool_ref']=='report.draft.create@1.0.0'),None)
            if not pending:raise ConfigConflict('没有具体写入提案，请刷新运行详情')
            if pending['args_hash']!=digest(pending['args']):raise ConfigConflict('提案内容与摘要不一致，不能授权')
            if self.grant_token(identity,node_id,child,pending,db=db)!=proposal_token:raise ConfigConflict('写入提案或授权状态已变化，请刷新并重新审查；未授权新的内容')
            prior=self.store.get_grant(child,db=db)
            reusable=prior and not prior['revoked'] and prior['expires_at']>time.time() and prior['args_hash']==pending['args_hash']
            if not reusable:self.store.grant(child,pending['args_hash'],db=db)
            self._request_dispatch(db,identity,'grant',force=not reusable)
            event(db,self.app.tenant,identity,'workflow.granted',{'node_id':node_id,'proposal_token':proposal_token,'proposal':pending})
        return pending
