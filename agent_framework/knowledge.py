"""Versioned knowledge, private preferences and reviewed experience assets.

SQLite/FTS is a retrieval aid. Tenant/project/environment/owner predicates are
applied to both discovery and source reads; an index hit is never authorization.
"""
from dataclasses import dataclass
import json
import re
import time
from uuid import uuid4

from .contracts import PolicyDenied, canonical, digest, identifier
from .store import Store

SPACE = 'simulated-change-context@1.0.0'
CONTEXT_REF = 'governed-context@1.0.0'
KINDS = {'KNOWLEDGE', 'PREFERENCE', 'EXPERIENCE'}


@dataclass(frozen=True)
class Access:
    tenant: str
    principal: str
    project: str
    environment: str = 'test'
    roles: tuple = ()

    def __post_init__(self):
        for value in (self.tenant, self.principal, self.project, self.environment):
            identifier(value)
        if self.environment != 'test':
            raise ValueError('only simulated test scope is supported')

    @classmethod
    def task(cls, task):
        return cls(task['tenant_id'], task['principal'], task['project_id'], task['environment'])


class KnowledgeUnavailable(PolicyDenied):
    pass


def tokens(text):
    words = re.findall(r'[a-z0-9_-]{2,80}', text.lower())
    for segment in re.findall(r'[\u3400-\u9fff]+', text):
        words.extend(segment[i:i+2] for i in range(max(0, len(segment)-1)))
        if len(segment) == 1:words.append(segment)
    return list(dict.fromkeys(words))[:256]


def schema(db):
    db.executescript('''
        CREATE TABLE IF NOT EXISTS asset_versions (
            tenant TEXT, id TEXT, version INTEGER, project TEXT, environment TEXT,
            owner TEXT, visibility TEXT, kind TEXT, space TEXT, status TEXT,
            data TEXT, hash TEXT, created REAL,
            PRIMARY KEY(tenant,id,version));
        CREATE VIRTUAL TABLE IF NOT EXISTS asset_search USING fts5(
            tenant UNINDEXED, id UNINDEXED, version UNINDEXED, terms);
        CREATE TABLE IF NOT EXISTS asset_events (
            tenant TEXT, id TEXT, version INTEGER, time REAL, actor TEXT, event TEXT, data TEXT);
        CREATE TABLE IF NOT EXISTS context_manifests (
            tenant TEXT, run_id TEXT, id TEXT, data TEXT, PRIMARY KEY(tenant,run_id,id));
        CREATE TABLE IF NOT EXISTS episodic_memories (
            tenant TEXT, run_id TEXT, project TEXT, environment TEXT, principal TEXT,
            data TEXT, PRIMARY KEY(tenant,run_id));
        CREATE TABLE IF NOT EXISTS experience_evaluations (
            tenant TEXT, id TEXT, version INTEGER, evaluation_id TEXT, asset_hash TEXT,
            data TEXT, PRIMARY KEY(tenant,evaluation_id));
    ''')


def insert_asset(db, access, identity, version, kind, body, status='DRAFT', visibility='PROJECT', owner=None):
    content_hash = digest(body)
    db.execute('INSERT INTO asset_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
               (access.tenant, identity, version, access.project, access.environment,
                owner or access.principal, visibility, kind, body['space_ref'], status,
                canonical(body), content_hash, time.time()))
    terms = ' '.join(tokens(body['title']+' '+canonical(body['content'])))
    db.execute('INSERT INTO asset_search VALUES(?,?,?,?)', (access.tenant, identity, version, terms))
    return content_hash


class Library:
    def __init__(self, store):
        self.store = store if isinstance(store, Store) else Store(store)
        with self.store.connect() as db:schema(db)

    @staticmethod
    def _record(row):
        return {'ref': f"{row['id']}@{row['version']}", 'id':row['id'], 'version':row['version'],
                'kind':row['kind'], 'status':row['status'], 'owner':row['owner'],
                'tenant_id':row['tenant'],'project_id':row['project'],'environment':row['environment'],
                'visibility':row['visibility'], 'content_hash':row['hash'], **json.loads(row['data'])}

    @staticmethod
    def _scope(access, review=False):
        # Review privileges allow inspecting source episodes only through the
        # explicit review path, not sharing their private contents with models.
        owner = '' if review and 'reviewer' in access.roles else " AND (visibility='PROJECT' OR owner=?)"
        params = [access.tenant, access.project, access.environment]
        if owner:params.append(access.principal)
        return 'tenant=? AND project=? AND environment=?'+owner, params

    def get(self, access, ref, *, review=False):
        try:identity, version = ref.rsplit('@',1); version = int(version); identifier(identity)
        except (ValueError, AttributeError):raise ValueError('invalid asset version reference')
        scope, params = self._scope(access, review)
        with self.store.connect() as db:
            row=db.execute('SELECT * FROM asset_versions WHERE '+scope+' AND id=? AND version=?',
                           (*params, identity, version)).fetchone()
        if not row:raise KeyError('asset not found in authorized scope')
        if digest(json.loads(row['data'])) != row['hash']:
            raise KnowledgeUnavailable('asset content hash mismatch')
        return self._record(row)

    def list(self, access, *, include_unpublished=False):
        scope, params=self._scope(access)
        if not include_unpublished:scope+=" AND status='PUBLISHED'"
        with self.store.connect() as db:
            rows=db.execute('SELECT * FROM asset_versions WHERE '+scope+' ORDER BY created DESC,id,version DESC',params).fetchall()
        return [self._record(row) for row in rows]

    def create(self, access, data):
        fields={'id','kind','title','content','visibility','space_ref','source_uri','source_version',
                'effective_at','effective_until','critical','conflict_key','supersedes','standard_ref'}
        if not isinstance(data,dict) or set(data)-fields:
            raise ValueError('unknown asset fields')
        kind=data.get('kind','KNOWLEDGE')
        if kind not in {'KNOWLEDGE','PREFERENCE'}:
            raise ValueError('experiences must originate from archived runs')
        if kind=='KNOWLEDGE' and 'curator' not in access.roles:
            raise PolicyDenied('knowledge editing requires curator role')
        identity=identifier(data.get('id') or 'asset-'+uuid4().hex[:16])
        if identity.startswith(('builtin-','experience-')):raise PolicyDenied('reserved asset identity')
        visibility=data.get('visibility','PRIVATE' if kind=='PREFERENCE' else 'PROJECT')
        if visibility not in {'PROJECT','PRIVATE'} or (kind=='PREFERENCE' and visibility!='PRIVATE'):
            raise ValueError('preferences are private; knowledge visibility must be explicit')
        title=data.get('title');content=data.get('content')
        if not isinstance(title,str) or not 1<=len(title)<=200 or not isinstance(content,dict):
            raise ValueError('asset requires title and structured content')
        if kind=='PREFERENCE':
            allowed={'language','report_title_prefix','report_style'}
            if not content or set(content)-allowed or any(not isinstance(v,str) or len(v)>100 for v in content.values()):
                raise ValueError('preferences only describe bounded presentation choices')
            if content.get('language','zh') not in {'zh','en'} or content.get('report_style','concise') not in {'concise','detailed'}:
                raise ValueError('unsupported presentation preference')
        elif set(content)!={'text'} or not isinstance(content['text'],str) or not 1<=len(content['text'])<=20000:
            raise ValueError('knowledge requires bounded text')
        now=time.time();start=data.get('effective_at',now);end=data.get('effective_until',now+365*86400)
        if type(start) not in (int,float) or type(end) not in (int,float) or not 0<=start<end:
            raise ValueError('invalid asset validity interval')
        if type(data.get('critical',False)) is not bool:raise ValueError('critical must be boolean')
        standard=data.get('standard_ref')
        if standard:
            from .definitions import STANDARDS
            if standard not in STANDARDS:raise ValueError('unknown executable standard')
        if data.get('critical') and not standard:raise ValueError('critical knowledge requires an executable standard binding')
        body={'title':title,'content':content,'space_ref':data.get('space_ref',SPACE),
              'source_uri':data.get('source_uri','local:curated'), 'source_version':data.get('source_version','1'),
              'effective_at':start,'effective_until':end,'observed_at':now,'sensitivity':'private' if visibility=='PRIVATE' else 'project',
              'access_policy_ref':'task-scope-owner@1.0.0','critical':data.get('critical',False),
              'conflict_key':data.get('conflict_key',''),'supersedes':data.get('supersedes'), 'standard_ref':standard}
        for key in ('space_ref','source_uri','source_version','conflict_key'):
            if not isinstance(body[key],str) or len(body[key])>1000:raise ValueError('invalid asset metadata')
        if body['space_ref']!=SPACE:raise ValueError('unpublished knowledge space')
        with self.store.transaction() as db:
            prior=db.execute('SELECT * FROM asset_versions WHERE tenant=? AND id=? ORDER BY version DESC LIMIT 1',
                             (access.tenant,identity)).fetchone()
            if prior and (prior['project']!=access.project or prior['environment']!=access.environment or prior['owner']!=access.principal):
                raise PolicyDenied('asset revision belongs to another owner/scope')
            version=prior['version']+1 if prior else 1
            if body['supersedes']:
                if not prior or body['supersedes']!=f"{identity}@{prior['version']}":raise ValueError('supersedes must identify preceding version')
            insert_asset(db,access,identity,version,kind,body,visibility=visibility)
            db.execute('INSERT INTO asset_events VALUES(?,?,?,?,?,?,?)',
                       (access.tenant,identity,version,now,access.principal,'created','{}'))
        return self.get(access,f'{identity}@{version}')

    def transition(self, access, ref, target, *, evaluation_id=None):
        asset=self.get(access,ref,review=True)
        if target not in {'REVIEW','PUBLISHED','WITHDRAWN'}:raise ValueError('invalid lifecycle transition')
        role='reviewer' if asset['kind']=='EXPERIENCE' else 'curator'
        if asset['kind']=='PREFERENCE':
            if asset['owner']!=access.principal:raise PolicyDenied('preference owner required')
        elif role not in access.roles:raise PolicyDenied(role+' role required')
        allowed={'DRAFT':{'REVIEW'},'REVIEW':{'PUBLISHED','WITHDRAWN'},'EVALUATED':{'PUBLISHED','WITHDRAWN'},
                 'PUBLISHED':{'WITHDRAWN'},'CANDIDATE':{'WITHDRAWN'}}
        if target not in allowed.get(asset['status'],set()):raise ValueError('invalid current asset state')
        with self.store.transaction() as db:
            if asset['kind']=='EXPERIENCE' and target=='PUBLISHED':
                evaluation=db.execute('SELECT * FROM experience_evaluations WHERE tenant=? AND evaluation_id=? AND id=? AND version=?',
                                      (access.tenant,evaluation_id,asset['id'],asset['version'])).fetchone()
                latest=db.execute('SELECT evaluation_id FROM experience_evaluations WHERE tenant=? AND id=? AND version=? ORDER BY rowid DESC LIMIT 1',
                                  (access.tenant,asset['id'],asset['version'])).fetchone()
                if not evaluation or not latest or latest[0]!=evaluation_id or evaluation['asset_hash']!=asset['content_hash'] or not json.loads(evaluation['data'])['passed']:
                    raise PolicyDenied('latest matching successful offline evaluation required')
                from .definitions import get_domain
                evaluated=json.loads(evaluation['data'])
                if evaluated['domain_hash']!=digest(get_domain(evaluated.get('domain_ref','change-assessment@2.0.0')).descriptor()):
                    raise PolicyDenied('evaluation implementation drift; reevaluation required')
            cursor=db.execute('UPDATE asset_versions SET status=? WHERE tenant=? AND id=? AND version=? AND status=? AND hash=?',
                              (target,access.tenant,asset['id'],asset['version'],asset['status'],asset['content_hash']))
            if cursor.rowcount!=1:raise ValueError('asset changed; reload before reviewing')
            db.execute('INSERT INTO asset_events VALUES(?,?,?,?,?,?,?)',
                       (access.tenant,asset['id'],asset['version'],time.time(),access.principal,target,canonical({'evaluation_id':evaluation_id})))
            if asset['kind']=='EXPERIENCE':
                for run in asset['content']['supporting_runs']:
                    db.execute('UPDATE experience_candidates SET status=? WHERE tenant_id=? AND run_id=?',(target,access.tenant,run))
        return self.get(access,ref,review=True)

    def bootstrap(self, access):
        identity='builtin-risk-rubric-'+digest([access.project,access.environment])[:12]
        with self.store.transaction() as db:
            existing=db.execute('SELECT 1 FROM asset_versions WHERE tenant=? AND id=?',(access.tenant,identity)).fetchone()
            if not existing:
                now=time.time()
                body={'title':'模拟变更评估与草稿验收标准','content':{'text':'变更评估：失败测试判 HIGH；否则有依赖判 MEDIUM，否则 LOW。报告需引用来源证据，草稿供人工审核；写入状态不明先按原幂等键核对。'},
                      'space_ref':SPACE,'source_uri':'synthetic:release-review-rubric','source_version':'1.0.0',
                      'observed_at':now,'effective_at':0,'effective_until':4102444800,
                      'access_policy_ref':'task-scope-owner@1.0.0','sensitivity':'project','critical':True,
                      'conflict_key':'release-risk-rules','supersedes':None,'standard_ref':'release-review-rubric@1.0.0'}
                insert_asset(db,access,identity,1,'KNOWLEDGE',body,'PUBLISHED',owner='system')
        return f'{identity}@1'

    def binding(self, task, spaces, standards=()):
        access=Access.task(task);ref=self.bootstrap(access)
        available=self.search(access,'',spaces=spaces)['items']
        required=[asset for asset in available if asset['critical'] and asset['standard_ref'] in standards]
        if SPACE in spaces and 'release-review-rubric@1.0.0' in standards and not required:required=[self.get(access,ref)]
        return {'ref':CONTEXT_REF,'spaces':list(spaces),'required_assets':[
            {'ref':a['ref'],'content_hash':a['content_hash']} for a in required], 'max_optional_bytes':12000}

    def validate_required(self, state):
        binding=state['snapshot'].get('context_policy')
        if not binding:return []
        if binding.get('ref')!=CONTEXT_REF:raise KnowledgeUnavailable('unavailable frozen context policy')
        now=time.time();assets=[];access=Access.task(state['task'])
        for requirement in binding['required_assets']:
            try:asset=self.get(access,requirement['ref'])
            except KeyError:raise KnowledgeUnavailable('required knowledge is no longer accessible')
            if (asset['content_hash']!=requirement['content_hash'] or asset['status']!='PUBLISHED'
                    or not asset['effective_at']<=now<asset['effective_until']):
                raise KnowledgeUnavailable('required knowledge withdrawn, expired or changed: '+requirement['ref'])
            assets.append(asset)
        return assets

    def search(self, access, query='', *, spaces=(SPACE,), limit=12, for_context=False):
        if not isinstance(query,str) or len(query)>2000 or type(limit) is not int or not 1<=limit<=50:
            raise ValueError('invalid search query/limit')
        if not isinstance(spaces,(list,tuple)) or any(space!=SPACE for space in spaces):raise ValueError('unknown knowledge space')
        if not spaces:return {'items':[],'excluded':[]}
        scope,params=self._scope(access)
        terms=tokens(query)
        with self.store.connect() as db:
            # No content/identities from unauthorized rows reach the ranker or manifest.
            rows=db.execute('SELECT * FROM asset_versions WHERE '+scope+' AND space=? ORDER BY id,version DESC',(*params,SPACE)).fetchall()
            matched=set()
            if terms:
                expression=' OR '.join('"'+term+'"' for term in terms)
                hits=db.execute('''SELECT a.id,a.version FROM asset_search s JOIN asset_versions a
                    ON a.tenant=s.tenant AND a.id=s.id AND a.version=s.version
                    WHERE s.terms MATCH ? AND a.tenant=? AND a.project=? AND a.environment=?
                    AND (a.visibility='PROJECT' OR a.owner=?)''',
                    (expression,access.tenant,access.project,access.environment,access.principal)).fetchall()
                matched={(r['id'],int(r['version'])) for r in hits}
        chosen=[];excluded=[];seen=set();now=time.time()
        for row in rows:
            if row['id'] in seen:continue
            asset=self._record(row)
            reason=None
            if digest(json.loads(row['data']))!=row['hash']:reason='content-hash-mismatch'
            elif row['status']!='PUBLISHED':reason='not-published'
            elif not asset['effective_at']<=now<asset['effective_until']:reason='not-effective-or-expired'
            if reason:
                excluded.append({'ref':asset['ref'],'reason':reason,'critical':asset['critical']})
                continue
            seen.add(row['id'])
            if terms and (row['id'],row['version']) not in matched and asset['kind']!='PREFERENCE' and not (for_context and asset['critical']):
                continue
            chosen.append(asset)
        # Equal published claims require explicit supersession, not model arbitration.
        groups={}
        for a in chosen:
            if a['conflict_key']:groups.setdefault(a['conflict_key'],[]).append(a)
        conflicted=set()
        for group in groups.values():
            if len({digest(a['content']) for a in group})>1:
                for a in group:
                    if not any(b['supersedes']==a['ref'] for b in group):conflicted.add(a['ref'])
                if len(conflicted.intersection({a['ref'] for a in group}))==1:
                    # One explicit replacement is authoritative, not a conflict.
                    if any(a['supersedes'] in {b['ref'] for b in group} for a in group):
                        conflicted.difference_update(a['ref'] for a in group)
        for a in chosen:
            if a['ref'] in conflicted:excluded.append({'ref':a['ref'],'reason':'conflicting-published-sources','critical':a['critical'],'standard_ref':a['standard_ref']})
        chosen=[a for a in chosen if a['ref'] not in conflicted]
        chosen.sort(key=lambda a:(not a['critical'], a['kind']=='EXPERIENCE', -len(set(terms).intersection(tokens(a['title']+' '+canonical(a['content'])))), a['ref']))
        return {'items':chosen[:limit],'excluded':excluded}
