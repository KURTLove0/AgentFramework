"""Reviewed task permission changes and durable authorization dispatch."""
import json
import logging
import time

from .contracts import TERMINAL,canonical,digest,identifier
from .runtime_config import ConfigConflict
from .workspaces import WorkspaceDeleted


class TaskPermissions:
    def __init__(self,app):self.app=app;self.store=app.control_store

    @property
    def scope(self):return [self.app.tenant,self.app.workspace['id'],self.app.principal]

    @staticmethod
    def pending(state):
        return next((a for a in state['actions'] if a['status']=='PREPARED' and a['tool_ref']=='report.draft.create@1.0.0'),None)

    def token(self,state,action,grant):
        pending=self.pending(state) if action=='grant' else None
        return digest({'scope':self.scope,'run':state['run_id'],'snapshot':state['snapshot']['hash'],'action':action,
                       'grant':grant,'expired':bool(grant and grant['expires_at']<=time.time()),
                       'proposal':{key:pending[key] for key in ('logical_id','tool_ref','args','args_hash','resource')} if pending else None})

    def request(self,run_id,*,db=None):
        with self.store.read_snapshot(db) as db:
            row=db.execute('SELECT * FROM run_permission_dispatches WHERE tenant=? AND workspace=? AND principal=? AND run_id=?',(*self.scope,run_id)).fetchone()
        return dict(row) if row else None

    def view(self,state,*,db=None):
        with self.store.read_snapshot(db) as db:
            grant=self.store.get_grant(state,db=db);request=self.request(state['run_id'],db=db)
        if state['status'] in TERMINAL:request=None
        return {'grant_token':self.token(state,'grant',grant) if self.pending(state) else None,
                'revoke_token':self.token(state,'revoke',grant) if grant else None,
                'authorized':bool(grant and not grant['revoked'] and grant['expires_at']>time.time() and self.pending(state) and grant['args_hash']==self.pending(state)['args_hash']),
                'request':{'state':'ERROR' if request['error'] else 'QUEUED','requested_at':request['requested'],'error':request['error']} if request else None}

    def change(self,run_id,action,proof):
        identifier(run_id)
        if action not in ('grant','revoke'):raise ValueError('不支持的授权操作')
        if not isinstance(proof,str) or len(proof)!=64 or any(c not in '0123456789abcdef' for c in proof):raise ValueError('请重新读取并审查当前授权内容')
        with self.store.transaction() as db:
            state=self.store.result(self.app.tenant,run_id,db=db);self.app.assert_run_access(state)
            prior=db.execute("SELECT data FROM events WHERE tenant_id=? AND run_id=? AND kind='task.permission_accepted' AND json_extract(data,'$.proof')=? AND json_extract(data,'$.action')=? AND json_extract(data,'$.scope')=? ORDER BY seq DESC LIMIT 1",
                             (self.app.tenant,run_id,proof,action,canonical(self.scope))).fetchone()
            if prior:return {**json.loads(prior['data']),'replayed':True}
            if state['status'] in TERMINAL:raise ConfigConflict('运行已结束，不能修改授权')
            grant=self.store.get_grant(state,db=db)
            if self.token(state,action,grant)!=proof:raise ConfigConflict('提案或授权状态已变化，请重新核对并审查；未采用新的内容')
            if action=='grant':
                if (state.get('cancellation') or {}).get('pending'):raise ConfigConflict('任务正在停止，不能新增授权')
                pending=self.pending(state)
                if state['status']!='WAITING_AUTH' or not pending:raise ConfigConflict('当前没有等待授权的具体提案')
                if pending['args_hash']!=digest(pending['args']):raise ConfigConflict('提案内容与摘要不一致，不能授权')
                if state['snapshot'].get('compiled_agent') and state['task']['principal']==self.app.principal:
                    from .task_conversations import TaskConversations
                    if TaskConversations(self.app).view(run_id,db=db,live=False)['active_run_id']!=run_id:raise ConfigConflict('任务已进入另一轮，请重新核对当前执行')
                reusable=grant and not grant['revoked'] and grant['expires_at']>time.time() and grant['args_hash']==pending['args_hash']
                if not reusable:self.store.grant(state,pending['args_hash'],db=db)
                db.execute('INSERT OR REPLACE INTO run_permission_dispatches VALUES(?,?,?,?,?,?,?,?,NULL)',
                           (*self.scope,run_id,proof,pending['logical_id'],pending['args_hash'],time.time()))
            else:
                if not grant:raise ConfigConflict('当前没有可撤销的授权')
                if not grant['revoked']:self.store.grant(state,grant['args_hash'],revoke=True,db=db)
                db.execute('DELETE FROM run_permission_dispatches WHERE tenant=? AND run_id=?',(self.app.tenant,run_id))
            receipt={'scope':self.scope,'run_id':run_id,'action':action,'proof':proof,'accepted_at':time.time()}
            self.store.event(db,self.app.tenant,run_id,'task.permission_accepted',receipt)
        return {**receipt,'replayed':False}

    def _remove(self,request):
        with self.store.transaction() as db:db.execute('DELETE FROM run_permission_dispatches WHERE tenant=? AND run_id=? AND proof=?',(self.app.tenant,request['run_id'],request['proof']))

    def settle(self,run_id):
        request=self.request(run_id)
        if not request:return False
        state=self.store.result(self.app.tenant,run_id);grant=self.store.get_grant(state);pending=self.pending(state)
        if state['status'] in TERMINAL|{'WAITING_INPUT','PAUSED'} or (state.get('cancellation') or {}).get('pending') or not grant or grant['revoked'] or grant['expires_at']<=time.time() or state['status']=='WAITING_AUTH' and (not pending or pending['logical_id']!=request['logical_id'] or pending['args_hash']!=request['args_hash']):
            self._remove(request);return True
        interruption=state.get('interruption')
        if interruption and interruption['at']>=request['requested']:
            with self.store.transaction() as db:
                db.execute('UPDATE run_permission_dispatches SET error=COALESCE(error,?) WHERE tenant=? AND run_id=? AND proof=? AND requested=?',('授权已保存，但本次执行已中断。请检查后重试继续执行。',self.app.tenant,run_id,request['proof'],request['requested']))
        return False

    def dispatch(self,run_id,*,proof=None,retry=False):
        request=self.request(run_id)
        if not request or proof is not None and proof!=request['proof']:return False
        if request['error'] and not retry:return False
        if not retry:
            self.settle(run_id);request=self.request(run_id)
            if not request or request['error']:return False
        if retry:
            # An explicit retry supersedes the old interruption even if capacity
            # is still unavailable; it does not renew the permission itself.
            with self.store.transaction() as db:db.execute('UPDATE run_permission_dispatches SET error=NULL,requested=? WHERE tenant=? AND run_id=? AND proof=?',(time.time(),self.app.tenant,run_id,request['proof']))
        state=self.store.result(self.app.tenant,run_id);self.app.assert_run_access(state)
        grant=self.store.get_grant(state);pending=self.pending(state)
        if state['status'] in TERMINAL or (state.get('cancellation') or {}).get('pending') or not grant or grant['revoked'] or grant['expires_at']<=time.time():
            self._remove(request);return False
        if state['status']=='WAITING_AUTH' and (not pending or pending['logical_id']!=request['logical_id'] or pending['args_hash']!=request['args_hash']):
            self._remove(request);return False
        if self.app.closed or (self.app.job(run_id) or {}).get('active') or self.app.lease(run_id)['active']:return False
        try:self.app.schedule(run_id)
        except Exception as exc:
            if getattr(exc,'status',None) in (409,429,503):return False
            with self.store.transaction() as db:
                db.execute('UPDATE run_permission_dispatches SET error=? WHERE tenant=? AND run_id=? AND proof=?',('授权已保存，但任务未能进入执行队列。请重试继续执行。',self.app.tenant,run_id,request['proof']))
            return False
        # Keep the intent until worker progress settles it. A process can stop
        # after queue handoff but before its worker starts or acquires a lease.
        return True

    @classmethod
    def tick(cls,app):
        with app.control_store.connect() as db:
            rows=db.execute('SELECT run_id,workspace,proof FROM run_permission_dispatches WHERE tenant=? AND principal=? AND error IS NULL ORDER BY requested LIMIT 64',(app.tenant,app.principal)).fetchall()
        for row in rows:
            if app.closed:return
            try:cls(app.scoped(row['workspace'])).dispatch(row['run_id'])
            except WorkspaceDeleted:
                with app.control_store.transaction() as db:
                    db.execute('UPDATE run_permission_dispatches SET error=? WHERE tenant=? AND run_id=? AND proof=?',('所属工作空间已不可用，未继续执行。',app.tenant,row['run_id'],row['proof']))
            except Exception:logging.getLogger(__name__).exception('Accepted task authorization dispatch failed')
