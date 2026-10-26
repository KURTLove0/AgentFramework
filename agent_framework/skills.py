"""Workspace-scoped, immutable Agent Skills packages and standard ZIP interchange."""
from copy import deepcopy
import base64
import binascii
from importlib.resources import files as resources
import io
import json
from pathlib import PurePosixPath
import re
import stat
import time
from uuid import uuid4
import zipfile

from .contracts import canonical,digest,identifier,PolicyDenied
from .runtime_config import ConfigConflict

MAX_FILES=64
MAX_PACKAGE=256_000
MAX_FILE=96_000
SPEC='https://agentskills.io/specification'


def valid_name(name):
    return (isinstance(name,str) and 1<=len(name)<=64 and name==name.strip() and not name.startswith('-')
            and not name.endswith('-') and '--' not in name and all(c.islower() or c.isdigit() or c=='-' for c in name))


def safe_path(path):
    if (not isinstance(path,str) or not path or len(path)>240 or any(ord(c)<32 for c in path)
            or '\\' in path or ':' in path or path.startswith('/') or any(p in ('','.','..') for p in path.split('/'))):
        raise ValueError('Skill 文件必须使用无越界片段的相对路径')
    return str(PurePosixPath(path))


def parse_skill(source,folder):
    # Full YAML parser, safe constructors, no aliases, duplicate keys or executable tags.
    import yaml
    class Loader(yaml.SafeLoader):
        def compose_node(self,parent,index):
            if self.check_event(yaml.AliasEvent):raise ValueError('Skill YAML 不支持别名引用')
            return super().compose_node(parent,index)
        def construct_mapping(self,node,deep=False):
            if not isinstance(node,yaml.MappingNode):raise ValueError('Skill YAML 须为映射')
            out={}
            for key,value in node.value:
                k=self.construct_object(key,deep=deep)
                if not isinstance(k,str) or k in out:raise ValueError('Skill YAML 字段须为唯一字符串')
                out[k]=self.construct_object(value,deep=deep)
            return out
    if not isinstance(source,str) or len(source.encode())>MAX_FILE or '\x00' in source:raise ValueError('SKILL.md 内容无效或超过文件预算')
    match=re.match(r'\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)(.*)\Z',source,re.S)
    if not match:raise ValueError('SKILL.md 必须以 YAML frontmatter 开始（--- 分隔）')
    if len(match[1].encode())>16000:raise ValueError('Skill 元数据超过 16 KB')
    try:meta=yaml.load(match[1],Loader=Loader)
    except (yaml.YAMLError,RecursionError) as exc:raise ValueError('Skill YAML 格式无效') from exc
    allowed={'name','description','license','compatibility','metadata','allowed-tools'}
    if not isinstance(meta,dict) or not {'name','description'}<=set(meta) or set(meta)-allowed:raise ValueError('Skill 元数据需要 name、description，且只能使用标准字段')
    if not valid_name(meta['name']) or meta['name']!=folder:raise ValueError('Skill name 须为 1–64 位小写字母、数字或连字符，与目录同名，不能有连续或首尾连字符')
    if not isinstance(meta['description'],str) or not meta['description'].strip() or not 1<=len(meta['description'])<=1024:raise ValueError('Skill description 需要 1–1024 个字符')
    for key in ('license','compatibility','allowed-tools'):
        if key in meta and (not isinstance(meta[key],str) or not meta[key].strip() or len(meta[key])>(500 if key=='compatibility' else 4000)):
            raise ValueError('Skill '+key+' 格式或长度无效')
    if 'metadata' in meta and (not isinstance(meta['metadata'],dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in meta['metadata'].items())):
        raise ValueError('Skill metadata 必须为字符串键值映射')
    body=match[2].strip();warnings=[]
    if not body:warnings.append('SKILL.md 正文为空')
    if len(source.splitlines())>500:warnings.append('建议将超过 500 行的细节移到 references/ 并按需读取')
    if meta.get('allowed-tools'):warnings.append('allowed-tools 是工具使用意图，不授予权限；实际调用仍由已注册能力和网关控制')
    return meta,body,warnings


def file_bytes(item):
    if not isinstance(item,dict) or set(item)!={'encoding','content'} or not isinstance(item['content'],str):raise ValueError('资源文件需要 encoding 和 content')
    if item['encoding']=='utf-8':return item['content'].encode()
    if item['encoding']=='base64':
        try:return base64.b64decode(item['content'],validate=True)
        except (ValueError,binascii.Error) as exc:raise ValueError('资源 Base64 无效') from exc
    raise ValueError('资源仅支持 UTF-8 或 Base64')


def normalize_package(folder,files):
    if not valid_name(folder):raise ValueError('Skill 目录名称无效')
    if not isinstance(files,dict) or not 1<=len(files)<=MAX_FILES:raise ValueError('Skill 包需要 1–64 个文件')
    normalized={};total=0;seen=set()
    for path,item in files.items():
        safe_path(path)
        if path.casefold() in seen:raise ValueError('Skill 文件路径不能重复（忽略大小写）')
        seen.add(path.casefold());raw=file_bytes(item);total+=len(raw)
        if len(raw)>MAX_FILE or total>MAX_PACKAGE:raise ValueError('Skill 文件或包超过大小预算（单文件 96 KB，包 256 KB）')
        try:content=raw.decode('utf-8');encoding='utf-8'
        except UnicodeDecodeError:content=base64.b64encode(raw).decode();encoding='base64'
        normalized[path]={'encoding':encoding,'content':content,'size':len(raw),'hash':digest(raw.hex())}
    if 'SKILL.md' not in normalized or normalized['SKILL.md']['encoding']!='utf-8':raise ValueError('Skill 包根目录需要 UTF-8 编码的 SKILL.md')
    meta,body,warnings=parse_skill(normalized['SKILL.md']['content'],folder)
    # Markdown resource links must remain inside the portable package.
    for target in re.findall(r'\]\(([^)\s]+)(?:\s+[^)]*)?\)',body):
        if re.match(r'[A-Za-z][A-Za-z0-9+.-]*:',target) or target.startswith('#'):continue
        target=target.split('#')[0]
        if target.startswith('./'):target=target[2:]
        safe_path(target)
        if target not in normalized:raise ValueError('Skill 引用的文件不存在：'+target)
    package={'format':'agent-skills@1','name':folder,'metadata':meta,'body':body,'files':normalized}
    return {**package,'hash':digest(package)},warnings


def validate_frozen(package):
    if not isinstance(package,dict):raise ValueError('Skill 包快照无效')
    body={k:v for k,v in package.items() if k!='hash'}
    if digest(body)!=package.get('hash'):raise ValueError('Skill 包摘要不匹配')
    rebuilt,_=normalize_package(package['name'],{p:{k:v[k] for k in ('encoding','content')} for p,v in package['files'].items()})
    if rebuilt!=package:raise ValueError('Skill 包内容与元数据不一致')


def import_zip(encoded):
    if not isinstance(encoded,str) or len(encoded)>1_000_000:raise ValueError('ZIP 大小无效')
    try:raw=base64.b64decode(encoded,validate=True)
    except (ValueError,binascii.Error) as exc:raise ValueError('ZIP Base64 无效') from exc
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries=archive.infolist()
            if len(entries)>MAX_FILES*2:raise ValueError('ZIP 文件数过多')
            folder=None;out={};total=0
            for info in entries:
                path=info.filename.rstrip('/') if info.is_dir() else info.filename;safe_path(path)
                mode=info.external_attr>>16
                if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR)):raise ValueError('ZIP 不支持符号链接或特殊文件')
                if info.is_dir():continue
                parts=path.split('/',1)
                if len(parts)!=2:raise ValueError('ZIP 须包含一个与 Skill name 同名的顶层目录')
                if folder is None:folder=parts[0]
                if parts[0]!=folder:raise ValueError('ZIP 只能包含一个 Skill 目录')
                if parts[1] in out:raise ValueError('ZIP 文件路径重复')
                total+=info.file_size
                if info.file_size>MAX_FILE or total>MAX_PACKAGE:raise ValueError('ZIP 解压内容超过预算')
                data=archive.read(info)
                out[parts[1]]={'encoding':'base64','content':base64.b64encode(data).decode()}
            normalize_package(folder,out)
            return folder,out
    except (zipfile.BadZipFile,RuntimeError,NotImplementedError) as exc:raise ValueError('ZIP 内容无效或加密') from exc


def export_zip(package):
    validate_frozen(package);buffer=io.BytesIO()
    with zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as archive:
        for path,item in sorted(package['files'].items()):archive.writestr(package['name']+'/'+path,file_bytes({k:item[k] for k in ('encoding','content')}))
    return buffer.getvalue()


class SkillRegistry:
    def __init__(self,store,tenant,workspace):
        self.store=store;self.scope=(tenant,workspace)
        with store.connect() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS skill_heads(tenant TEXT,workspace TEXT,id TEXT,name TEXT,revision INTEGER,version INTEGER,archived INTEGER,builtin INTEGER,updated REAL,PRIMARY KEY(tenant,workspace,id),UNIQUE(tenant,workspace,name));
            CREATE TABLE IF NOT EXISTS skill_versions(tenant TEXT,workspace TEXT,id TEXT,version INTEGER,status TEXT,hash TEXT,data TEXT,created REAL,PRIMARY KEY(tenant,workspace,id,version));
            CREATE TABLE IF NOT EXISTS skill_events(tenant TEXT,workspace TEXT,id TEXT,seq INTEGER,kind TEXT,data TEXT,created REAL,PRIMARY KEY(tenant,workspace,id,seq));''')
        self.seed()

    def _event(self,db,identity,kind,data):
        seq=db.execute('SELECT COALESCE(MAX(seq),0)+1 FROM skill_events WHERE tenant=? AND workspace=? AND id=?',(*self.scope,identity)).fetchone()[0]
        db.execute('INSERT INTO skill_events VALUES(?,?,?,?,?,?,?)',(*self.scope,identity,seq,kind,canonical(data),time.time()))

    def seed(self):
        root=resources('agent_framework').joinpath('resources','skills')
        for folder in ('release-risk-analysis','source-grounded-answer'):
            identity='skill-builtin-'+folder
            with self.store.connect() as db:
                if db.execute('SELECT 1 FROM skill_heads WHERE tenant=? AND workspace=? AND id=?',(*self.scope,identity)).fetchone():continue
            entry=root.joinpath(folder);files={'SKILL.md':{'encoding':'utf-8','content':entry.joinpath('SKILL.md').read_text()}}
            for f in entry.joinpath('references').iterdir():files['references/'+f.name]={'encoding':'utf-8','content':f.read_text()}
            package,_=normalize_package(folder,files);now=time.time()
            with self.store.transaction() as db:
                if db.execute('SELECT 1 FROM skill_heads WHERE tenant=? AND workspace=? AND id=?',(*self.scope,identity)).fetchone():continue
                db.execute('INSERT INTO skill_heads VALUES(?,?,?,?,?,?,?,?,?)',(*self.scope,identity,folder,1,1,0,1,now))
                db.execute('INSERT INTO skill_versions VALUES(?,?,?,?,?,?,?,?)',(*self.scope,identity,1,'PUBLISHED',package['hash'],canonical(package),now))
                self._event(db,identity,'seeded',{'version':1,'hash':package['hash']})

    def list(self):
        with self.store.connect() as db:ids=[r[0] for r in db.execute('SELECT id FROM skill_heads WHERE tenant=? AND workspace=? ORDER BY builtin,updated DESC',self.scope)]
        return [self.get(i,include_files=False) for i in ids]

    def get(self,identity,version=None,include_files=True):
        identifier(identity)
        if version is not None and (type(version) is not int or version<1):raise ValueError('Skill 版本无效')
        with self.store.connect() as db:
            head=db.execute('SELECT * FROM skill_heads WHERE tenant=? AND workspace=? AND id=?',(*self.scope,identity)).fetchone()
            if not head:raise KeyError('Skill outside workspace')
            versions=db.execute('SELECT version,status,hash,created,data FROM skill_versions WHERE tenant=? AND workspace=? AND id=? ORDER BY version DESC',(*self.scope,identity)).fetchall()
            row=db.execute('SELECT * FROM skill_versions WHERE tenant=? AND workspace=? AND id=? AND version=?',(*self.scope,identity,version or head['version'])).fetchone()
            if not row:raise KeyError('Skill version not found')
        package=json.loads(row['data']);validate_frozen(package)
        if package['hash']!=row['hash']:raise ValueError('Skill 版本摘要不匹配')
        out={'id':identity,'name':head['name'],'revision':head['revision'],'version':row['version'],'status':row['status'],'archived':bool(head['archived']),'builtin':bool(head['builtin']),
             'metadata':package['metadata'],'hash':row['hash'],'versions':[{k:v[k] for k in ('version','status','hash','created')}|{'metadata':json.loads(v['data'])['metadata']} for v in versions],
             'files':[{'path':p,'size':v['size'],'hash':v['hash'],'encoding':v['encoding']} for p,v in package['files'].items()]}
        if include_files:out['package']=package
        return out

    def save(self,data,identity=None):
        if not isinstance(data,dict) or set(data)!={'folder','files','revision'}:raise ValueError('Skill 保存需要 folder、files、revision')
        if type(data['revision']) is not int or data['revision']<0:raise ValueError('Skill 修订号无效')
        package,warnings=normalize_package(data['folder'],data['files']);prior=self.get(identity) if identity else None
        if prior and (prior['builtin'] or prior['archived']):raise ValueError('内置或已归档 Skill 不能编辑，请复制为新 Skill')
        if prior and prior['name']!=package['name']:raise ValueError('Skill 名称用于包标识，编辑时不能更改；请复制创建')
        identity=identity or 'skill-'+uuid4().hex[:16];now=time.time()
        with self.store.transaction() as db:
            head=db.execute('SELECT * FROM skill_heads WHERE tenant=? AND workspace=? AND id=?',(*self.scope,identity)).fetchone()
            if (head['revision'] if head else 0)!=data['revision']:raise ConfigConflict('Skill 已更新，请重新加载')
            collision=db.execute('SELECT id FROM skill_heads WHERE tenant=? AND workspace=? AND name=?',(*self.scope,package['name'])).fetchone()
            if collision and collision[0]!=identity:raise ConfigConflict('当前空间已有同名 Skill')
            version=(head['version'] if head else 0)+1
            db.execute('INSERT OR REPLACE INTO skill_heads VALUES(?,?,?,?,?,?,?,?,?)',(*self.scope,identity,package['name'],data['revision']+1,version,0,0,now))
            db.execute('INSERT INTO skill_versions VALUES(?,?,?,?,?,?,?,?)',(*self.scope,identity,version,'DRAFT',package['hash'],canonical(package),now))
            self._event(db,identity,'saved',{'version':version,'hash':package['hash']})
        return {**self.get(identity),'warnings':warnings}

    def lifecycle(self,identity,revision,operation,version=None):
        current=self.get(identity,version)
        if current['builtin']:raise ValueError('内置 Skill 只读，可导出后复制')
        if type(revision) is not int:raise ValueError('Skill 修订号须为整数')
        if operation not in ('publish','withdraw','archive','restore'):raise ValueError('Skill 操作无效')
        if operation in ('publish','withdraw') and (current['archived'] or current['status']!=('DRAFT' if operation=='publish' else 'PUBLISHED')):raise ConfigConflict('Skill 当前状态不允许此操作')
        with self.store.transaction() as db:
            cur=db.execute('UPDATE skill_heads SET revision=revision+1,archived=?,updated=? WHERE tenant=? AND workspace=? AND id=? AND revision=?',
                           (int(operation=='archive' or current['archived'] and operation!='restore'),time.time(),*self.scope,identity,revision))
            if cur.rowcount!=1:raise ConfigConflict('Skill 已更新，请重新加载')
            if operation in ('publish','withdraw'):db.execute('UPDATE skill_versions SET status=? WHERE tenant=? AND workspace=? AND id=? AND version=?',('PUBLISHED' if operation=='publish' else 'WITHDRAWN',*self.scope,identity,current['version']))
            self._event(db,identity,operation,{'version':current['version'],'hash':current['hash']})
        return self.get(identity,current['version'])

    def resolve(self,binding):
        if not isinstance(binding,dict) or set(binding)!={'skill_id','version','enabled'} or type(binding['enabled']) is not bool:raise ValueError('Skill 绑定字段无效')
        skill=self.get(binding['skill_id'],binding['version'])
        if skill['archived'] or skill['status']!='PUBLISHED':raise ValueError('只能选择当前空间未归档的已发布 Skill 版本')
        return {'ref':skill['id']+'@'+str(skill['version']),'skill_id':skill['id'],'version':skill['version'],'enabled':binding['enabled'],'package':skill['package']}

    def events(self,identity):
        self.get(identity)
        with self.store.connect() as db:return [dict(r)|{'data':json.loads(r['data'])} for r in db.execute('SELECT seq,kind,data,created FROM skill_events WHERE tenant=? AND workspace=? AND id=? ORDER BY seq',(*self.scope,identity))]


def package_catalog(profile):
    return [{'ref':s['ref'],'name':s['package']['name'],'description':s['package']['metadata']['description']} for s in (profile or {}).get('skill_packages',[]) if s['enabled']]
