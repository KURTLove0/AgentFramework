"""Version-bound assertion quotations and explicit human review; no inferred truth."""
import json
import time
from urllib.parse import quote

from .contracts import PolicyDenied, canonical, digest
from .runtime_config import ConfigConflict


def assertions(content):
    result=[]
    def add(path,label,refs):result.append({'path':path,'label':label,'source_refs':refs})
    for node in content['concepts']:
        add('concept:'+node['id'],'概念：'+node['label'],node['source_refs'])
        for prop in node['properties']:
            add('concept-property:'+node['id']+':'+prop['id'],'概念属性：'+node['label']+'.'+prop['label'],node['source_refs'])
    for link in content['relations']:
        add('relation:'+link['source']+':'+link['predicate']+':'+link['target'],
            '概念关系：'+link['source']+' '+link['predicate']+' '+link['target'],link['source_refs'])
    model=content.get('model',{})
    for kind,prefix,label in [('object_types','type','对象类型'),('link_types','link-type','关系类型'),
                              ('objects','object','对象实例'),('action_types','action','动作映射')]:
        for item in model.get(kind,[]):
            add(prefix+':'+item['id'],label+'：'+item.get('label',item['id']),item['source_refs'])
            if kind=='object_types':
                for prop in item['properties']:
                    add('property:'+item['id']+':'+prop['id'],'属性约束：'+item['label']+'.'+prop['label'],item['source_refs'])
    for link in model.get('links',[]):
        add('link:'+link['type_id']+':'+link['source']+':'+link['target'],
            '实例关系：'+link['source']+' → '+link['target'],link['source_refs'])
    return result


def records(library,access,asset):
    asset=library.get(access,asset['ref'])
    if asset['kind']!='ONTOLOGY':raise ValueError('不是本体资料')
    with library.store.connect() as db:
        rows=db.execute('SELECT data FROM ontology_evidence WHERE tenant=? AND id=? AND version=? ORDER BY path,source_ref',
                        (access.tenant,asset['id'],asset['version'])).fetchall()
    return [json.loads(row[0]) for row in rows]


def read(library,access,ref):
    from .ontology import source_context,sources_current
    asset=library.get(access,ref)
    if asset['kind']!='ONTOLOGY':raise ValueError('不是本体资料')
    current=sources_current(library,access,asset);sources=[]
    if current:
        context=source_context(library,access,[s['ref'] for s in asset['provenance']['sources']])
        sources=[{'ref':s['ref'],'content_hash':s['content_hash'],'title':s['title'],
                  'text':s['content'].get('text',s['content'].get('lesson',canonical(s['content'])))} for s in context['sources']]
    return {'ontology_ref':ref,'assertions':assertions(asset['content']),'sources':sources,'sources_current':current,
            'records':records(library,access,asset),'editable':current and asset['owner']==access.principal and 'curator' in access.roles,
            'policy':'片段必须逐字来自断言引用的冻结来源；人工核对状态单独记录，不自动证明断言正确。'}


def save(library,access,ref,data):
    from .ontology import sources_current
    fields={'path','source_ref','quote','reviewed','revision'}
    if not isinstance(data,dict) or set(data)!=fields:raise ValueError('证据需要断言路径、来源、原文片段、人工核对状态和版本')
    if not isinstance(data['path'],str) or not isinstance(data['source_ref'],str):raise ValueError('断言路径和来源无效')
    if not isinstance(data['quote'],str) or not data['quote'].strip() or len(data['quote'])>2000:raise ValueError('请选择 1–2000 字原文片段')
    if type(data['reviewed']) is not bool or type(data['revision']) is not int or data['revision']<0:raise ValueError('人工核对状态或证据版本无效')
    asset=library.get(access,ref)
    if asset['kind']!='ONTOLOGY' or asset['owner']!=access.principal or 'curator' not in access.roles:raise PolicyDenied('只能维护本人本体的断言证据')
    item=next((a for a in assertions(asset['content']) if a['path']==data['path']),None)
    if not item or data['source_ref'] not in item['source_refs']:raise ValueError('证据来源必须属于选定断言的引用')
    with library.store.transaction() as db:
        if not sources_current(library,access,asset):raise ConfigConflict('来源已失效，请基于当前资料重新生成本体')
        source=library.get(access,data['source_ref'])
        text=source['content'].get('text',source['content'].get('lesson',canonical(source['content'])))
        start=text.find(data['quote'])
        if start<0:raise ValueError('证据片段必须逐字出现在冻结来源原文中')
        scope=(access.tenant,asset['id'],asset['version'],data['path'],data['source_ref'])
        prior=db.execute('SELECT revision FROM ontology_evidence WHERE tenant=? AND id=? AND version=? AND path=? AND source_ref=?',scope).fetchone()
        revision=prior['revision'] if prior else 0
        if revision!=data['revision']:raise ConfigConflict('证据已被其他页面更新，请重新读取')
        if not prior and db.execute('SELECT COUNT(*) FROM ontology_evidence WHERE tenant=? AND id=? AND version=?',scope[:3]).fetchone()[0]>=256:raise ValueError('每个本体版本最多保留 256 条断言证据')
        value={**data,'revision':revision+1,'source_hash':source['content_hash'],'start':start,'end':start+len(data['quote']),
               'reviewer':access.principal if data['reviewed'] else None,'actor':access.principal,'updated_at':time.time()}
        db.execute('INSERT OR REPLACE INTO ontology_evidence VALUES(?,?,?,?,?,?,?)',(*scope,value['revision'],canonical(value)))
        db.execute('INSERT INTO asset_events VALUES(?,?,?,?,?,?,?)',(access.tenant,asset['id'],asset['version'],time.time(),access.principal,'ontology.evidence.reviewed',canonical(value)))
    return value


def jsonld(asset,items):
    base='urn:agent-framework:ontology:'+asset['id']+':'
    return [{'@id':base+'evidence:'+digest([asset['version'],item['path'],item['source_ref']])[:24],
             '@type':'af:AssertionEvidence','af:assertionPath':item['path'],'rdf:value':item['quote'],
             'prov:wasDerivedFrom':{'@id':'urn:agent-framework:source:'+quote(item['source_ref'],safe='')},
             'af:sourceHash':item['source_hash'],'af:reviewed':item['reviewed'],
             'af:startOffset':item['start'],'af:endOffset':item['end'],
             'prov:wasAttributedTo':{'@id':'urn:agent-framework:principal:'+quote(item['actor'],safe='')}} for item in items]
