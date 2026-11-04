"""Versioned knowledge, private preferences and reviewed experience assets.

SQLite/FTS is a retrieval aid. Tenant/project/environment/owner predicates are
applied to both discovery and source reads; an index hit is never authorization.
"""
from dataclasses import dataclass
from copy import deepcopy
import json
import re
import time
from uuid import uuid4

from .contracts import PolicyDenied, canonical, digest, identifier
from .store import Store
from .runtime_config import ConfigConflict

SPACE = 'simulated-change-context@1.0.0'
CONTEXT_REF = 'governed-context@1.0.0'
KINDS = {'KNOWLEDGE', 'PREFERENCE', 'MEMORY', 'EXPERIENCE', 'CAPABILITY', 'ONTOLOGY'}


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


class AssetSaveReceiptNotFound(KeyError):
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
        CREATE TABLE IF NOT EXISTS asset_save_requests (
            tenant TEXT,project TEXT,environment TEXT,principal TEXT,request_id TEXT,request_hash TEXT,
            asset_id TEXT,version INTEGER,asset_hash TEXT,created REAL,
            PRIMARY KEY(tenant,project,environment,principal,request_id));
        CREATE INDEX IF NOT EXISTS asset_scope_kind ON asset_versions(tenant,project,environment,kind,id,version DESC);
        CREATE INDEX IF NOT EXISTS asset_event_version ON asset_events(tenant,id,event,version DESC);
        CREATE TABLE IF NOT EXISTS ontology_activation (
            tenant TEXT, id TEXT, version INTEGER, PRIMARY KEY(tenant,id));
        CREATE TABLE IF NOT EXISTS ontology_evidence (
            tenant TEXT, id TEXT, version INTEGER, path TEXT, source_ref TEXT,
            revision INTEGER, data TEXT, PRIMARY KEY(tenant,id,version,path,source_ref));
        CREATE TABLE IF NOT EXISTS context_manifests (
            tenant TEXT, run_id TEXT, id TEXT, data TEXT, PRIMARY KEY(tenant,run_id,id));
        CREATE TABLE IF NOT EXISTS episodic_memories (
            tenant TEXT, run_id TEXT, project TEXT, environment TEXT, principal TEXT,
            data TEXT, PRIMARY KEY(tenant,run_id));
        CREATE TABLE IF NOT EXISTS experience_evaluations (
            tenant TEXT, id TEXT, version INTEGER, evaluation_id TEXT, asset_hash TEXT,
            data TEXT, PRIMARY KEY(tenant,evaluation_id));
        CREATE INDEX IF NOT EXISTS experience_evaluation_version ON experience_evaluations(tenant,id,version);
        CREATE INDEX IF NOT EXISTS episode_scope ON episodic_memories(tenant,project,environment,principal);
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

    def assert_writable(self,db,access):
        """Fence new asset changes; unregistered CLI projects remain supported."""
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspaces'").fetchone():
            row=db.execute('SELECT deleted FROM workspaces WHERE tenant=? AND project=?',(access.tenant,access.project)).fetchone()
            if row and row['deleted']:raise KeyError('workspace unavailable')

    def get(self, access, ref, *, review=False, db=None):
        try:identity, version = ref.rsplit('@',1); version = int(version); identifier(identity)
        except (ValueError, AttributeError):raise ValueError('invalid asset version reference')
        scope, params = self._scope(access, review)
        with self.store.read_snapshot(db) as connection:
            row=connection.execute('SELECT * FROM asset_versions WHERE '+scope+' AND id=? AND version=?',
                           (*params, identity, version)).fetchone()
        if not row:raise KeyError('asset not found in authorized scope')
        if digest(json.loads(row['data'])) != row['hash']:
            raise KnowledgeUnavailable('asset content hash mismatch')
        return self._record(row)

    def list(self, access, *, include_unpublished=False, kind=None, evaluation_summaries=False):
        scope, params=self._scope(access)
        if kind is not None:
            if kind not in KINDS:raise ValueError('unknown asset kind')
            scope+=' AND kind=?';params.append(kind)
        if not include_unpublished:scope+=" AND status='PUBLISHED'"
        with self.store.connect() as db:
            if evaluation_summaries:
                # The exact version and its newest evaluation are read together.
                # Project metadata in SQLite; case/source bodies are not copied into Python.
                rows=db.execute('''SELECT a.*,e.rowid AS evaluation_row,
                    json_extract(e.data,'$.id') AS evaluation_id,
                    json_extract(e.data,'$.passed') AS evaluation_passed,
                    json_extract(e.data,'$.created_at') AS evaluation_created
                    FROM (SELECT * FROM asset_versions WHERE '''+scope+''') a
                    LEFT JOIN experience_evaluations e ON a.kind='EXPERIENCE' AND e.rowid=(
                        SELECT rowid FROM experience_evaluations latest
                        WHERE latest.tenant=a.tenant AND latest.id=a.id AND latest.version=a.version
                        ORDER BY rowid DESC LIMIT 1)
                    ORDER BY a.created DESC,a.id,a.version DESC''',params).fetchall()
            else:rows=db.execute('SELECT * FROM asset_versions WHERE '+scope+' ORDER BY created DESC,id,version DESC',params).fetchall()
        result=[]
        for row in rows:
            asset=self._record(row)
            if evaluation_summaries and row['evaluation_row'] is not None:
                asset['latest_evaluation']={'id':row['evaluation_id'],'passed':bool(row['evaluation_passed']),'created_at':row['evaluation_created']}
            result.append(asset)
        return result

    def active_ontology_ref(self, access, identity, *, db=None):
        """A withdrawal never silently reactivates a previous publication."""
        scope,params=self._scope(access)
        with self.store.read_snapshot(db) as connection:
            row=connection.execute('SELECT v.version FROM asset_versions v WHERE '+scope+" AND id=? AND kind='ONTOLOGY' AND version=COALESCE((SELECT version FROM ontology_activation WHERE tenant=v.tenant AND id=v.id),(SELECT MAX(p.version) FROM asset_versions p WHERE p.tenant=v.tenant AND p.id=v.id AND (p.status='PUBLISHED' OR EXISTS(SELECT 1 FROM asset_events e WHERE e.tenant=p.tenant AND e.id=p.id AND e.version=p.version AND e.event='PUBLISHED'))))",(*params,identifier(identity))).fetchone()
        return identity+'@'+str(row['version']) if row else None

    def _save_receipt(self,db,access,request_id,request_hash=None):
        receipt=db.execute('SELECT * FROM asset_save_requests WHERE tenant=? AND project=? AND environment=? AND principal=? AND request_id=?',
                           (access.tenant,access.project,access.environment,access.principal,request_id)).fetchone()
        if not receipt:return None
        if request_hash is not None and receipt['request_hash']!=request_hash:raise ConfigConflict('此保存编号已用于另一份资料内容，请先核对原保存')
        asset=self.get(access,receipt['asset_id']+'@'+str(receipt['version']),db=db)
        if asset['content_hash']!=receipt['asset_hash']:raise PolicyDenied('saved asset hash does not match its receipt')
        return {**asset,'save_receipt':{'request_id':request_id,'ref':asset['ref'],'version':receipt['version'],
                'content_hash':receipt['asset_hash'],'request_hash':receipt['request_hash'],'status':'DRAFT','at':receipt['created'],'replayed':True}}

    def save_request(self,access,request_id):
        identifier(request_id)
        with self.store.read_snapshot() as db:
            self.assert_writable(db,access);receipt=self._save_receipt(db,access,request_id)
            if receipt is None:raise AssetSaveReceiptNotFound('Asset save receipt not found')
            return receipt

    def create(self, access, data, *, request_id=None):
        data=deepcopy(data)
        fields={'id','kind','title','content','visibility','space_ref','source_uri','source_version',
                'effective_at','effective_until','critical','conflict_key','supersedes','standard_ref'}
        if not isinstance(data,dict) or set(data)-fields:
            raise ValueError('unknown asset fields')
        request_hash=None
        if request_id is not None:
            identifier(request_id);request_hash=digest(data)
            with self.store.read_snapshot() as db:
                self.assert_writable(db,access);receipt=self._save_receipt(db,access,request_id,request_hash)
                if receipt:return receipt
        kind=data.get('kind','KNOWLEDGE')
        if kind not in {'KNOWLEDGE','PREFERENCE','MEMORY','CAPABILITY'}:
            raise ValueError('experiences must originate from archived runs')
        if kind in {'KNOWLEDGE','CAPABILITY'} and 'curator' not in access.roles:
            raise PolicyDenied('knowledge editing requires curator role')
        identity=identifier(data.get('id') or 'asset-'+uuid4().hex[:16])
        if identity.startswith(('builtin-','experience-')):raise PolicyDenied('reserved asset identity')
        visibility=data.get('visibility','PRIVATE' if kind in {'PREFERENCE','MEMORY'} else 'PROJECT')
        if visibility not in {'PROJECT','PRIVATE'} or (kind in {'PREFERENCE','MEMORY'} and visibility!='PRIVATE'):
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
        elif not {'text'}<=set(content)<= {'text','limitations'} or not isinstance(content['text'],str) or not 1<=len(content['text'])<=20000:
            raise ValueError('knowledge requires bounded text')
        if 'limitations' in content and (not isinstance(content['limitations'],list) or len(content['limitations'])>12 or any(not isinstance(v,str) or len(v)>2000 for v in content['limitations'])):
            raise ValueError('invalid content limitations')
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
            self.assert_writable(db,access)
            if request_id is not None:
                receipt=self._save_receipt(db,access,request_id,request_hash)
                if receipt:return receipt
            prior=db.execute('SELECT * FROM asset_versions WHERE tenant=? AND id=? ORDER BY version DESC LIMIT 1',
                             (access.tenant,identity)).fetchone()
            if prior and (prior['project']!=access.project or prior['environment']!=access.environment or prior['owner']!=access.principal):
                raise PolicyDenied('asset revision belongs to another owner/scope')
            if prior and prior['kind']!=kind:raise ValueError('asset revision cannot change kind')
            if prior and json.loads(prior['data']).get('provenance'):
                body['provenance']=json.loads(prior['data'])['provenance']
            version=prior['version']+1 if prior else 1
            if body['supersedes']:
                if not prior or body['supersedes']!=f"{identity}@{prior['version']}":raise ConfigConflict('资料已有新版本，请核对当前版本后再保存')
            insert_asset(db,access,identity,version,kind,body,visibility=visibility)
            db.execute('INSERT INTO asset_events VALUES(?,?,?,?,?,?,?)',
                       (access.tenant,identity,version,now,access.principal,'created','{}'))
            asset=self.get(access,f'{identity}@{version}',db=db)
            if request_id is not None:
                db.execute('INSERT INTO asset_save_requests VALUES(?,?,?,?,?,?,?,?,?,?)',
                    (access.tenant,access.project,access.environment,access.principal,request_id,request_hash,identity,version,asset['content_hash'],now))
                asset['save_receipt']={'request_id':request_id,'ref':asset['ref'],'version':version,'content_hash':asset['content_hash'],'request_hash':request_hash,'status':'DRAFT','at':now,'replayed':False}
            return asset

    def transition(self, access, ref, target, *, evaluation_id=None):
        asset=self.get(access,ref,review=True)
        if target not in {'REVIEW','PUBLISHED','WITHDRAWN'}:raise ValueError('invalid lifecycle transition')
        role='reviewer' if asset['kind']=='EXPERIENCE' else 'curator'
        if asset['kind'] in {'PREFERENCE','MEMORY'}:
            if asset['owner']!=access.principal:raise PolicyDenied('preference owner required')
        elif role not in access.roles:raise PolicyDenied(role+' role required')
        allowed={'DRAFT':{'REVIEW'},'REVIEW':{'PUBLISHED','WITHDRAWN'},'EVALUATED':{'PUBLISHED','WITHDRAWN'},
                 'PUBLISHED':{'WITHDRAWN'},'CANDIDATE':{'WITHDRAWN'}}
        if target not in allowed.get(asset['status'],set()):raise ValueError('invalid current asset state')
        with self.store.transaction() as db:
            self.assert_writable(db,access)
            if asset['kind']=='ONTOLOGY' and target=='PUBLISHED':
                from .ontology import sources_current,validate_ontology
                if not asset['effective_at']<=time.time()<asset['effective_until']:raise PolicyDenied('本体尚未生效或已过期，不能发布')
                if not sources_current(self,access,asset,db=db):raise PolicyDenied('本体来源已撤回、过期或变化，不能发布')
                validate_ontology(asset['content'],{s['ref'] for s in asset['provenance']['sources']})
                db.execute('INSERT OR REPLACE INTO ontology_activation VALUES(?,?,?)',(access.tenant,asset['id'],asset['version']))
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
            return self.get(access,ref,review=True,db=db)

    def bootstrap(self, access):
        identity='builtin-risk-rubric-'+digest([access.project,access.environment])[:12]
        with self.store.transaction() as db:
            existing=db.execute('SELECT 1 FROM asset_versions WHERE tenant=? AND id=?',(access.tenant,identity)).fetchone()
            if not existing:
                self.assert_writable(db,access)
                now=time.time()
                body={'title':'模拟变更评估与草稿验收标准','content':{'text':'变更评估：失败测试判 HIGH；否则有依赖判 MEDIUM，否则 LOW。报告需引用来源证据，草稿供人工审核；写入状态不明先按原幂等键核对。'},
                      'space_ref':SPACE,'source_uri':'synthetic:release-review-rubric','source_version':'1.0.0',
                      'observed_at':now,'effective_at':0,'effective_until':4102444800,
                      'access_policy_ref':'task-scope-owner@1.0.0','sensitivity':'project','critical':True,
                      'conflict_key':'release-risk-rules','supersedes':None,'standard_ref':'release-review-rubric@1.0.0'}
                insert_asset(db,access,identity,1,'KNOWLEDGE',body,'PUBLISHED',owner='system')
        return f'{identity}@1'

    def binding(self, task, spaces, standards=()):
        access=Access.task(task);direct=task.get('execution_mode') in ('direct','conversation')
        ref=None if direct or task.get('domain_pack_ref')=='general-assistant@1.0.0' else self.bootstrap(access)
        available=self.search(access,'',spaces=spaces)['items']
        required=[] if direct else [asset for asset in available if asset['critical'] and asset['standard_ref'] in standards]
        if not direct and SPACE in spaces and 'release-review-rubric@1.0.0' in standards and not required:required=[self.get(access,ref)]
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
        terms=tokens(query);has_query=bool(query.strip())
        from .ontology import expand
        semantic_sources=set(expand(self,access,query)['source_refs']) if has_query else set()
        semantic_ids={ref.rsplit('@',1)[0] for ref in semantic_sources}
        with self.store.connect() as db:
            # No content/identities from unauthorized rows reach the ranker or manifest.
            matched=set()
            expression=None
            if terms:
                expression=' OR '.join('"'+term+'"' for term in terms)
                hits=db.execute('''SELECT a.id,a.version FROM asset_search s JOIN asset_versions a
                    ON a.tenant=s.tenant AND a.id=s.id AND a.version=s.version
                    WHERE s.terms MATCH ? AND a.tenant=? AND a.project=? AND a.environment=?
                    AND (a.visibility='PROJECT' OR a.owner=?)''',
                    (expression,access.tenant,access.project,access.environment,access.principal)).fetchall()
                matched={(r['id'],int(r['version'])) for r in hits}
            row_scope=scope+' AND space=?';row_params=[*params,SPACE]
            if has_query:
                candidates=["kind='PREFERENCE'"]
                if for_context:candidates.append("json_extract(data,'$.critical')=1")
                if expression:
                    candidates.append('id IN (SELECT id FROM asset_search WHERE terms MATCH ? AND tenant=?)')
                    row_params.extend([expression,access.tenant])
                    # A corrupt body may no longer agree with its FTS row.
                    # Include literal matches for integrity diagnostics, then
                    # verify their hashes before allowing any retrieval hit.
                    candidates.append('instr(lower(data),?)>0')
                    row_params.append(query.strip().lower())
                if semantic_ids:
                    candidates.append('id IN ('+','.join('?' for _ in semantic_ids)+')')
                    row_params.extend(sorted(semantic_ids))
                # Required context assets are few; inspect their flag without
                # decoding every unrelated historical content body in Python.
                row_scope+=' AND ('+' OR '.join(candidates)+')'
            rows=db.execute('SELECT * FROM asset_versions WHERE '+row_scope+' ORDER BY id,version DESC',row_params).fetchall()
        chosen=[];excluded=[];seen=set();now=time.time()
        for row in rows:
            if row['kind']=='ONTOLOGY':continue
            ref=f"{row['id']}@{row['version']}"
            # Ontology paths bind exact evidence versions. Never silently swap
            # these for the newest version or discard them during id deduping.
            if row['id'] in semantic_ids:
                if ref not in semantic_sources:continue
            elif row['id'] in seen:continue
            asset=self._record(row)
            reason=None
            if digest(json.loads(row['data']))!=row['hash']:reason='content-hash-mismatch'
            elif row['status']!='PUBLISHED':reason='not-published'
            elif not asset['effective_at']<=now<asset['effective_until']:reason='not-effective-or-expired'
            if reason:
                excluded.append({'ref':asset['ref'],'reason':reason,'critical':asset['critical']})
                continue
            seen.add(row['id'])
            if has_query and (row['id'],row['version']) not in matched and asset['ref'] not in semantic_sources and asset['kind']!='PREFERENCE' and not (for_context and asset['critical']):
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
