"""A complete task export shares one read snapshot across all turns and edits."""
from datetime import datetime,timezone
import hashlib
import io
import json
import math
import time
import zipfile

from . import __version__,exports
from .contracts import PolicyDenied,identifier
from .structured import parse_json


def _line(value):return (json.dumps(value,ensure_ascii=False)+'\n').encode('utf-8')
def _hash(raw):return hashlib.sha256(raw).hexdigest()
def _integer(value,minimum=0):return type(value) is int and value>=minimum
def _timestamp(value):return type(value) in (int,float) and math.isfinite(value) and value>=0


def edit_markdown(identity,edits):
    yield '# 消息修改记录\n\n任务编号：'+identity+'\n\n'
    found=False
    for edit in edits:
        found=True
        yield '## 第 '+str(edit['turn'])+' 轮 · 第 '+str(edit['revision'])+' 次修改\n\n保存时间：'+datetime.fromtimestamp(edit['saved_at'],timezone.utc).isoformat()+'\n\n'
        for label,key in (('修改前','before'),('修改后','after')):
            yield '### '+label+'\n\n'+'\n'.join('    '+line for line in edit[key].split('\n'))+'\n\n'
    if not found:yield '没有保存过消息修改。\n'


def _jsonl(raw):
    for line in io.BytesIO(raw):yield parse_json(line.decode('utf-8'))


def bundle_files(app,identity,*,store=None):
    from .task_conversations import TaskConversations
    service=TaskConversations(app,store);store=service.store;files={};total=0
    def bounded(raw):
        nonlocal total
        total+=len(raw)
        if total>exports.MAX_BYTES:raise exports.ExportError('完整任务包超过 256 MiB，请分别导出对话文档和各轮记录')
        return raw
    def lines(parts):
        output=io.BytesIO()
        for raw in parts:output.write(bounded(raw))
        return output.getvalue()
    with store.read_snapshot() as db:
        captured=time.time();view=service.view(identity,db=db,live=False);identity=view['id']
        scope={'tenant_id':app.tenant,'workspace_id':app.workspace['id'],'project_id':app.workspace['project_id'],'principal':app.principal}
        view.update(export_snapshot={'captured_at':captured,'revision':view['revision']},export_scope=scope)
        edits=[]
        if store._optional_table_available(db,'task_message_edits'):
            edits=db.execute('SELECT turn,revision,prior_content,content,created FROM task_message_edits WHERE tenant=? AND task_id=? ORDER BY turn,revision',(app.tenant,identity))
        files['edit-history.jsonl']=lines(_line({'turn':r['turn'],'revision':r['revision'],'before':r['prior_content'],'after':r['content'],'saved_at':r['created']}) for r in edits)
        files['edit-history.md']=lines(part.encode('utf-8') for part in edit_markdown(identity,_jsonl(files['edit-history.jsonl'])))
        def authorize(run):
            app.assert_run_access(run)
            if run['task']['principal']!=app.principal:raise PolicyDenied('conversation turn outside scope')
        def runs():
            for turn in view['turns']:
                if turn['checkpoint_version'] is None:continue
                snapshot=exports.capture_run(store,app.tenant,turn['run_id'],authorize=authorize,principal=app.principal,db=db,captured_at=captured)
                # SQLite's JSON projection rounds REAL timestamps. Use the full
                # cancellation row from the same transaction in both records.
                turn['cancellation']=snapshot['run'].get('cancellation')
                if turn['run_id']==view['active_run_id']:view['cancellation']=turn['cancellation']
                yield _line({'turn':turn['number'],**snapshot})
        files['runs.jsonl']=lines(runs())
        files['conversation.json']=bounded(exports._json(view))
        files['conversation.md']=bounded(exports.conversation_markdown(view).encode('utf-8'))
    manifest={'format':exports.TASK_FORMAT,'format_version':1,'app_version':__version__,'captured_at':captured,'scope':scope,
              'snapshot':{'task_id':identity,'conversation_revision':view['revision'],'status':view['status'],'turn_count':len(view['turns']),
                          'run_count':sum(t['checkpoint_version'] is not None for t in view['turns']),'edit_count':sum(t['edit_revision'] for t in view['turns'])},
              'files':{name:{'bytes':len(raw),'sha256':_hash(raw)} for name,raw in files.items()}}
    for human,source in (('conversation.md','conversation.json'),('edit-history.md','edit-history.jsonl')):manifest['files'][human]['source_sha256']=_hash(files[source])
    verify_task(manifest,files)
    files['manifest.json']=exports._json(manifest)
    return files


def zip_bundle(app,identity,*,store=None):
    files=bundle_files(app,identity,store=store);output=io.BytesIO()
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as archive:
        for name,raw in files.items():archive.writestr(name,raw)
    return output.getvalue()


def verify_task(manifest,files):
    """Cross-check saved representations; do not rerender historical Markdown."""
    fail=lambda message:exports.ExportError('任务导出'+message)
    view=parse_json(files['conversation.json'].decode('utf-8'));scope=manifest['scope'];boundary=manifest['snapshot']
    if (not isinstance(view,dict) or type(view.get('snapshot_format')) is not int or view['snapshot_format']!=1 or not isinstance(scope,dict)
            or set(scope)!={'tenant_id','workspace_id','project_id','principal'} or any(not isinstance(v,str) or not v for v in scope.values())
            or view.get('export_scope')!=scope or not _integer(view.get('revision'),1) or not isinstance(view.get('status'),str)
            or not isinstance(view.get('export_snapshot'),dict) or not _timestamp(view['export_snapshot'].get('captured_at'))
            or not _integer(view['export_snapshot'].get('revision'),1)
            or view.get('export_snapshot')!={'captured_at':manifest['captured_at'],'revision':view['revision']}
            or not isinstance(view.get('turns'),list) or not view['turns']):raise fail('对话快照无效')
    identity=identifier(view['id']);turns=view['turns'];run_ids=set();expected_runs=[]
    for number,turn in enumerate(turns,1):
        if (not isinstance(turn,dict) or type(turn.get('number')) is not int or turn['number']!=number
                or not isinstance(turn.get('content'),str) or type(turn.get('cancelled_queue')) is not bool
                or not _integer(turn.get('event_seq')) or not _integer(turn.get('edit_revision'))
                or not isinstance(turn.get('status'),str)):raise fail('轮次序列或内容无效')
        run_id=identifier(turn['run_id'])
        if run_id in run_ids or number==1 and run_id!=identity:raise fail('运行身份重复或与根任务不一致')
        run_ids.add(run_id)
        if turn['checkpoint_version'] is not None:
            if not _integer(turn['checkpoint_version']) or turn['cancelled_queue']:raise fail('轮次执行边界无效')
            expected_runs.append(number)
        elif turn['reply'] is not None or turn['event_seq']!=0 or turn.get('preview') is not None:raise fail('未执行轮次混入执行内容')
        if turn['cancelled_queue'] and turn['status']!='CANCELLED':raise fail('取消轮次状态不一致')
    if not expected_runs or expected_runs[0]!=1:raise fail('缺少根任务运行记录')
    actual_runs=[]
    for record in _jsonl(files['runs.jsonl']):
        if not isinstance(record,dict) or not _integer(record.get('turn'),1) or record['turn']>len(turns):raise fail('运行记录格式无效')
        number=record['turn'];turn=turns[number-1];run=record['run'];events=record['events'];actual_runs.append(number)
        if (not isinstance(run,dict) or not _integer(run.get('version')) or run.get('run_id')!=turn['run_id']
                or run.get('tenant_id')!=scope['tenant_id'] or run['task']['project_id']!=scope['project_id'] or run['task']['principal']!=scope['principal']
                or run['task']['goal']!=turn['content'] or run['version']!=turn['checkpoint_version'] or run['status']!=turn['status']
                or run['report']!=turn['reply'] or run.get('cancellation')!=turn.get('cancellation') or run.get('interruption')!=turn.get('interruption')
                or not _timestamp(record['captured_at']) or record['captured_at']!=manifest['captured_at'] or not isinstance(record['evidence'],dict) or not isinstance(record['context_manifests'],list)
                or not isinstance(events,list) or len(events)!=turn['event_seq']
                or any(not isinstance(e,dict) or type(e.get('seq')) is not int or e['seq']!=i for i,e in enumerate(events,1))):raise fail('运行内容、状态或事件边界不一致')
        context=run['task'].get('conversation_context')
        if number>1 and (not isinstance(context,dict) or context.get('task_id')!=identity or context.get('turn')!=number):raise fail('运行不属于对应对话轮次')
    if actual_runs!=expected_runs:raise fail('缺少、重复或混入运行记录')
    versions={};last_text={};last_time={};previous=(0,0);edit_count=0
    for edit in _jsonl(files['edit-history.jsonl']):
        if (not isinstance(edit,dict) or set(edit)!={'turn','revision','before','after','saved_at'}
                or not _integer(edit.get('turn'),2) or edit['turn']>len(turns) or not _integer(edit.get('revision'),1)
                or any(not isinstance(edit[k],str) for k in ('before','after')) or not _timestamp(edit['saved_at'])):raise fail('修改记录格式无效')
        number=edit['turn'];version=edit['revision'];position=(number,version)
        if position<=previous or version!=versions.get(number,0)+1 or number in last_text and edit['before']!=last_text[number]:raise fail('修改历史断裂或顺序不一致')
        versions[number]=version;last_text[number]=edit['after'];last_time[number]=edit['saved_at'];previous=position;edit_count+=1
    for turn in turns:
        number=turn['number']
        if turn['edit_revision']!=versions.get(number,0) or number in versions and (last_text[number]!=turn['content'] or last_time[number]!=turn['edited_at']):raise fail('当前消息与修改历史不一致')
    expected={'task_id':identity,'conversation_revision':view['revision'],'status':view['status'],'turn_count':len(turns),'run_count':len(actual_runs),'edit_count':edit_count}
    if boundary!=expected or any(type(boundary[k]) is not int for k in ('conversation_revision','turn_count','run_count','edit_count')):raise fail('清单与对话边界不一致')
    for human,source in (('conversation.md','conversation.json'),('edit-history.md','edit-history.jsonl')):
        if manifest['files'][human].get('source_sha256')!=_hash(files[source]):raise fail('文档来源与记录不一致')
