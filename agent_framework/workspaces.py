"""Versioned business workspaces. Deletion is reversible and never rewrites runs."""
import json
import time
from uuid import uuid4

from .contracts import canonical, identifier, TERMINAL, digest
from .runtime_config import ConfigConflict

DEFAULT_WORKSPACE = 'workspace-default'


class WorkspaceDeleted(KeyError):
    """A verified soft deletion, distinct from missing or corrupt workspace data."""
    def __init__(self, tenant, identity):
        super().__init__('workspace unavailable')
        self.tenant, self.workspace_id = tenant, identity


def assert_workspace_active(db, tenant, identity):
    """Check inside the caller's write transaction to fence a concurrent deletion."""
    row = db.execute('SELECT deleted FROM workspaces WHERE tenant=? AND id=?', (tenant, identity)).fetchone()
    if not row:raise KeyError('workspace unavailable')
    if row['deleted']:raise WorkspaceDeleted(tenant, identity)


class WorkspaceRegistry:
    def __init__(self, store, tenant):
        self.store, self.tenant = store, tenant
        with store.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS workspaces (
                tenant TEXT, id TEXT, revision INTEGER, data TEXT, project TEXT,
                deleted INTEGER, created REAL, updated REAL, PRIMARY KEY(tenant,id), UNIQUE(tenant,project))''')
            now=time.time()
            db.execute('INSERT OR IGNORE INTO workspaces VALUES(?,?,?,?,?,0,?,?)',
                       (tenant,DEFAULT_WORKSPACE,1,canonical({'name':'默认工作空间','business':'待配置','scenario':'待配置','description':'请编辑业务与场景，或创建新的工作空间。'}),'project-demo',now,now))
            # Project only the distinct, unregistered identifiers. A historical
            # task can contain large frozen resources and reports; discovery
            # must not deserialize them or attempt one INSERT per run.
            projects=db.execute('''WITH projects AS (
                SELECT DISTINCT json_extract(state,'$.task.project_id') AS project
                FROM runs WHERE tenant_id=?)
                SELECT p.project FROM projects p WHERE NOT EXISTS (
                    SELECT 1 FROM workspaces w WHERE w.tenant=? AND w.project=p.project)
                ORDER BY p.project''',(tenant,tenant)).fetchall()
            for row in projects:
                try:project=identifier(row['project'])
                except ValueError:raise ValueError('历史任务包含无效的项目标识，无法登记工作空间') from None
                db.execute('INSERT OR IGNORE INTO workspaces VALUES(?,?,?,?,?,0,?,?)',
                           (tenant,'workspace-legacy-'+digest(project)[:16],1,canonical({'name':project,'business':'历史项目','scenario':'历史任务','description':'自动登记的历史项目空间。'}),project,now,now))

    @staticmethod
    def _row(row):
        return {**json.loads(row['data']),'id':row['id'],'revision':row['revision'],'project_id':row['project'],
                'deleted':bool(row['deleted']),'created_at':row['created'],'updated_at':row['updated']}

    def list(self):
        with self.store.connect() as db:
            return [self._row(r) for r in db.execute('SELECT * FROM workspaces WHERE tenant=? ORDER BY created,id',(self.tenant,))]

    def get(self, identity, include_deleted=False):
        identifier(identity)
        with self.store.connect() as db:row=db.execute('SELECT * FROM workspaces WHERE tenant=? AND id=?',(self.tenant,identity)).fetchone()
        if not row:raise KeyError('workspace unavailable')
        if row['deleted'] and not include_deleted:raise WorkspaceDeleted(self.tenant, identity)
        return self._row(row)

    def save(self, data, identity=None):
        from .agents import text
        if not isinstance(data,dict) or set(data)!={'name','business','scenario','description','revision'}:raise ValueError('工作空间字段不完整或含未知字段')
        body={k:text(data[k],'工作空间'+k,n,empty=k=='description') for k,n in [('name',80),('business',120),('scenario',200),('description',1000)]}
        revision=data['revision']
        if type(revision) is not int or revision<0:raise ValueError('工作空间版本无效')
        if identity is None:
            if revision!=0:raise ConfigConflict('新工作空间版本应为 0')
            identity='workspace-'+uuid4().hex[:16];project='project-'+uuid4().hex[:16]
        else:
            old=self.get(identity);project=old['project_id']
        now=time.time()
        with self.store.transaction() as db:
            row=db.execute('SELECT * FROM workspaces WHERE tenant=? AND id=?',(self.tenant,identity)).fetchone()
            if (row['revision'] if row else 0)!=revision or (row and row['deleted']):raise ConfigConflict('工作空间已更新，请重新加载')
            if db.execute('SELECT 1 FROM workspaces WHERE tenant=? AND deleted=0 AND id!=? AND json_extract(data,\'$.name\')=?',(self.tenant,identity,body['name'])).fetchone():raise ValueError('已有同名工作空间')
            db.execute('INSERT OR REPLACE INTO workspaces VALUES(?,?,?,?,?,0,?,?)',(self.tenant,identity,revision+1,canonical(body),project,row['created'] if row else now,now))
            return self._row(db.execute('SELECT * FROM workspaces WHERE tenant=? AND id=?',(self.tenant,identity)).fetchone())

    def _deletion_check(self, db, row):
        blockers=[]
        def block(kind, count, message):
            if count:blockers.append({'kind':kind,'count':count,'message':message})
        if row['deleted']:
            block('deleted',1,'此空间已删除，可以在已删除的空间中恢复')
        elif db.execute('SELECT COUNT(*) FROM workspaces WHERE tenant=? AND deleted=0',(self.tenant,)).fetchone()[0]<=1:
            block('last_workspace',1,'至少保留一个可用工作空间')
        tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        placeholders=','.join('?' for _ in TERMINAL)
        # A reply creates a new immutable run. Its predecessor may retain
        # WAITING_INPUT forever; only the latest unanswered question is pending.
        superseded='0'
        if {'task_conversations','task_conversation_turns'}<=tables:
            superseded='''EXISTS(SELECT 1 FROM task_conversation_turns t
                JOIN task_conversations c ON c.tenant=t.tenant AND c.id=t.task_id
                WHERE t.tenant=r.tenant_id AND t.run_id=r.id AND c.workspace=? AND c.project=?
                AND EXISTS(SELECT 1 FROM task_conversation_turns later
                    WHERE later.tenant=t.tenant AND later.task_id=t.task_id
                    AND later.number>t.number AND later.state!='CANCELLED'))'''
        args=[self.tenant,row['project'],*sorted(TERMINAL)]
        if superseded!='0':args.extend([row['id'],row['project']])
        args.append(time.time())
        pending=db.execute(f'''SELECT COUNT(*) FROM runs r WHERE r.tenant_id=?
            AND json_extract(r.state,'$.task.project_id')=? AND (
                (json_extract(r.state,'$.status') NOT IN ({placeholders})
                 AND NOT(json_extract(r.state,'$.status')='WAITING_INPUT' AND {superseded}))
                OR (r.owner IS NOT NULL AND r.lease_until>?))''',args).fetchone()[0]
        block('tasks',pending,f'有 {pending} 项未完成任务执行，请先完成或取消后再删除')
        if {'task_conversations','task_conversation_turns'}<=tables:
            queued=db.execute('''SELECT COUNT(*) FROM task_conversation_turns t
                JOIN task_conversations c ON c.tenant=t.tenant AND c.id=t.task_id
                LEFT JOIN runs r ON r.tenant_id=t.tenant AND r.id=t.run_id
                WHERE c.tenant=? AND c.workspace=? AND c.project=? AND t.state='QUEUED' AND r.id IS NULL''',
                (self.tenant,row['id'],row['project'])).fetchone()[0]
            block('queued_messages',queued,f'有 {queued} 条排队消息，请先处理或取消排队后再删除')
        if 'workflow_runs' in tables:
            flows=db.execute(f'''SELECT COUNT(*) FROM workflow_runs WHERE tenant=? AND workspace=? AND
                (json_extract(data,'$.status') NOT IN ({placeholders}) OR (owner IS NOT NULL AND lease_until>?))''',
                (self.tenant,row['id'],*sorted(TERMINAL),time.time())).fetchone()[0]
            block('workflows',flows,f'有 {flows} 项未完成工作流，请先完成或取消后再删除')
        if 'workspace_daily_plans' in tables:
            dispatches=db.execute('''SELECT COUNT(*) FROM workspace_daily_plans WHERE tenant=? AND workspace=?
                AND ((owner IS NOT NULL AND lease_until>?) OR json_extract(data,'$.dispatch.state')='PENDING')''',(self.tenant,row['id'],time.time())).fetchone()[0]
            block('daily_dispatch',dispatches,f'有 {dispatches} 项每日计划等待派发或正在派发，请先处理后重新检查')
        # Counts cover the shared workspace, without exposing other users' goals
        # or private conversation content.
        return {'workspace':self._row(row),'can_delete':not blockers,'blockers':blockers,'retains_data':True}

    def deletion_check(self, identity):
        identifier(identity)
        with self.store.connect() as db:
            db.execute('BEGIN')
            row=db.execute('SELECT * FROM workspaces WHERE tenant=? AND id=?',(self.tenant,identity)).fetchone()
            if not row:raise KeyError('workspace unavailable')
            return self._deletion_check(db,row)

    def lifecycle(self, identity, revision, deleted):
        identifier(identity)
        if type(revision) is not int or revision<1:raise ValueError('工作空间版本无效')
        if type(deleted) is not bool:raise ValueError('工作空间操作无效')
        with self.store.transaction() as db:
            row=db.execute('SELECT * FROM workspaces WHERE tenant=? AND id=?',(self.tenant,identity)).fetchone()
            if not row:raise KeyError('workspace unavailable')
            # Replaying a successful request returns its receipt without another
            # revision change. Older writes still conflict after a restore/edit.
            if bool(row['deleted'])==deleted and revision in (row['revision'],row['revision']-1):return self._row(row)
            if row['revision']!=revision:raise ConfigConflict('工作空间已更新，请重新加载')
            if deleted:
                check=self._deletion_check(db,row)
                if not check['can_delete']:raise ConfigConflict('；'.join(b['message'] for b in check['blockers']))
            else:
                name=json.loads(row['data'])['name']
                if db.execute('SELECT 1 FROM workspaces WHERE tenant=? AND deleted=0 AND id!=? AND json_extract(data,\'$.name\')=?',(self.tenant,identity,name)).fetchone():raise ConfigConflict('已有同名工作空间，请先修改其名称')
            db.execute('UPDATE workspaces SET deleted=?,revision=revision+1,updated=? WHERE tenant=? AND id=?',(int(deleted),time.time(),self.tenant,identity))
            receipt=self._row(db.execute('SELECT * FROM workspaces WHERE tenant=? AND id=?',(self.tenant,identity)).fetchone())
        return receipt
