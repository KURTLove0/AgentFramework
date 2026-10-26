"""Workspace-owned business domains backed by an explicit execution method."""
from copy import deepcopy
import json
import re

from .contracts import canonical, digest
from .runtime_config import ConfigConflict


def normalize_domain(value, *, frozen=False):
    from .agents import text
    from .definitions import get_domain
    fields = {'name', 'description', 'domain_pack_ref'}
    if frozen:
        fields |= {'id', 'revision'}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError('请填写领域名称、用途说明和工作方式')
    result = {key: text(value[key], '领域名称' if key == 'name' else '领域用途' if key == 'description' else '工作方式',
                        80 if key == 'name' else 1000 if key == 'description' else 120,
                        empty=key == 'description') for key in ('name', 'description', 'domain_pack_ref')}
    get_domain(result['domain_pack_ref'])
    if frozen:
        if (not isinstance(value['id'], str) or not re.fullmatch(r'domain-[a-f0-9]{24}', value['id'])
                or type(value['revision']) is not int or value['revision'] != 1):
            raise ValueError('领域快照无效')
        result.update(id=value['id'], revision=1)
    return result


class AgentDomains:
    def __init__(self, store, tenant, workspace):
        self.store, self.tenant, self.workspace = store, tenant, workspace
        with store.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS agent_domains (
                tenant TEXT, workspace TEXT, id TEXT, name_key TEXT, data TEXT,
                PRIMARY KEY(tenant,workspace,id), UNIQUE(tenant,workspace,name_key))''')

    def list(self):
        with self.store.connect() as db:
            rows = db.execute('SELECT data FROM agent_domains WHERE tenant=? AND workspace=? ORDER BY name_key',
                              (self.tenant, self.workspace)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def get(self, identity):
        with self.store.connect() as db:
            row = db.execute('SELECT data FROM agent_domains WHERE tenant=? AND workspace=? AND id=?',
                             (self.tenant, self.workspace, identity)).fetchone()
        if not row:
            raise ValueError('此处理领域不属于当前工作空间，请重新选择')
        return json.loads(row[0])

    def create(self, data):
        value = normalize_domain(data)
        name_key = value['name'].casefold()
        value.update(id='domain-' + digest([self.tenant, self.workspace, value])[:24], revision=1)
        with self.store.transaction() as db:
            row = db.execute('SELECT data FROM agent_domains WHERE tenant=? AND workspace=? AND name_key=?',
                             (self.tenant, self.workspace, name_key)).fetchone()
            if row:
                existing = json.loads(row[0])
                if existing == value:
                    return existing
                raise ConfigConflict('已有同名领域，请选择已有领域或使用其他名称')
            db.execute('INSERT INTO agent_domains VALUES(?,?,?,?,?)',
                       (self.tenant, self.workspace, value['id'], name_key, canonical(value)))
        return deepcopy(value)
