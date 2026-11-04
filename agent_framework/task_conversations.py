"""Persistent task messages; each model turn has its own immutable execution.

Threads keep a stable task identity. Queued messages survive refresh/restart and
are dispatched in order only after the previous model turn has settled.
"""
from copy import deepcopy
from contextlib import nullcontext
import json
import logging
import sqlite3
import time

from .contracts import Budget, TaskContract, PolicyDenied, TERMINAL, canonical, digest, identifier
from .runtime_config import ConfigConflict
from .workspaces import WorkspaceDeleted, assert_workspace_active
from .store import cancellation_projection
from .conversation_history import HistoryWindow, compact_citations, is_redacted, SOURCE_UNAVAILABLE, SOURCE_UNVERIFIABLE, HISTORY_UNVERIFIABLE


def cancellation_status(status,request):
    if request and request['pending'] and status not in TERMINAL:return 'INTERRUPTED' if request['error'] else 'CANCELLING'
    return status

SETTLED=TERMINAL|{'WAITING_INPUT'}
MAX_MESSAGE=16000
HISTORY_BYTES=96000


def retry_request(number):
    if type(number) is not int or not 1<=number<=9007199254740991:raise ValueError('重试轮次无效')
    # Public message identifiers cannot contain ':'. This namespace belongs to
    # the server, and the existing unique key serializes retries across workers.
    return 'retry:'+str(number)


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
    context=deepcopy(context);sources={};redacted=[];resolved={}
    for message in context['messages']:
        valid=True
        try:
            citations=compact_citations(message.get('citations',[]))
            inherited=compact_citations(message.get('source_dependencies',[]))
            references=compact_citations(citations+inherited)
        except (KeyError,ValueError):citations=[];inherited=[];references=[];valid=False
        for citation in references:
            try:
                ref=citation['asset_ref']
                if ref not in resolved:
                    try:resolved[ref]=library.get(access,ref)
                    except (KeyError,ValueError,PolicyDenied):resolved[ref]=None
                asset=resolved[ref]
                if asset is None:valid=False;continue
                live=(asset['kind']=='KNOWLEDGE' and asset['status']=='PUBLISHED' and asset['content_hash']==citation['content_hash']
                      and asset['effective_at']<=time.time()<asset['effective_until'])
                if live:sources[asset['ref']]=asset
                else:valid=False
            except (KeyError,ValueError,PolicyDenied):valid=False
        if not valid:
            message['content']=SOURCE_UNAVAILABLE
            message['citations']=[];redacted.append(message['turn'])
            if 'source_dependencies' in message:message['source_dependencies']=[]
        else:
            message['citations']=citations
            if 'source_dependencies' in message:message['source_dependencies']=inherited
            if is_redacted(message):redacted.append(message['turn'])
    return context,list(sources.values()),redacted


class TaskConversations:
    def __init__(self,app,store=None):self.app=app;self.store=store or app.runtime().store

    def root_id(self,identity,*,db=None):
        identifier(identity)
        with self.store.read_snapshot(db) as db:
            row=db.execute('SELECT task_id FROM task_conversation_turns WHERE tenant=? AND run_id=?',(self.app.tenant,identity)).fetchone()
        return row['task_id'] if row else identity

    def root(self,identity,*,db=None):
        root=self.store.load(self.app.tenant,self.root_id(identity,db=db),db=db);self.app.assert_run_access(root)
        if root['task']['principal']!=self.app.principal:raise PolicyDenied('task conversation belongs to another principal')
        return root

    def rows(self,root,*,db=None):
        with self.store.read_snapshot(db) as db:
            rows=[dict(r) for r in db.execute('SELECT * FROM task_conversation_turns WHERE tenant=? AND task_id=? ORDER BY number',(self.app.tenant,root['run_id']))]
        return rows or [{'tenant':self.app.tenant,'task_id':root['run_id'],'number':1,'run_id':root['run_id'],
            'request_id':'initial-'+root['run_id'],'content':root['task']['goal'],'state':'RUNNING','error':None,'created':root['created_at']}]

    def register(self,root,*,db=None):
        self.app.assert_run_access(root)
        with (self.store.transaction() if db is None else nullcontext(db)) as connection:
            assert_workspace_active(connection,self.app.tenant,self.app.workspace['id'])
            connection.execute('INSERT OR IGNORE INTO task_conversations VALUES(?,?,?,?,?,?,?,?)',
                (self.app.tenant,root['run_id'],self.app.workspace['id'],root['task']['project_id'],root['task']['principal'],1,root['created_at'],root['created_at']))
            connection.execute('INSERT OR IGNORE INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',
                (self.app.tenant,root['run_id'],1,root['run_id'],'initial-'+root['run_id'],root['task']['goal'],'RUNNING',None,root['created_at']))

    def loaded(self,row,*,db=None):
        try:return self.store.result(self.app.tenant,row['run_id'],db=db)
        except KeyError:return None

    def _reply_permission(self,root,*,db=None):
        with self.store.read_snapshot(db) as db:
            # The caller's root may predate acceptance. Read the gate from the
            # same snapshot/transaction as the message or child being committed.
            gate=db.execute("""SELECT json_extract(state,'$.status') AS status,EXISTS(
                SELECT 1 FROM actions WHERE tenant_id=runs.tenant_id AND run_id=runs.id
                AND json_extract(data,'$.status') IN ('DISPATCHED','UNKNOWN','RECONCILING','NEEDS_REVIEW')) AS uncertain
                FROM runs WHERE tenant_id=? AND id=?""",(self.app.tenant,root['run_id'])).fetchone()
            from .task_cleanup import pending
            cleanup=pending(self.store,self.app.tenant,[root['run_id']],db)[root['run_id']]
        if not gate:raise KeyError('conversation root not found')
        if gate['status']=='WAITING_AUTH' or gate['uncertain']:
            raise ConfigConflict('请先处理当前待确认的操作，再继续对话。')
        if cleanup:raise ConfigConflict('本地模型进程清理未确认，请先检查运行环境并确认继续；排队消息和草稿已保留。')
        if not root['snapshot'].get('compiled_agent'):raise ValueError('此历史任务缺少执行配置，请基于它新建任务后继续。')

    def retry(self,identity,number,data):
        retry_request(number)
        return self.append(identity,data,_retry=number)

    def append(self,identity,data,*,_retry=None):
        fields={'revision'} if _retry is not None else {'content','request_id','revision'}
        if not isinstance(data,dict) or set(data)!=fields:raise ValueError('请提供重试的对话版本' if _retry is not None else '对话消息需要内容、提交编号和对话版本')
        if _retry is None:
            content=data['content'];request=identifier(data['request_id'])
            if not isinstance(content,str) or not 1<=len(content.strip())<=MAX_MESSAGE:raise ValueError('消息须为 1–16000 字')
        else:request=retry_request(_retry)
        if type(data['revision']) is not int or data['revision']<1:raise ValueError('对话版本无效，请刷新后重试')
        with self.app.lock:
            root=self.root(identity)
            with self.store.transaction() as db:
                assert_workspace_active(db,self.app.tenant,self.app.workspace['id'])
                self.register(root,db=db)
                if _retry is not None:
                    source=db.execute('''SELECT t.content,t.state,json_extract(r.state,'$.status') AS run_status
                        FROM task_conversation_turns t LEFT JOIN runs r ON r.tenant_id=t.tenant AND r.id=t.run_id
                        WHERE t.tenant=? AND t.task_id=? AND t.number=?''',(self.app.tenant,root['run_id'],_retry)).fetchone()
                    if not source:raise KeyError('conversation turn not found')
                    content=source['content']
                existing=db.execute('SELECT * FROM task_conversation_turns WHERE tenant=? AND task_id=? AND request_id=?',(self.app.tenant,root['run_id'],request)).fetchone()
                if existing:
                    from .task_message_edits import original_content
                    if original_content(self.store,db,existing)!=content.strip():raise ConfigConflict('此提交编号已用于另一条消息')
                else:
                    if _retry is not None and (source['state']=='CANCELLED' or (source['run_status'] or source['state']) not in {'FAILED','EXPIRED','ERROR'}):
                        raise ConfigConflict('仅未完成或超时的轮次可重试，请核对当前对话')
                    self._reply_permission(root,db=db)
                    thread=db.execute('SELECT * FROM task_conversations WHERE tenant=? AND id=?',(self.app.tenant,root['run_id'])).fetchone()
                    if thread['revision']!=data['revision']:raise ConfigConflict('对话有新消息，请核对更新后的内容再发送')
                    number=db.execute('SELECT MAX(number)+1 FROM task_conversation_turns WHERE tenant=? AND task_id=?',(self.app.tenant,root['run_id'])).fetchone()[0]
                    run_id='turn-'+digest([self.app.tenant,root['run_id'],request])[:32]
                    db.execute('INSERT INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',(self.app.tenant,root['run_id'],number,run_id,request,content.strip(),'QUEUED',None,time.time()))
                    db.execute('UPDATE task_conversations SET revision=revision+1,updated=? WHERE tenant=? AND id=?',(time.time(),self.app.tenant,root['run_id']))
                    self.store.event(db,self.app.tenant,root['run_id'],'conversation.message_added',{'turn':number,'request_id':request,**({'retry_of':_retry} if _retry is not None else {})})
                    from .task_archive import restore_for_message
                    restore_for_message(self.app,self.store,root['run_id'],db)
            self.dispatch(root['run_id'])
            return self.app.detail(root['run_id'])

    def message_submission(self,identity,request):
        """Read an accepted message without registering or advancing a turn."""
        identifier(request)
        return self._message_submission(identity,request)

    def retry_submission(self,identity,number):
        return self._message_submission(identity,retry_request(number))

    def _message_submission(self,identity,request):
        with self.store.read_snapshot() as db:
            root=self.root(identity,db=db)
            row=db.execute('SELECT * FROM task_conversation_turns WHERE tenant=? AND task_id=? AND request_id=? AND number>1',
                           (self.app.tenant,root['run_id'],request)).fetchone()
            if not row:raise KeyError('message submission not found')
            from .task_message_edits import original_content
            receipt={'task_id':root['run_id'],'request_id':request,'content':original_content(self.store,db,row),
                     'turn':row['number'],'run_id':row['run_id'],'accepted_at':row['created']}
            return {'submission':receipt,'detail':self.app.detail(root['run_id'],db=db)}

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
                current=db.execute('''SELECT t.state,r.id AS materialized FROM task_conversation_turns t
                    LEFT JOIN runs r ON r.tenant_id=t.tenant AND r.id=t.run_id
                    WHERE t.tenant=? AND t.task_id=? AND t.number=?''',(self.app.tenant,root['run_id'],number)).fetchone()
                if not current:raise KeyError('conversation turn not found')
                if current['state']!='CANCELLED':
                    if current['materialized'] or current['state']!='QUEUED':raise ConfigConflict('这条消息已开始处理，可以停止当前回复')
                    thread=db.execute('SELECT revision FROM task_conversations WHERE tenant=? AND id=?',(self.app.tenant,root['run_id'])).fetchone()
                    if thread['revision']!=data['revision']:raise ConfigConflict('对话已更新，请重试')
                    db.execute("UPDATE task_conversation_turns SET state='CANCELLED' WHERE tenant=? AND task_id=? AND number=?",(self.app.tenant,root['run_id'],number))
                    db.execute('UPDATE task_conversations SET revision=revision+1,updated=? WHERE tenant=? AND id=?',(time.time(),self.app.tenant,root['run_id']))
            self.dispatch(root['run_id'])
            return self.app.detail(root['run_id'])

    def history(self,root,rows,before):
        eligible=[]
        for row in rows:
            if row['number']>=before:break
            if row['state']=='CANCELLED':continue
            eligible.append(row)
        window=HistoryWindow(HISTORY_BYTES);history_lineage={}
        with self.store.read_snapshot() as db:
            for offset in range(0,len(eligible),200):
                batch=eligible[offset:offset+200];states=self._turn_states(root,batch,db)
                from .history_dependencies import dependencies
                lineage=dependencies(self.store,db,self.app.tenant,self.app.principal,root['task']['project_id'],list(states),prior=history_lineage)
                history_lineage.update(lineage)
                for row in batch:
                    window.append({'role':'user','content':row['content'],'turn':row['number'],'run_id':row['run_id'],'status':'sent','citations':[]})
                    run=states.get(row['run_id'])
                    if not run:continue
                    report=run.get('report');text='';valid=True;citations=[]
                    if report:
                        text=report.get('content') or report.get('answer') or canonical(report)
                        # Cited reports still use their full frozen execution
                        # and evidence for verification, from this same snapshot.
                        if report.get('citations'):
                            try:
                                from .definitions import domain_for
                                original=self.loaded(row,db=db)
                                checks=domain_for(original['snapshot']).task_checks(original,self.store.evidence(original,db=db),store=self.store)
                                valid=all(c['passed'] for c in checks.values())
                                if valid:citations=compact_citations(report['citations'])
                            except (KeyError,ValueError,PolicyDenied):valid=False
                            if not valid:text=SOURCE_UNVERIFIABLE
                    elif run['status']=='WAITING_INPUT':text=run.get('last_error') or '请补充任务所需信息。'
                    elif run['status'] in TERMINAL:text='[上一轮未完成：'+run['status']+'。'+(run.get('last_error') or '')+']'
                    inherited=lineage.get(row['run_id'],{'valid':True,'sources':[]})
                    if text and not inherited['valid']:
                        valid=False;text=HISTORY_UNVERIFIABLE
                    if text:
                        message={'role':'assistant','content':text,'turn':row['number'],'run_id':row['run_id'],'status':run['status'],'citations':citations if valid else []}
                        if valid and inherited['sources']:message['source_dependencies']=inherited['sources']
                        window.append(message)
        return {'task_id':root['run_id'],'turn':before,'goal':root['task']['goal'],**window.result()}

    def dispatch(self,identity):
        if self.app.closed:return False
        with self.app.lock:
            root=self.root(identity)
            with self.store.connect() as db:
                rows=[dict(r) for r in db.execute('''SELECT t.*,json_extract(r.state,'$.status') AS run_status,
                    json_extract(r.state,'$.interruption') AS interruption,r.owner,r.lease_until,
                    (stop_request.run_id IS NOT NULL AND stop_request.completed_at IS NULL) AS cancel_pending
                    FROM task_conversation_turns t LEFT JOIN runs r
                    ON r.tenant_id=t.tenant AND r.id=t.run_id
                    LEFT JOIN run_cancellations stop_request ON stop_request.tenant_id=t.tenant AND stop_request.run_id=t.run_id
                    WHERE t.tenant=? AND t.task_id=? ORDER BY t.number''',(self.app.tenant,root['run_id']))]
            if not rows:
                rows=[{**row,'run_status':root['status'],'interruption':root.get('interruption'),'cancel_pending':False,'owner':None,'lease_until':0} for row in self.rows(root)]
            for row in rows:
                if row['state'] in {'CANCELLED','ERROR'}:continue
                status=row['run_status']
                if row['cancel_pending'] and status not in TERMINAL:return False
                if status in SETTLED:continue
                if row['interruption']:return False
                if status=='WAITING_AUTH':return False
                if status and (self.app.job(row['run_id']) or {}).get('active'):return False
                if status and row['owner'] and row['lease_until']>time.time():return False
                # Recovery of the original run must still be able to reconcile
                # its own write. Only subsequent turns wait for this gate.
                if row['number']>1:
                    try:self._reply_permission(root)
                    except (ConfigConflict,ValueError):return False
                if status is None:
                    if not self.app.has_job_capacity():return False
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
                        def accept_turn(db,run):
                            self._reply_permission(root,db=db)
                            current=db.execute('SELECT state,content FROM task_conversation_turns WHERE tenant=? AND task_id=? AND number=? AND run_id=?',
                                (self.app.tenant,root['run_id'],row['number'],run['run_id'])).fetchone()
                            if not current or current['state']!='QUEUED' or current['content']!=row['content']:raise ConfigConflict('这条消息已被修改、取消或开始处理')
                            self.store.event(db,self.app.tenant,run['run_id'],'conversation.turn_created',{'task_id':root['run_id'],'turn':row['number']})
                            if planner:self.store.event(db,self.app.tenant,run['run_id'],'model.sharing_consented',{'source':'task-message','scope':'frozen-agent-and-conversation-history'})
                            db.execute("UPDATE task_conversation_turns SET state='RUNNING' WHERE tenant=? AND task_id=? AND number=?",(self.app.tenant,root['run_id'],row['number']))
                        try:run=runtime.submit(task,grant=False,agent_profile=profile,run_id=row['run_id'],on_created=accept_turn)
                        except sqlite3.IntegrityError:run=self.store.load(self.app.tenant,row['run_id'])
                    except ConfigConflict:return False
                    except (ValueError,KeyError,PolicyDenied) as exc:
                        with self.store.transaction() as db:db.execute("""UPDATE task_conversation_turns SET state='ERROR',error=?
                            WHERE tenant=? AND task_id=? AND number=? AND content=? AND state='QUEUED' AND NOT EXISTS(
                                SELECT 1 FROM runs r WHERE r.tenant_id=task_conversation_turns.tenant AND r.id=task_conversation_turns.run_id)""",
                            (str(exc),self.app.tenant,root['run_id'],row['number'],row['content']))
                        continue
                try:self.app.schedule(row['run_id'],automatic=True)
                except Exception as exc:
                    if getattr(exc,'status',None) in (409,429,503):return False
                    raise
                return True
            return False

    def view(self,identity,*,db=None,live=True,jobs=None):
        if live and jobs is None:jobs=self.app.observe_jobs()
        with self.store.read_snapshot(db) as db:return self._view(identity,db,live=live,jobs=jobs)

    def export(self,identity):
        with self.store.read_snapshot() as db:
            captured=time.time();view=self._view(identity,db,live=False)
            return {**view,'export_snapshot':{'captured_at':captured,'revision':view['revision']}}

    def _turn_states(self,root,rows,db):
        from .conversation_projection import turn_states
        return turn_states(db,self.app.tenant,self.app.principal,root['task']['project_id'],[row['run_id'] for row in rows],
                           cancellations=self.store._optional_table_available(db,'run_cancellations'))

    def _turn_progress(self,states,db):
        from .conversation_projection import progress_events
        return progress_events(db,self.app.tenant,states)

    def _view(self,identity,db,*,live=True,jobs=None):
        root=self.root(identity,db=db);rows=self.rows(root,db=db);turns=[];current=root;calls=tokens=0;active=False;pending=0
        retries={int(row['request_id'][6:]):row['number'] for row in rows if row['request_id'].startswith('retry:') and row['request_id'][6:].isdigit()}
        origins={number:source for source,number in retries.items()}
        states=self._turn_states(root,rows,db);public=self._turn_progress(states,db)
        from .task_message_edits import metadata
        edits=metadata(self.store,db,self.app.tenant,root['run_id'])
        for row in rows:
            run=states.get(row['run_id']);progress=[];status=row['state'];reply=None;preview=None;resumable=False
            if run:
                current=run;calls+=run.get('model_calls',0);tokens+=run.get('model_tokens',0);status=run['status']
                if status not in SETTLED:active=True
                if live and status in ('CREATED','RUNNING','RECONCILING','VERIFYING'):
                    resumable=not (run.get('cancellation') or {}).get('pending') and not (self.app.job(run['run_id'],db=db,observed=jobs) or {}).get('active') and not (run['_lease_owner'] and run['_lease_until']>time.time())
                progress=public[run['run_id']]['progress'];preview=public[run['run_id']]['preview']
                reply=run.get('report')
                if reply:preview=None
            if row['state']=='CANCELLED':status='CANCELLED';reply=None
            elif not run and row['state']=='QUEUED':pending+=1
            turns.append({**edits.get(row['number'],{'edit_revision':0,'edited_at':None}),'number':row['number'],'run_id':row['run_id'],'content':row['content'],'created_at':row['created'],
                'retry_of':origins.get(row['number']),'retried_by':retries.get(row['number']),
                'checkpoint_version':run['version'] if run else None,'event_seq':run['_event_seq'] if run else 0,'dispatch_state':row['state'],
                'status':status,'cancelled_queue':row['state']=='CANCELLED','reply':reply,'progress':progress,'preview':preview,'resumable':resumable,
                'interruption':run.get('interruption') if run else None,
                'cancellation':run.get('cancellation') if run else None,
                'error':row.get('error') or ((run.get('cancellation') or {}).get('error') or (run.get('interruption') or {}).get('message') or run.get('last_error') if run else None),
                'updated_at':max(run['updated_at'],(run.get('cancellation') or {}).get('updated_at',0)) if run else row['created'],'model_calls':run.get('model_calls',0) if run else 0})
        thread=db.execute('SELECT * FROM task_conversations WHERE tenant=? AND id=?',(self.app.tenant,root['run_id'])).fetchone()
        blocked=None
        try:self._reply_permission(root,db=db)
        except (ValueError,ConfigConflict) as exc:blocked=str(exc)
        from .task_archive import read as read_archive
        from .task_names import read as read_name
        from .task_cleanup import pending as cleanup_pending
        cleanup=cleanup_pending(self.store,self.app.tenant,[root['run_id']],db)[root['run_id']]
        view={'task_name':read_name(self.app,self.store,root['run_id'],db),'archive':read_archive(self.app,self.store,root['run_id'],db),'snapshot_format':1,'id':root['run_id'],'goal':root['task']['goal'],'revision':thread['revision'] if thread else 1,
            'created_at':root['created_at'],'updated_at':max([t['updated_at'] for t in turns]+[root['updated_at'],thread['updated'] if thread else root['updated_at']]),
            'turns':turns,'active_run_id':current['run_id'],'active':active,'queued_count':pending,'cleanup_review':cleanup,
            'resumable':next((t['resumable'] for t in turns if t['run_id']==current['run_id']),False),'interruption':current.get('interruption'),
            'status':cancellation_status('INTERRUPTED' if current.get('interruption') else current['status'] if active or current['status']=='NEEDS_REVIEW' else 'NEEDS_REVIEW' if cleanup else 'QUEUED' if pending else 'FAILED' if turns[-1]['status']=='ERROR' else current['status'],current.get('cancellation')),'cancellation':current.get('cancellation'),'can_reply':blocked is None,'reply_blocked':blocked,
            'agent':{k:v for k,v in root['snapshot'].get('agent_profile',root['snapshot']['agent']['identity']).items() if k in {'id','name','revision'}},'runtime':root['snapshot']['planner_ref'],
            'model':root['snapshot'].get('planner',{}).get('config',{}).get('model'),
            'model_calls':calls,'model_tokens':tokens,'deadline':current['deadline'],'last_error':turns[-1]['error']}
        if live:view['current']={'job':self.app.job(current['run_id'],db=db,observed=jobs)}
        return view

    def summary_state(self,state):
        return self.summary_states([state])[0]

    def summary_states(self,states,*,db=None):
        """Aggregate current headers without fetching replies, actions or events."""
        roots={state['run_id']:state for state in states};groups={}
        identities=list(roots)
        with self.store.read_snapshot(db) as db:
            from .task_cleanup import pending as cleanup_pending
            cleanup=cleanup_pending(self.store,self.app.tenant,identities,db)
            for offset in range(0,len(identities),400):
                batch=identities[offset:offset+400]
                rows=db.execute('''SELECT c.id,c.workspace,c.project,c.principal,c.updated AS thread_updated,t.number,t.run_id,
                    t.state AS turn_state,t.error,t.created,
                    json_extract(r.state,'$.status','$.updated_at','$.created_at','$.deadline',
                        '$.model_calls','$.model_tokens','$.last_error','$.task.principal','$.task.project_id','$.interruption') AS fields,
                    '''+cancellation_projection()+''' AS cancellation
                    FROM task_conversations c LEFT JOIN task_conversation_turns t ON t.tenant=c.tenant AND t.task_id=c.id
                    LEFT JOIN runs r ON r.tenant_id=t.tenant AND r.id=t.run_id
                    LEFT JOIN run_cancellations stop_request ON stop_request.tenant_id=t.tenant AND stop_request.run_id=t.run_id
                    WHERE c.tenant=? AND c.id IN (''' + ','.join('?' for _ in batch) + ''')
                    ORDER BY c.id,t.number''',(self.app.tenant,*batch)).fetchall()
                for row in rows:
                    if row['workspace']!=self.app.workspace['id'] or row['principal']!=self.app.principal:
                        raise PolicyDenied('task conversation belongs to another scope')
                    root=roots[row['id']]
                    if row['project']!=root['task']['project_id']:raise PolicyDenied('task conversation project mismatch')
                    group=groups.setdefault(row['id'],{'current':root,'calls':0,'tokens':0,'active':False,'queued':0,
                        'updated':max(root.get('updated_at',root['created_at']),row['thread_updated']),'last_status':root['status'],'error':root.get('last_error'),'rows':0})
                    if row['number'] is None:continue
                    group['rows']+=1;loaded=json.loads(row['fields']) if row['fields'] else None
                    if loaded:
                        cancellation=json.loads(row['cancellation']) if row['cancellation'] else None
                        status,updated,created,deadline,calls,tokens,error,principal,project,interruption=loaded
                        error=(interruption or {}).get('message') or error
                        if principal!=row['principal'] or project!=row['project']:
                            raise PolicyDenied('conversation turn outside scope')
                        group['current']={'run_id':row['run_id'],'status':status,'deadline':deadline,'interruption':interruption,'cancellation':cancellation}
                        group['calls']+=calls or 0;group['tokens']+=tokens or 0
                        group['active']=group['active'] or status not in SETTLED
                        group['updated']=max(group['updated'],updated if updated is not None else created)
                        if cancellation:group['updated']=max(group['updated'],cancellation['updated_at'])
                    else:
                        status=row['turn_state'];error=None
                        group['updated']=max(group['updated'],row['created'])
                    if row['turn_state']=='CANCELLED':status='CANCELLED'
                    elif not loaded and row['turn_state']=='QUEUED':group['queued']+=1
                    group['last_status']=status;group['error']=row['error'] or error
        result=[]
        for state in states:
            group=groups.get(state['run_id'])
            if not group or not group['rows']:
                status='INTERRUPTED' if state.get('interruption') else 'NEEDS_REVIEW' if cleanup[state['run_id']] and state['status'] in SETTLED else state['status']
                result.append({**state,'status':cancellation_status(status,state.get('cancellation'))});continue
            current=group['current'];status=('INTERRUPTED' if current.get('interruption') else current['status'] if group['active'] or current['status']=='NEEDS_REVIEW' else 'NEEDS_REVIEW' if cleanup[state['run_id']] else 'QUEUED' if group['queued']
                                            else 'FAILED' if group['last_status']=='ERROR' else current['status'])
            result.append({**state,'status':cancellation_status(status,current.get('cancellation')),'cancellation':current.get('cancellation'),'updated_at':group['updated'],'model_calls':group['calls'],
                           'model_tokens':group['tokens'],'deadline':current['deadline'],'last_error':group['error'],
                           '_conversation_active_run':current['run_id'],'interruption':current.get('interruption')})
        return result

    @staticmethod
    def tick(app):
        service=TaskConversations(app)
        settled=sorted(SETTLED|{'WAITING_AUTH'})
        with service.store.connect() as db:
            threads=[dict(r) for r in db.execute('''SELECT c.* FROM task_conversations c
                WHERE c.tenant=? AND c.principal=? AND NOT EXISTS(
                    SELECT 1 FROM task_conversation_turns stopped JOIN runs active_run
                    ON active_run.tenant_id=stopped.tenant AND active_run.id=stopped.run_id
                    JOIN run_cancellations pending_stop ON pending_stop.tenant_id=stopped.tenant AND pending_stop.run_id=stopped.run_id
                    WHERE stopped.tenant=c.tenant AND stopped.task_id=c.id AND pending_stop.completed_at IS NULL
                    AND json_extract(active_run.state,'$.status') NOT IN ('SUCCEEDED','FAILED','NEEDS_REVIEW','EXPIRED','CANCELLED')) AND EXISTS(
                    SELECT 1 FROM task_conversation_turns t LEFT JOIN runs r ON r.tenant_id=t.tenant AND r.id=t.run_id
                    WHERE t.tenant=c.tenant AND t.task_id=c.id AND t.state NOT IN ('CANCELLED','ERROR')
                    AND (r.id IS NULL OR (json_extract(r.state,'$.interruption') IS NULL
                         AND json_extract(r.state,'$.status') NOT IN ('''+','.join('?' for _ in settled)+'''))))
                ''',(app.tenant,app.principal,*settled))]
        for thread in threads:
            if app.closed:break
            try:TaskConversations(app.scoped(thread['workspace'])).dispatch(thread['id'])
            except WorkspaceDeleted as exc:
                if (exc.tenant,exc.workspace_id)!=(app.tenant,thread['workspace']):
                    logging.getLogger(__name__).exception('Conversation recovery failed for %s',thread['id'])
            except PolicyDenied:continue
            except Exception:logging.getLogger(__name__).exception('Conversation recovery failed for %s',thread['id'])
