"""Closed routing predicates and scoped RAG configuration; never execute expressions."""
from .agents import text

FIELDS={'risk_level','citations_count','answer','content'}
OPS={'eq','ne','gte','lte','contains','not_contains'}

def retrieval_config(value):
    if not isinstance(value,dict) or set(value)!={'query','top_k'}:
        raise ValueError('RAG 配置需要查询词和 Top K')
    if type(value['top_k']) is not int or not 1<=value['top_k']<=8:
        raise ValueError('Top K 必须为 1–8 的整数')
    return {'query':text(value['query'],'检索查询',2000),'top_k':value['top_k']}

def validate_options(node):
    if 'join' in node and node['join'] not in ('all','any'):raise ValueError('汇合方式必须为 all 或 any')
    if 'retrieval' in node and node['retrieval'] is not None:node['retrieval']=retrieval_config(node['retrieval'])
    condition=node.get('condition')
    if condition is None:return
    if not isinstance(condition,dict) or set(condition)!={'source','field','operator','value'}:raise ValueError('分支条件字段无效')
    if condition['source'] not in node['depends_on']:raise ValueError('分支来源必须是直接上游节点')
    field=condition['field'];op=condition['operator'];value=condition['value']
    if field not in FIELDS or op not in OPS:raise ValueError('仅支持已注册的分支字段与运算符')
    if field=='citations_count':
        if type(value) is not int or not 0<=value<=8 or op not in ('eq','ne','gte','lte'):raise ValueError('引用数量条件需要 0–8 的整数')
    elif not isinstance(value,str) or len(value)>1000 or op not in ('eq','ne','contains','not_contains'):raise ValueError('文本条件需要字符串与文本运算符')
    if op in ('contains','not_contains') and not value.strip():raise ValueError('正文匹配条件需要填写关键词')
    if field=='risk_level' and (value not in ('HIGH','MEDIUM','LOW') or op not in ('eq','ne')):raise ValueError('风险条件仅支持 HIGH/MEDIUM/LOW 的等于或不等于')

def matches(condition,report):
    field=condition['field'];value=condition['value'];op=condition['operator']
    actual=len(report.get('citations',[])) if field=='citations_count' else report.get(field)
    if field=='answer' and actual is None:actual=report.get('content')
    # Missing data never opens a branch, including the not-equal operator.
    if actual is None:return False
    if op=='eq':return type(actual) is type(value) and actual==value
    if op=='ne':return type(actual) is type(value) and actual!=value
    if op=='contains':return isinstance(actual,str) and value in actual
    if op=='not_contains':return isinstance(actual,str) and value not in actual
    if type(actual) is not int:return False
    return actual>=value if op=='gte' else actual<=value
