"""Persistent task messages; each model turn has its own immutable execution.

Threads keep a stable task identity. Queued messages survive refresh/restart and
are dispatched in order only after the previous model turn has settled.
"""
from copy import deepcopy
import json
import sqlite3
import time

from .contracts import Budget, TaskContract, PolicyDenied, TERMINAL, canonical, digest, identifier
from .runtime_config import ConfigConflict

SETTLED=TERMINAL|{'WAITING_INPUT'}
MAX_MESSAGE=16000
HISTORY_BYTES=96000


def schema(store):
    with store.connect() as db:
        db.executescript('''
          CREATE TABLE IF NOT EXISTS task_conversations(
            tenant TEXT, id TEXT, workspace TEXT, project TEXT, principal TEXT,
            revision INTEGER, created REAL, updated REAL, PRIMARY KEY(tenant,id));
          CREATE TABLE IF NOT EXISTS task_conversation_turns(
            tenant TEXT, task_id TEXT, number INTEGER, run_id TEXT, request_id TEXT,
            content TEXT, state TEXT, error TEXT, created REAL,
            PRIMARY KEY(tenant,task_id,number), UNIQUE(tenant,task_id,request_id), UNIQUE(tenant,run_id));
        ''')


def refresh_history(library,access,context):
    context=deepcopy(context);sources={};redacted=[]
    for message in context['messages']:
        valid=True
        for citation in message.get('citations',[]):
            try:
                asset=library.get(access,citation['asset_ref'])
                live=(asset['kind']=='KNOWLEDGE' and asset['status']=='PUBLISHED' and asset['content_hash']==citation['content_hash']
                      and asset['effective_at']<=time.time()<asset['effective_until'])
                if live:sources[asset['ref']]=asset
                else:valid=False
            except (KeyError,ValueError,PolicyDenied):valid=False
        if not valid:
            message['content']='[此前回复的来源已失效，正文未提供给本轮模型。请按当前可用资料重新回答。]'
            message['citations']=[];redacted.append(message['turn'])
    return context,list(sources.values()),redacted


class TaskConversations:
    def __init__(self,app):self.app=app;self.store=app.runtime().store

    def root_id(self,identity):
        identifier(identity)
        with self.store.connect() as db:
            row=db.execute('SELECT task_id FROM task_conversation_turns WHERE tenant=? AND run_id=?',(self.app.tenant,identity)).fetchone()
        return row['task_id'] if row else identity

    def root(self,identity):
        root=self.store.load(self.app.tenant,self.root_id(identity));self.app.assert_run_access(root)
        if root['task']['principal']!=self.app.principal:raise PolicyDenied('task conversation belongs to another principal')
        return root

    def rows(self,root):
        with self.store.connect() as db:
            rows=[dict(r) for r in db.execute('SELECT * FROM task_conversation_turns WHERE tenant=? AND task_id=? ORDER BY number',(self.app.tenant,root['run_id']))]
        return rows or [{'tenant':self.app.tenant,'task_id':root['run_id'],'number':1,'run_id':root['run_id'],
            'request_id':'initial-'+root['run_id'],'content':root['task']['goal'],'state':'RUNNING','error':None,'created':root['created_at']}]

    def register(self,root):
        self.app.assert_run_access(root)
        with self.store.transaction() as db:
            db.execute('INSERT OR IGNORE INTO task_conversations VALUES(?,?,?,?,?,?,?,?)',
                (self.app.tenant,root['run_id'],self.app.workspace['id'],root['task']['project_id'],root['task']['principal'],1,root['created_at'],root['created_at']))
            db.execute('INSERT OR IGNORE INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',
                (self.app.tenant,root['run_id'],1,root['run_id'],'initial-'+root['run_id'],root['task']['goal'],'RUNNING',None,root['created_at']))

    def loaded(self,row):
        try:return self.store.result(self.app.tenant,row['run_id'])
        except KeyError:return None

    def _reply_permission(self,root):
        if root['status']=='WAITING_AUTH' or any(a['status'] in {'DISPATCHED','UNKNOWN','RECONCILING'} for a in self.store.actions(root)):
            raise ConfigConflict('请先处理当前待确认的操作，再继续对话。')
        if not root['snapshot'].get('compiled_agent'):raise ValueError('此历史任务缺少执行配置，请基于它新建任务后继续。')

    def append(self,identity,data):
        if not isinstance(data,dict) or set(data)!={'content','request_id','revision'}:raise ValueError('对话消息需要内容、提交编号和对话版本')
        content=data['content'];request=identifier(data['request_id'])
        if not isinstance(content,str) or not 1<=len(content.strip())<=MAX_MESSAGE:raise ValueError('消息须为 1–16000 字')
        if type(data['revision']) is not int or data['revision']<1:raise ValueError('对话版本无效，请刷新后重试')
        with self.app.lock:
            root=self.root(identity);self._reply_permission(root);self.register(root)
            with self.store.transaction() as db:
                existing=db.execute('SELECT * FROM task_conversation_turns WHERE tenant=? AND task_id=? AND request_id=?',(self.app.tenant,root['run_id'],request)).fetchone()
                if existing:
                    if existing['content']!=content.strip():raise ConfigConflict('此提交编号已用于另一条消息')
                else:
                    thread=db.execute('SELECT * FROM task_conversations WHERE tenant=? AND id=?',(self.app.tenant,root['run_id'])).fetchone()
                    if thread['revision']!=data['revision']:raise ConfigConflict('对话有新消息，请核对更新后的内容再发送')
                    number=db.execute('SELECT MAX(number)+1 FROM task_conversation_turns WHERE tenant=? AND task_id=?',(self.app.tenant,root['run_id'])).fetchone()[0]
                    run_id='turn-'+digest([self.app.tenant,root['run_id'],request])[:32]
                    db.execute('INSERT INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',(self.app.tenant,root['run_id'],number,run_id,request,content.strip(),'QUEUED',None,time.time()))
                    db.execute('UPDATE task_conversations SET revision=revision+1,updated=? WHERE tenant=? AND id=?',(time.time(),self.app.tenant,root['run_id']))
                    self.store.event(db,self.app.tenant,root['run_id'],'conversation.message_added',{'turn':number,'request_id':request})
            self.dispatch(root['run_id'])
            return self.app.detail(root['run_id'])

    def cancel_queued(self,identity,number,data):
        if not isinstance(data,dict) or set(data)!={'revision'} or type(data['revision']) is not int:raise ValueError('请提供当前对话版本')
        with self.app.lock:
            root=self.root(identity);self.register(root)
            rows=self.rows(root);row=next((r for r in rows if r['number']==number),None)
            if row is None:raise KeyError('conversation turn not found')
            if number==1:raise ConfigConflict('首条任务目标不能从对话中移除')
            run=self.loaded(row)
            if row['state']=='CANCELLED':return self.app.detail(root['run_id'])
            if run or row['state']!='QUEUED':raise ConfigConflict('这条消息已开始处理，可以停止当前回复')
            with self.store.transaction() as db:
                thread=db.execute('SELECT revision FROM task_conversations WHERE tenant=? AND id=?',(self.app.tenant,root['run_id'])).fetchone()
                if thread['revision']!=data['revision']:raise ConfigConflict('对话已更新，请重试')
                db.execute("UPDATE task_conversation_turns SET state='CANCELLED' WHERE tenant=? AND task_id=? AND number=?",(self.app.tenant,root['run_id'],number))
                db.execute('UPDATE task_conversations SET revision=revision+1,updated=? WHERE tenant=? AND id=?',(time.time(),self.app.tenant,root['run_id']))
            self.dispatch(root['run_id'])
            return self.app.detail(root['run_id'])

    def history(self,root,rows,before):
        messages=[]
        for row in rows:
            if row['number']>=before:break
            if row['state']=='CANCELLED':continue
            messages.append({'role':'user','content':row['content'],'turn':row['number'],'run_id':row['run_id'],'status':'sent','citations':[]})
            run=self.loaded(row)
            if not run:continue
            report=run.get('report');text='';valid=True
            if report:
                text=report.get('content') or report.get('answer') or canonical(report)
                # Old quotes remain in the visible audit; revoked source text is
                # never silently forwarded to a subsequent model turn.
                if report.get('citations'):
                    try:
                        from .definitions import domain_for
                        checks=domain_for(run['snapshot']).task_checks(run,self.store.evidence(run),store=self.store)
                        valid=all(c['passed'] for c in checks.values())
                    except (KeyError,ValueError,PolicyDenied):valid=False
                    if not valid:text='[此前回复的来源已失效或不可核对，正文未加入本轮上下文。请按当前可用资料重新回答。]'
            elif run['status']=='WAITING_INPUT':text=run.get('last_error') or '请补充任务所需信息。'
            elif run['status'] in TERMINAL:text='[上一轮未完成：'+run['status']+'。'+(run.get('last_error') or '')+']'
            if text:messages.append({'role':'assistant','content':text,'turn':row['number'],'run_id':row['run_id'],'status':run['status'],'citations':report.get('citations',[]) if report and valid else []})
        history_hash=digest(messages);selected=[];size=0
        for message in reversed(messages):
            cost=len(canonical(message).encode())
            if cost+size>HISTORY_BYTES or len(selected)>=200:break
            selected.append(message);size+=cost
        selected.reverse()
        return {'task_id':root['run_id'],'turn':before,'goal':root['task']['goal'],'messages':selected,
                'history_hash':history_hash,'omitted_messages':len(messages)-len(selected)}

    def dispatch(self,identity):
        if self.app.closed:return False
        with self.app.lock:
            root=self.root(identity);rows=self.rows(root)
            for row in rows:
                if row['state'] in {'CANCELLED','ERROR'}:continue
                run=self.loaded(row)
                if run and run['status'] in SETTLED:continue
                if run and run['status']=='WAITING_AUTH':return False
                if run and (self.app.job(run['run_id']) or {}).get('active'):return False
                if run and self.app.lease(run['run_id'])['active']:return False
                if not run:
                    if sum(job.get('active',False) for job in self.app.jobs.values())>=16:return False
                    try:
                        profile=deepcopy(root['snapshot'].get('agent_profile'))
                        if profile:self.app.agents.assert_skills_available(profile)
                        planner=None
                        if root['snapshot'].get('planner'):
                            from .llm import LLMPlanner
                            planner=LLMPlanner.restore(root['snapshot']['planner']);planner.execution_mode='conversation'
                        task=TaskContract(tenant_id=self.app.tenant,principal=root['task']['principal'],project_id=root['task']['project_id'],
                            change_id=root['task']['change_id'],goal=row['content'],domain_pack_ref=root['task']['domain_pack_ref'],
                            agent_ref=root['task']['agent_ref'],budget=Budget(**root['task']['budget']),source_run_id=root['run_id'],
                            workflow_inputs=tuple(root['task'].get('workflow_inputs',[])),retrieval=root['task'].get('retrieval'),
                            execution_mode='conversation',conversation_context=self.history(root,rows,row['number']))
                        runtime=self.app.runtime(planner)
                        try:run=runtime.submit(task,grant=False,agent_profile=profile,run_id=row['run_id'])
                        except sqlite3.IntegrityError:run=self.store.load(self.app.tenant,row['run_id'])
                        lease=self.store.acquire(self.app.tenant,run['run_id'],self.app.lease_seconds)
                        try:
                            runtime.checkpoint(run,lease,'conversation.turn_created',{'task_id':root['run_id'],'turn':row['number']})
                            if planner:runtime.checkpoint(run,lease,'model.sharing_consented',{'source':'task-message','scope':'frozen-agent-and-conversation-history'})
                        finally:self.store.release(run,lease)
                        with self.store.transaction() as db:db.execute("UPDATE task_conversation_turns SET state='RUNNING' WHERE tenant=? AND task_id=? AND number=?",(self.app.tenant,root['run_id'],row['number']))
                    except (ValueError,KeyError,PolicyDenied) as exc:
                        with self.store.transaction() as db:db.execute("UPDATE task_conversation_turns SET state='ERROR',error=? WHERE tenant=? AND task_id=? AND number=?",(str(exc),self.app.tenant,root['run_id'],row['number']))
                        continue
                try:self.app.schedule(row['run_id'])
                except Exception as exc:
                    if getattr(exc,'status',None) in (409,429,503):return False
                    raise
                return True
            return False

    def view(self,identity):
        root=self.root(identity);rows=self.rows(root);turns=[];current=root;calls=tokens=0;active=False;pending=0
        for row in rows:
            run=self.loaded(row);progress=[];status=row['state'];reply=None;preview=None;summary_rows={};resumable=False
            if run:
                current=run;calls+=run.get('model_calls',0);tokens+=run.get('model_tokens',0);status=run['status']
                if status not in SETTLED:active=True
                if status in ('CREATED','RUNNING'):
                    resumable=not (self.app.job(run['run_id']) or {}).get('active') and not self.app.lease(run['run_id'])['active']
                events=self.store.events(self.app.tenant,run['run_id'])
                for event in events:
                    data=event['data']
                    if event['kind'] in ('model.requested','model.output_rejected') and data.get('phase')=='execute':
                        preview=None
                    if event['kind']=='model.progress' and data.get('kind')=='answer_text':
                        preview={'content':data['text'],'attempt':data.get('attempt',1),'seq':event['seq']}
                    elif event['kind']=='model.progress' and data.get('kind')=='summary_text':
                        key=(data.get('attempt',1),data.get('stream_id','summary'))
                        item={'id':event['seq'],'time':event['time'],'kind':'summary','text':data['text'],'streaming':True}
                        if key in summary_rows:progress[summary_rows[key]]=item
                        else:summary_rows[key]=len(progress);progress.append(item)
                    elif event['kind']=='model.progress' and data.get('kind') in {'status','summary','message','tool'}:
                        progress.append({'id':event['seq'],'time':event['time'],'kind':data['kind'],'text':data['text']})
                    elif event['kind']=='execution.summary':progress.append({'id':event['seq'],'time':event['time'],'kind':'summary','text':data['text']})
                    elif event['kind'] in ('native.read_prepared','native.read_verified'):
                        progress.append({'id':event['seq'],'time':event['time'],'kind':'tool','text':'正在读取资料。' if event['kind']=='native.read_prepared' else '资料读取完成。'})
                reply=run.get('report')
                if reply:preview=None
            if row['state']=='CANCELLED':status='CANCELLED';reply=None
            elif not run and row['state']=='QUEUED':pending+=1
            turns.append({'number':row['number'],'run_id':row['run_id'],'content':row['content'],'created_at':row['created'],
                'status':status,'cancelled_queue':row['state']=='CANCELLED','reply':reply,'progress':progress,'preview':preview,'resumable':resumable,
                'error':row.get('error') or (run.get('last_error') if run else None),
                'updated_at':run['updated_at'] if run else row['created'],'model_calls':run.get('model_calls',0) if run else 0})
        with self.store.connect() as db:thread=db.execute('SELECT * FROM task_conversations WHERE tenant=? AND id=?',(self.app.tenant,root['run_id'])).fetchone()
        blocked=None
        try:self._reply_permission(root)
        except (ValueError,ConfigConflict) as exc:blocked=str(exc)
        return {'id':root['run_id'],'goal':root['task']['goal'],'revision':thread['revision'] if thread else 1,
            'created_at':root['created_at'],'updated_at':max([t['updated_at'] for t in turns]+[root['updated_at']]),
            'turns':turns,'active_run_id':current['run_id'],'active':active,'queued_count':pending,
            'resumable':next((t['resumable'] for t in turns if t['run_id']==current['run_id']),False),
            'status':current['status'] if active else 'QUEUED' if pending else 'FAILED' if turns[-1]['status']=='ERROR' else current['status'],'can_reply':blocked is None,'reply_blocked':blocked,
            'agent':{k:v for k,v in root['snapshot'].get('agent_profile',root['snapshot']['agent']['identity']).items() if k in {'id','name','revision'}},'runtime':root['snapshot']['planner_ref'],
            'model':root['snapshot'].get('planner',{}).get('config',{}).get('model'),
            'model_calls':calls,'model_tokens':tokens,'deadline':current['deadline'],'last_error':turns[-1]['error']}

    def summary_state(self,state):
        with self.store.connect() as db:
            exists=db.execute('SELECT 1 FROM task_conversations WHERE tenant=? AND id=?',(self.app.tenant,state['run_id'])).fetchone()
        if not exists:return state
        view=self.view(state['run_id']);result={**state}
        result.update(status=view['status'],updated_at=view['updated_at'],model_calls=view['model_calls'],model_tokens=view['model_tokens'],deadline=view['deadline'],last_error=view['last_error'])
        result['_conversation_active_run']=view['active_run_id']
        return result

    @staticmethod
    def tick(app):
        service=TaskConversations(app)
        with service.store.connect() as db:threads=[dict(r) for r in db.execute('SELECT * FROM task_conversations WHERE tenant=? AND principal=?',(app.tenant,app.principal))]
        for thread in threads:
            if app.closed:break
            try:TaskConversations(app.scoped(thread['workspace'])).dispatch(thread['id'])
            except (KeyError,PolicyDenied):continue
