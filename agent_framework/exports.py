"""One read snapshot, non-overwriting export folders and verifiable bundles."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path
import stat
import time
import zipfile
import zlib

from . import __version__
from .contracts import canonical
from .file_durability import sync_directory as _sync_directory
from .structured import parse_json

FORMAT='agent-framework-run-export'
TASK_FORMAT='agent-framework-task-export'
MARKER='.export-in-progress'
REQUIRED={'result.json','events.jsonl','evidence.json','context-manifests.json'}
TASK_REQUIRED={'conversation.json','conversation.md','edit-history.jsonl','edit-history.md','runs.jsonl'}
MAX_BYTES=256*1024*1024
MAX_MANIFEST_BYTES=65536
ALLOWED=REQUIRED|TASK_REQUIRED|{'report.md','manifest.json'}


class ExportError(ValueError):pass


def artifact_markdown(report):
    if 'content' in report or 'answer' in report:
        text='# '+report.get('title',report.get('question','任务结果'))+'\n\n'+report.get('content',report.get('answer',''))
        if report.get('citations'):
            text+='\n\n## 来源\n\n'
            for citation in report['citations']:
                text+='- '+citation['asset_ref']+' ['+citation['evidence_ref']+']\n'
                if citation.get('quote'):text+='\n'+ '\n'.join('> '+line for line in citation['quote'].splitlines())+'\n'
        return text+'\n\n'+'\n'.join(report.get('limitations',[]))+'\n'
    text='# '+report['title']+'\n\n'
    text+='\n\n'.join('## '+key+'\n\n'+value for key,value in report['sections'].items())
    text+='\n\n## 事实引用\n\n'+json.dumps(report['claims'],ensure_ascii=False,indent=2)+'\n'
    if report.get('limitations'):text+='\n## 限制与说明\n\n'+'\n'.join(report['limitations'])+'\n'
    return text


def capture_run(store,tenant,run_id,*,authorize=None,principal=None,db=None,captured_at=None):
    with store.read_snapshot(db) as db:
        captured=time.time() if captured_at is None else captured_at;run=store.result(tenant,run_id,db=db)
        if authorize:authorize(run)
        return {'run':run,'captured_at':captured,'events':store.events(tenant,run_id,db=db),
                'evidence':store.evidence(run,db=db),
                'context_manifests':store.contexts(tenant,run_id,db=db) if principal is None or run['task']['principal']==principal else []}


def report_markdown(run):
    text=artifact_markdown(run['report'])
    if run['status']!='SUCCEEDED':
        text='> 运行状态：'+run['status']+'。以下为已保存内容，不能作为已完成结果。\n\n'+text
    return text


def conversation_markdown(view):
    captured=view.get('export_snapshot',{}).get('captured_at',time.time())
    name=view.get('task_name',{}).get('name','')
    title=''.join('\\'+c if c in '\\`*_{}[]<>#' else c for c in name) if name else view['goal']
    text='# '+title+'\n\n'+('原始任务要求：'+view['goal']+'\n\n' if name else '')+'任务状态：'+view['status']+'\n\n导出时间：'+datetime.fromtimestamp(captured,timezone.utc).isoformat()+'\n\n'
    if view.get('cleanup_review'):
        text+='运行环境待检查：模型进程清理未确认，后续消息暂停。检查并明确确认后才能继续；这不改变原轮次结果。\n\n'
    for turn in view['turns']:
        text+='## 你 · 第 '+str(turn['number'])+' 轮\n\n'+turn['content']+'\n\n'
        if turn.get('edit_revision'):text+='（排队期间已修改，版本 '+str(turn['edit_revision'])+'）\n\n'
        if turn.get('retry_of'):text+='重试来源：第 '+str(turn['retry_of'])+' 轮。\n\n'
        if turn.get('retried_by'):text+='重试记录：第 '+str(turn['retried_by'])+' 轮。\n\n'
        if turn['cancelled_queue']:text+='（已取消排队，未执行）\n\n';continue
        text+='## '+(view['agent'].get('name') or '智能体')+'\n\n本轮状态：'+turn['status']+'\n\n'
        if turn['status']!='SUCCEEDED':text+='（本轮未完成，以下为已保存内容）\n\n'
        if turn['reply']:text+=artifact_markdown(turn['reply'])+'\n\n'
        elif turn.get('preview'):text+=turn['preview']['content']+'\n\n'
        if turn['error']:text+='说明：'+turn['error']+'\n\n'
        elif not turn['reply'] and not turn.get('preview'):text+='等待回复\n\n'
        if turn.get('cancellation',{}):
            request=turn['cancellation']
            if request['pending']:text+='停止请求已保存；'+('停止处理受阻，请重试停止。' if request['error'] else '等待当前操作结束并核对后停止。')+'\n\n'
    return text


def _json(value):return (json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode('utf-8')


def bundle_files(snapshot):
    run=snapshot['run'];events=snapshot['events']
    files={'result.json':_json(run),'events.jsonl':''.join(json.dumps(event,ensure_ascii=False)+'\n' for event in events).encode('utf-8'),
           'evidence.json':_json(snapshot['evidence']),'context-manifests.json':_json(snapshot['context_manifests'])}
    if run['report']:files['report.md']=report_markdown(run).encode('utf-8')
    if sum(map(len,files.values()))>MAX_BYTES:raise ExportError('完整导出超过 256 MiB，请使用运行结果和运行记录的分项导出')
    manifest={'format':FORMAT,'format_version':1,'app_version':__version__,'captured_at':snapshot['captured_at'],
              'snapshot':{'tenant_id':run['tenant_id'],'run_id':run['run_id'],'run_version':run['version'],'status':run['status'],'event_seq':events[-1]['seq'] if events else 0},
              'files':{name:{'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()} for name,raw in files.items()}}
    if run['report']:manifest['files']['report.md']['source_sha256']=hashlib.sha256(canonical(run['report']).encode('utf-8')).hexdigest()
    return {**files,'manifest.json':_json(manifest)}


def zip_bundle(snapshot):
    output=io.BytesIO()
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as archive:
        for name,raw in bundle_files(snapshot).items():archive.writestr(name,raw)
    return output.getvalue()


def _write_file(path,raw,*,created=None):
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as stream:
        if created is not None:
            info=os.fstat(stream.fileno());created.append((path,(info.st_dev,info.st_ino)))
        stream.write(raw);stream.flush();os.fsync(stream.fileno())


def _export_parents(path):
    missing=[];ancestor=path
    while not ancestor.exists():
        missing.append(ancestor);ancestor=ancestor.parent
    path.mkdir(parents=True,exist_ok=True)
    # Preserve automatic nested-parent creation, including the new names in
    # each ancestor. The nearest pre-existing ancestor finishes that chain.
    for directory in missing+[ancestor]:_sync_directory(directory)


def _remove_created(path,identity):
    try:info=path.lstat()
    except FileNotFoundError:return True
    if (info.st_dev,info.st_ino)!=identity:return False
    path.unlink();return True


def _cleanup_directory(target,identity,created):
    try:info=target.lstat()
    except FileNotFoundError:return
    if (info.st_dev,info.st_ino)!=identity:return
    for path,file_identity in reversed(created):
        if path.name!=MARKER and not _remove_created(path,file_identity):return
    _sync_directory(target)
    for path,file_identity in created:
        if path.name==MARKER and not _remove_created(path,file_identity):return
    _sync_directory(target)
    target.rmdir()  # Extra files belong to their writer and are never removed.
    _sync_directory(target.parent)


def write_directory(snapshot,directory):
    target=Path(directory).expanduser().absolute()
    if target.exists() or target.is_symlink():raise ExportError('导出目录已存在，请选择新目录；已有内容未改动')
    files=bundle_files(snapshot);_export_parents(target.parent)
    try:target.mkdir(mode=0o700)
    except FileExistsError:raise ExportError('导出目录已存在，请选择新目录；已有内容未改动') from None
    info=target.stat();identity=(info.st_dev,info.st_ino);created=[];data_durable=False
    try:
        _write_file(target/MARKER,b'Export incomplete until this marker is removed.\n',created=created)
        _sync_directory(target);_sync_directory(target.parent)
        for name,raw in files.items():_write_file(target/name,raw,created=created)
        _sync_directory(target);_sync_directory(target.parent)
        data_durable=True
        if not _remove_created(*created[0]):raise ExportError('导出标记已被其他进程替换，目录内容已保留')
        _sync_directory(target)
    except BaseException:
        if not data_durable:
            try:_cleanup_directory(target,identity,created)
            except OSError:pass  # Leave an incomplete export if cleanup fails.
        raise
    return str(target.resolve())


def _entry_sizes(sizes):
    names=set(sizes)
    if MARKER in names:raise ExportError('导出未完成或缺少清单')
    if 'manifest.json' not in names:raise ExportError('导出未完成或缺少清单')
    if names&TASK_REQUIRED:
        if names!=TASK_REQUIRED|{'manifest.json'}:raise ExportError('导出文件与清单不一致')
    elif not REQUIRED<=names or names-(REQUIRED|{'report.md','manifest.json'}):raise ExportError('导出文件与清单不一致')
    if not 0<sizes['manifest.json']<=MAX_MANIFEST_BYTES:raise ExportError('导出清单过大或为空')
    if any(size<0 or size>MAX_BYTES for name,size in sizes.items() if name!='manifest.json') or sum(size for name,size in sizes.items() if name!='manifest.json')>MAX_BYTES:
        raise ExportError('导出内容过大')


def _read_manifest(raw,sizes):
    manifest=parse_json(raw.decode('utf-8'))
    if not isinstance(manifest,dict) or manifest.get('format') not in {FORMAT,TASK_FORMAT} or type(manifest.get('format_version')) is not int or manifest['format_version']!=1:
        raise ExportError('不支持的导出格式')
    if (manifest['format']==TASK_FORMAT)!=(set(sizes)==TASK_REQUIRED|{'manifest.json'}):raise ExportError('导出格式与文件集合不一致')
    if type(manifest.get('captured_at')) not in (int,float) or not math.isfinite(manifest['captured_at']) or manifest['captured_at']<0:
        raise ExportError('导出时间无效')
    listed=manifest['files']
    if not isinstance(listed,dict) or set(listed)!=(set(sizes)-{'manifest.json'}):raise ExportError('导出文件与清单不一致')
    for name,record in listed.items():
        if (not isinstance(record,dict) or type(record.get('bytes')) is not int or record['bytes']!=sizes[name]
                or not isinstance(record.get('sha256'),str) or len(record['sha256'])!=64
                or any(char not in '0123456789abcdef' for char in record['sha256'])):
            raise ExportError('导出文件校验失败：'+name)
    return manifest


def _read_exact(stream,size,name):
    raw=stream.read(size+1)
    if len(raw)!=size:raise ExportError('导出文件校验失败：'+name)
    return raw


@contextmanager
def _regular_file(path):
    # A path may be replaced after directory inspection. Nonblocking open plus
    # descriptor inspection also rejects pipes without waiting for a writer.
    flags=os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0)
    with os.fdopen(os.open(path,flags),'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):raise ExportError('导出来源包含非普通文件')
        yield stream


def _directory_files(source):
    sizes={}
    with os.scandir(source) as entries:
        for entry in entries:
            if entry.name==MARKER:raise ExportError('导出未完成或缺少清单')
            if entry.name not in ALLOWED:raise ExportError('导出文件与清单不一致')
            info=entry.stat(follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):raise ExportError('导出包含非普通文件')
            sizes[entry.name]=info.st_size
    _entry_sizes(sizes)
    def read(name):
        with _regular_file(source/name) as stream:
            info=os.fstat(stream.fileno())
            if info.st_size!=sizes[name]:raise ExportError('导出文件校验失败：'+name)
            return _read_exact(stream,sizes[name],name)
    raw=read('manifest.json');manifest=_read_manifest(raw,sizes)
    return manifest,{'manifest.json':raw,**{name:read(name) for name in manifest['files']}}


def _archive_files(source):
    try:
        with _regular_file(source) as stream,zipfile.ZipFile(stream) as archive:
            infos=archive.infolist();names=[item.filename for item in infos]
            if len(names)!=len(set(names)):raise ExportError('导出 ZIP 条目重复')
            _entry_sizes({item.filename:item.file_size for item in infos})
            for item in infos:
                mode=(item.external_attr>>16)&0o170000
                if (item.is_dir() or mode not in (0,stat.S_IFREG) or item.flag_bits&1
                        or item.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED)):
                    raise ExportError('导出 ZIP 包含不支持的文件类型、压缩方式或加密内容')
            sizes={item.filename:item.file_size for item in infos}
            def read(name):
                with archive.open(name) as stream:return _read_exact(stream,sizes[name],name)
            raw=read('manifest.json');manifest=_read_manifest(raw,sizes)
            return manifest,{'manifest.json':raw,**{name:read(name) for name in manifest['files']}}
    except (zipfile.BadZipFile,RuntimeError,NotImplementedError,EOFError,zlib.error) as exc:
        raise ExportError('无法读取导出 ZIP，文件可能已损坏') from exc


def verify_export(path):
    """Read only; validate metadata before payloads without extracting an archive."""
    source=Path(path).expanduser().absolute()
    if source.is_symlink():raise ExportError('导出来源不能为符号链接')
    try:
        manifest,files=_directory_files(source) if source.is_dir() else _archive_files(source)
        listed=manifest['files']
        for name,record in listed.items():
            if record['sha256']!=hashlib.sha256(files[name]).hexdigest():raise ExportError('导出文件校验失败：'+name)
        if manifest['format']==TASK_FORMAT:
            from .task_exports import verify_task
            verify_task(manifest,files)
            return {'valid':True,'manifest':manifest}
        run=parse_json(files['result.json'].decode('utf-8'));events=[parse_json(line) for line in files['events.jsonl'].decode('utf-8').splitlines()]
        if not isinstance(run,dict) or type(run.get('version')) is not int or run['version']<0 or any(not isinstance(event,dict) or type(event.get('seq')) is not int for event in events):raise ExportError('导出运行版本或事件格式无效')
        expected={'tenant_id':run['tenant_id'],'run_id':run['run_id'],'run_version':run['version'],'status':run['status'],'event_seq':events[-1]['seq'] if events else 0}
        if manifest['snapshot']!=expected or bool(run['report'])!=('report.md' in files):raise ExportError('导出状态与快照边界不一致')
        if any(event['seq']!=index for index,event in enumerate(events,1)):raise ExportError('导出事件序列不完整')
        report_source=listed.get('report.md',{}).get('source_sha256')
        if report_source is not None and report_source!=hashlib.sha256(canonical(run['report']).encode('utf-8')).hexdigest():raise ExportError('导出报告与运行结果不一致')
        if not isinstance(parse_json(files['evidence.json'].decode('utf-8')),dict) or not isinstance(parse_json(files['context-manifests.json'].decode('utf-8')),list):raise ExportError('导出证据或上下文格式无效')
        return {'valid':True,'manifest':manifest}
    except (KeyError,TypeError,UnicodeError,ValueError,OverflowError,RecursionError) as exc:
        if isinstance(exc,ExportError):raise
        raise ExportError('导出清单或内容格式无效') from exc
