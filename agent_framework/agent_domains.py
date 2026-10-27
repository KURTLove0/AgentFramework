"""Workspace-owned business scope and reusable guidance, independent of execution."""
from copy import deepcopy
import json
import re
from uuid import uuid4

from .contracts import canonical
from .runtime_config import ConfigConflict

LEGACY_METHODS={'knowledge-answer@1.0.0':'资料问答与来源核对',
                'change-assessment@2.0.0':'变更评估与草稿创建'}


def normalize_domain(value, *, frozen=False):
    from .agents import text
    identity_fields={'id','revision'} if frozen else set()
    if not isinstance(value,dict):raise ValueError('请填写领域名称、用途说明和工作方式')
    legacy=set(value)=={'name','description','domain_pack_ref'}|identity_fields
    if legacy:
        from .definitions import get_domain
        ref=text(value['domain_pack_ref'],'历史工作方式',120);get_domain(ref)
        result={'name':text(value['name'],'领域名称',80),
                'description':text(value['description'],'领域用途',1000,empty=True)}
        # Historical snapshots retain their exact shape/hash for task recovery.
        if frozen:result['domain_pack_ref']=ref
        else:result['work_method']=LEGACY_METHODS[ref]
    else:
        required={'name'}|identity_fields
        if not required<=set(value) or set(value)-({'name','description','work_method'}|identity_fields):
            raise ValueError('领域仅支持名称、用途说明和自定义工作方式')
        result={'name':text(value['name'],'领域名称',80),
                'description':text(value.get('description',''),'领域用途',1000,empty=True),
                'work_method':text(value.get('work_method',''),'工作方式',4000,empty=True)}
    if frozen:
        if (not isinstance(value['id'], str) or not re.fullmatch(r'domain-[a-f0-9]{24}', value['id'])
                or type(value['revision']) is not int or value['revision'] < 1):
            raise ValueError('领域快照无效')
        result.update(id=value['id'], revision=value['revision'])
    return result


class AgentDomains:
    def __init__(self, store, tenant, workspace):
        self.store, self.tenant, self.workspace = store, tenant, workspace
        with store.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS agent_domains (
                tenant TEXT, workspace TEXT, id TEXT, name_key TEXT, data TEXT,
                PRIMARY KEY(tenant,workspace,id), UNIQUE(tenant,workspace,name_key))''')
            if 'archived' not in {r[1] for r in db.execute('PRAGMA table_info(agent_domains)')}:
                db.execute('ALTER TABLE agent_domains ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
        with store.transaction() as db:
            rows=db.execute('SELECT id,data FROM agent_domains WHERE tenant=? AND workspace=?',
                            (tenant,workspace)).fetchall()
            for row in rows:
                prior=json.loads(row['data'])
                if 'domain_pack_ref' not in prior:continue
                value=normalize_domain({key:prior[key] for key in ('name','description','domain_pack_ref')})
                value.update(id=prior['id'],revision=prior['revision']+1)
                db.execute('UPDATE agent_domains SET data=? WHERE tenant=? AND workspace=? AND id=?',
                           (canonical(value),tenant,workspace,row['id']))

    def list(self):
        with self.store.connect() as db:
            rows = db.execute('SELECT data FROM agent_domains WHERE tenant=? AND workspace=? AND archived=0 ORDER BY name_key',
                              (self.tenant, self.workspace)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def get(self, identity, *, include_archived=False):
        with self.store.connect() as db:
            row = db.execute('SELECT data,archived FROM agent_domains WHERE tenant=? AND workspace=? AND id=?',
                             (self.tenant, self.workspace, identity)).fetchone()
        if not row:
            raise ValueError('此处理领域不属于当前工作空间，请重新选择')
        if row['archived'] and not include_archived:
            raise ValueError('此处理领域已归档，请恢复后选用，或选择其他领域')
        return json.loads(row[0])

    def catalog(self):
        with self.store.connect() as db:
            rows = db.execute('SELECT data,archived FROM agent_domains WHERE tenant=? AND workspace=? ORDER BY name_key',
                              (self.tenant, self.workspace)).fetchall()
            agents = db.execute('SELECT data FROM agent_profiles WHERE tenant=? AND workspace_id=?',
                               (self.tenant, self.workspace)).fetchall()
        counts = {}
        for row in agents:
            identity = json.loads(row[0]).get('processing_domain', {}).get('id')
            counts[identity] = counts.get(identity, 0) + 1
        return [{**json.loads(row['data']), 'archived': bool(row['archived']),
                 'agent_count': counts.get(json.loads(row['data'])['id'], 0)} for row in rows]

    def create(self, data):
        value = normalize_domain(data)
        name_key = value['name'].casefold()
        with self.store.transaction() as db:
            row = db.execute('SELECT data,archived FROM agent_domains WHERE tenant=? AND workspace=? AND name_key=?',
                             (self.tenant, self.workspace, name_key)).fetchone()
            if row:
                existing = json.loads(row[0])
                if row['archived']:
                    raise ConfigConflict('已有同名领域已归档，请在处理领域管理中恢复后选用')
                if all(existing[key] == value[key] for key in value):
                    return existing
                raise ConfigConflict('已有同名领域，请选择已有领域或使用其他名称')
            value.update(id='domain-' + uuid4().hex[:24], revision=1)
            db.execute('INSERT INTO agent_domains(tenant,workspace,id,name_key,data) VALUES(?,?,?,?,?)',
                       (self.tenant, self.workspace, value['id'], name_key, canonical(value)))
        return deepcopy(value)

    def update(self, identity, data):
        if not isinstance(data, dict) or 'revision' not in data:
            raise ValueError('请提供领域名称、用途、工作方式和当前版本')
        value = normalize_domain({key:value for key,value in data.items() if key!='revision'})
        revision = data['revision']
        self._revision(revision)
        with self.store.transaction() as db:
            row = self._current(db, identity, revision)
            if row['archived']:
                raise ConfigConflict('请先恢复领域，再编辑配置')
            name_key = value['name'].casefold()
            if db.execute('SELECT 1 FROM agent_domains WHERE tenant=? AND workspace=? AND name_key=? AND id!=?',
                          (self.tenant, self.workspace, name_key, identity)).fetchone():
                raise ConfigConflict('已有同名领域，请使用其他名称')
            value.update(id=identity, revision=revision + 1)
            db.execute('UPDATE agent_domains SET name_key=?,data=? WHERE tenant=? AND workspace=? AND id=?',
                       (name_key, canonical(value), self.tenant, self.workspace, identity))
        return value

    def archive(self, identity, data):
        if not isinstance(data, dict) or set(data) != {'revision', 'archived'} or type(data['archived']) is not bool:
            raise ValueError('归档参数无效')
        self._revision(data['revision'])
        with self.store.transaction() as db:
            row = self._current(db, identity, data['revision'])
            value = json.loads(row['data'])
            value['revision'] += 1
            db.execute('UPDATE agent_domains SET data=?,archived=? WHERE tenant=? AND workspace=? AND id=?',
                       (canonical(value), int(data['archived']), self.tenant, self.workspace, identity))
        return {**value, 'archived': data['archived']}

    @staticmethod
    def _revision(revision):
        if type(revision) is not int or revision < 1:
            raise ValueError('领域版本号无效')

    def _current(self, db, identity, revision):
        row = db.execute('SELECT data,archived FROM agent_domains WHERE tenant=? AND workspace=? AND id=?',
                         (self.tenant, self.workspace, identity)).fetchone()
        if not row:
            raise ValueError('此处理领域不属于当前工作空间，请重新选择')
        if json.loads(row['data'])['revision'] != revision:
            raise ConfigConflict('领域已被其他页面更新，请刷新后重试')
        return row
