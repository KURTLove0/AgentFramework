"""Find saved conversation text without hydrating execution or audit records."""
import json


def excerpt(text,needle):
    if not isinstance(text,str):return None
    position=text.lower().find(needle)
    if position<0:return None
    # Unicode lowercase can expand a character (for example İ). Return original
    # text fragments instead of offsets that the browser would interpret as UTF-16.
    length=0;start=end=None
    for index,char in enumerate(text):
        next_length=length+len(char.lower())
        if start is None and next_length>position:start=index
        if next_length>=position+len(needle):end=index+1;break
        length=next_length
    left=max(0,start-64);right=min(len(text),end+64)
    return json.dumps({'before':('…' if left else '')+text[left:start],
                       'match':text[start:end],'after':text[end:right]+('…' if right<len(text) else '')},ensure_ascii=False)


def report_text(raw):
    if not raw:return ''
    try:report=json.loads(raw)
    except (ValueError,TypeError):return ''
    if not isinstance(report,dict):return ''
    for key in ('content','answer'):
        if isinstance(report.get(key),str) and report[key]:return report[key]
    sections=report.get('sections')
    return '\n\n'.join(value for value in sections.values() if isinstance(value,str)) if isinstance(sections,dict) else ''


def matches(app,identities,needle,*,store=None,db=None):
    """One earliest matching message per authorized root; no persistent index."""
    if not needle or not identities:return {}
    store=store or app.control_store;result={};identities=list(dict.fromkeys(identities))
    with store.read_snapshot(db) as db:
        db.create_function('task_text_hit',1,lambda text:excerpt(text,needle),deterministic=True)
        db.create_function('task_reply_text',1,report_text,deterministic=True)
        for offset in range(0,len(identities),300):
            batch=identities[offset:offset+300];slots=','.join('?' for _ in batch)
            rows=db.execute('''WITH turns AS (
                SELECT t.task_id,t.number,t.run_id,t.content,t.state FROM task_conversation_turns t
                  JOIN task_conversations c ON c.tenant=t.tenant AND c.id=t.task_id
                  WHERE t.tenant=? AND c.workspace=? AND c.principal=? AND t.task_id IN ('''+slots+''')
                UNION ALL
                SELECT r.id,1,r.id,json_extract(r.state,'$.task.goal'),'RUNNING' FROM runs r
                  WHERE r.tenant_id=? AND json_extract(r.state,'$.task.project_id')=?
                    AND json_extract(r.state,'$.task.principal')=? AND r.id IN ('''+slots+''')
                    AND NOT EXISTS(SELECT 1 FROM task_conversation_turns t WHERE t.tenant=r.tenant_id AND t.task_id=r.id)
            ), messages AS (
                SELECT task_id,number,run_id,'user' AS role,content AS text FROM turns
                UNION ALL
                SELECT t.task_id,t.number,t.run_id,'assistant',task_reply_text(json_extract(r.state,'$.report'))
                  FROM turns t JOIN runs r ON r.tenant_id=? AND r.id=t.run_id
                  WHERE t.state!='CANCELLED' AND json_extract(r.state,'$.task.project_id')=?
                    AND json_extract(r.state,'$.task.principal')=?
            ), hits AS (
                SELECT task_id,number,run_id,role,task_text_hit(text) AS hit FROM messages
            ), ranked AS (
                SELECT *,ROW_NUMBER() OVER(PARTITION BY task_id ORDER BY number,role DESC) AS position
                  FROM hits WHERE hit IS NOT NULL
            ) SELECT task_id,number,run_id,role,hit FROM ranked WHERE position=1''',
                (app.tenant,app.workspace['id'],app.principal,*batch,
                 app.tenant,app.workspace['project_id'],app.principal,*batch,
                 app.tenant,app.workspace['project_id'],app.principal))
            for row in rows:
                result[row['task_id']]={'turn':row['number'],'run_id':row['run_id'],'role':row['role'],**json.loads(row['hit'])}
    return result
