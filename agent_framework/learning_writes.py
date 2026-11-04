"""Immutable, scoped receipts for reviewed proposal writes.

The receipt and proposal/assets commit together. Reading or replaying a receipt
never substitutes a later writer's proposal for the accepted result.
"""
from copy import deepcopy
import json

from .contracts import canonical, digest, identifier
from .runtime_config import ConfigConflict


def prepare(service, identity, data, operation):
    identifier(identity)
    fields={'revision','output'} if operation=='save' else {'revision','item_ids'}
    if not isinstance(data,dict) or set(data) not in (fields,fields|{'request_id'}):
        raise ValueError('保存需要当前版本与完整提案' if operation=='save' else '沉淀需要当前版本与选定条目')
    body=deepcopy(data);key=body.pop('request_id',None)
    if 'request_id' in data:identifier(key)
    if type(body['revision']) is not int or body['revision']<1:raise ValueError('提案版本必须为正整数')
    if operation=='deposit':
        selected=body['item_ids']
        if not isinstance(selected,list) or not selected or any(not isinstance(x,str) for x in selected) or len(selected)!=len(set(selected)):
            raise ValueError('请至少选择一个不同的沉淀条目')
        body['item_ids']=sorted(selected)
    request={'operation':operation,'proposal_id':identity,**body}
    with service.store.read_snapshot() as db:
        service._assert_workspace_active(db)
        prior=service._get(db,identity)
        accepted=read(service,db,key,request) if key else None
    return body,key,request,accepted,prior


def read(service, db, key, request=None):
    row=db.execute('SELECT request_hash,result,result_hash FROM learning_write_requests WHERE tenant=? AND workspace=? AND principal=? AND request_id=?',(*service._scope(),key)).fetchone()
    if not row:return None
    if request is not None and row['request_hash']!=digest(request):raise ConfigConflict('原请求编号已用于其他提案、内容、版本或操作')
    result=json.loads(row['result'])
    if digest(result)!=row['result_hash']:raise ConfigConflict('提案写入回执校验失败，请保留本页内容')
    return result


def finish(service, db, identity, key, request):
    result=service._get(db,identity)
    if key:
        result['write_receipt']={'request_id':key,'request_hash':digest(request),'request':request}
        db.execute('INSERT INTO learning_write_requests VALUES(?,?,?,?,?,?,?,?)',(*service._scope(),key,digest(request),canonical(result),digest(result),identity))
    return result


def status(service, request_id, proposal_id):
    identifier(request_id);identifier(proposal_id)
    with service.store.read_snapshot() as db:
        service._assert_workspace_active(db)
        latest=service._get(db,proposal_id)
        saved=read(service,db,request_id)
        if saved and saved['id']!=proposal_id:raise ConfigConflict('原请求编号属于其他提案')
        return {'request_id':request_id,'proposal_id':proposal_id,'state':'COMPLETE' if saved else 'MISSING','saved':saved,'latest':latest}
