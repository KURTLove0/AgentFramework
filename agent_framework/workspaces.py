"""Versioned business workspaces. Deletion is reversible and never rewrites runs."""
import json
import time
from uuid import uuid4

from .contracts import canonical, identifier, TERMINAL, digest
from .runtime_config import ConfigConflict

DEFAULT_WORKSPACE = 'workspace-default'


class WorkspaceRegistry:
    def __init__(self, store, tenant):
        self.store, self.tenant = store, tenant
        with store.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS workspaces (
                tenant TEXT, id TEXT, revision INTEGER, data TEXT, project TEXT,
                deleted INTEGER, created REAL, updated REAL, PRIMARY KEY(tenant,id), UNIQUE(tenant,project))''')
            now=time.time()
            db.execute('INSERT OR IGNORE INTO workspaces VALUES(?,?,?,?,?,0,?,?)',
                       (tenant,DEFAULT_WORKSPACE,1,canonical({'name':'本地工作空间','business':'模拟业务','scenario':'变更评估与知识问答','description':'原有 Agent、任务与资料所在的默认空间。'}),'project-demo',now,now))
            # Historical CLI projects remain reachable without mutating their frozen tasks.
            for row in db.execute('SELECT state FROM runs WHERE tenant_id=?',(tenant,)).fetchall():
                task=json.loads(row[0])['task'];project=task['project_id']
                if project=='project-demo':continue
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
        if not row or (row['deleted'] and not include_deleted):raise KeyError('workspace unavailable')
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
        return self.get(identity)

    def lifecycle(self, identity, revision, deleted):
        if type(revision) is not int:raise ValueError('工作空间版本无效')
        with self.store.transaction() as db:
            row=db.execute('SELECT * FROM workspaces WHERE tenant=? AND id=?',(self.tenant,identity)).fetchone()
            if not row:raise KeyError('workspace unavailable')
            if row['revision']!=revision:raise ConfigConflict('工作空间已更新，请重新加载')
            if deleted:
                if db.execute('SELECT COUNT(*) FROM workspaces WHERE tenant=? AND deleted=0',(self.tenant,)).fetchone()[0]<=1:raise ConfigConflict('至少保留一个可用工作空间')
                for run in db.execute('SELECT state FROM runs WHERE tenant_id=?',(self.tenant,)):
                    state=json.loads(run[0])
                    if state['task']['project_id']==row['project'] and state['status'] not in TERMINAL:raise ConfigConflict('此空间有未完成任务，请先完成或取消后再删除')
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_runs'").fetchone():
                    for flow in db.execute('SELECT data FROM workflow_runs WHERE tenant=? AND workspace=?',(self.tenant,identity)):
                        if json.loads(flow[0])['status'] not in TERMINAL:raise ConfigConflict('此空间有未完成工作流，请先完成或取消后再删除')
            else:
                name=json.loads(row['data'])['name']
                if db.execute('SELECT 1 FROM workspaces WHERE tenant=? AND deleted=0 AND id!=? AND json_extract(data,\'$.name\')=?',(self.tenant,identity,name)).fetchone():raise ConfigConflict('已有同名工作空间，请先修改其名称')
            db.execute('UPDATE workspaces SET deleted=?,revision=revision+1,updated=? WHERE tenant=? AND id=?',(int(deleted),time.time(),self.tenant,identity))
        return self.get(identity,include_deleted=True)
