"""Versioned, source-grounded domain ontologies and SKOS JSON-LD export.

A bounded concept/attribute/relation model, not an OWL reasoner. Only reviewed,
current, authorized sources may influence retrieval; ontology never grants tools.
"""
from copy import deepcopy
import time

from .contracts import PolicyDenied, digest, identifier, canonical
from .knowledge import insert_asset, tokens
from .learning import TEXT,LONG,REFS
from .runtime_config import ConfigConflict
from .structured import obj,validate

PROPERTY=obj({'id':TEXT,'label':TEXT,'type':{'type':'string','enum':['string','number','boolean','date']},'description':TEXT})
CONCEPT=obj({'id':TEXT,'label':TEXT,'definition':TEXT,'aliases':{'type':'array','maxItems':8,'items':TEXT},
             'properties':{'type':'array','maxItems':12,'items':PROPERTY},'source_refs':REFS})
RELATION=obj({'source':TEXT,'target':TEXT,'predicate':{'type':'string','enum':['IS_A','PART_OF','RELATED_TO','REQUIRES','PRODUCES','VALIDATES']},'source_refs':REFS})
ONTOLOGY=obj({'name':{'type':'string','minLength':1,'maxLength':200},'description':TEXT,
              'concepts':{'type':'array','minItems':1,'maxItems':40,'items':CONCEPT},
              'relations':{'type':'array','maxItems':80,'items':RELATION}})


def ontology_schema(context,operational=False):
    shape=deepcopy(ONTOLOGY)
    if operational:
        from .ontology_model import generation_schema
        shape['properties']['model']=generation_schema();shape['required'].append('model')
    def bind(schema):
        if not isinstance(schema,dict):return
        if 'source_refs' in schema.get('properties',{}):
            refs=schema['properties']['source_refs'];refs['items']={**refs['items'],'enum':[s['ref'] for s in context['sources']]}
        for item in schema.values():
            if isinstance(item,dict):bind(item)
            elif isinstance(item,list):
                for child in item:bind(child)
    bind(shape)
    return shape


def source_context(library,access,refs):
    if not isinstance(refs,list) or not 1<=len(refs)<=12 or any(not isinstance(r,str) for r in refs) or len(set(refs))!=len(refs):raise ValueError('请选择 1–12 个不同的已发布来源')
    sources=[];now=time.time()
    for ref in sorted(refs):
        a=library.get(access,ref)
        if a['kind'] not in {'KNOWLEDGE','MEMORY','EXPERIENCE','CAPABILITY'} or a['status']!='PUBLISHED' or not a['effective_at']<=now<a['effective_until']:raise ValueError('本体来源必须是当前有效的已发布资料')
        sources.append({'ref':a['ref'],'content_hash':a['content_hash'],'kind':a['kind'],'title':a['title'],'content':a['content']})
    if len(canonical(sources).encode())>80000:raise ValueError('本体来源超过 80 KB，请减少选定资料')
    return {'sources':sources,'source_hash':digest(sources)}


def validate_ontology(value,refs,*,validate_data=True):
    if not isinstance(value,dict):raise ValueError('本体内容必须是对象')
    validate({k:v for k,v in value.items() if k!='model'},ONTOLOGY);nodes={};labels=set()
    def check_refs(items):
        if len(items)!=len(set(items)) or not set(items)<=refs:raise ValueError('本体引用了未知或重复的来源')
    for node in value['concepts']:
        identifier(node['id']);label=node['label'].strip().casefold()
        if not label or label in labels or node['id'] in nodes:raise ValueError('概念标识和名称必须唯一且非空')
        labels.add(label);nodes[node['id']]=node;check_refs(node['source_refs']);props=set()
        aliases=[a.strip().casefold() for a in node['aliases']]
        if any(not a or a==label for a in aliases) or len(aliases)!=len(set(aliases)):raise ValueError('别名不能为空、重复或与首选名称相同')
        for p in node['properties']:
            identifier(p['id'])
            if p['id'] in props:raise ValueError('同一概念的属性标识不能重复')
            props.add(p['id'])
    edges=set();parents={n:[] for n in nodes};related=set()
    for r in value['relations']:
        if r['source'] not in nodes or r['target'] not in nodes or r['source']==r['target']:raise ValueError('关系端点必须是不同且已存在的概念')
        key=(r['source'],r['predicate'],r['target']);check_refs(r['source_refs'])
        if key in edges:raise ValueError('关系不能重复')
        edges.add(key)
        if r['predicate']=='IS_A':parents[r['source']].append(r['target'])
        if r['predicate']=='RELATED_TO':
            pair=frozenset((r['source'],r['target']))
            if pair in related:raise ValueError('关联关系是对称的，不必重复添加反向关系')
            related.add(pair)
    ancestors_cache={}
    def visit(n,path):
        if n in path:raise ValueError('上位概念关系不能形成循环')
        if n in ancestors_cache:return ancestors_cache[n]
        ancestors=set()
        for parent in parents[n]:ancestors.add(parent);ancestors.update(visit(parent,path|{n}))
        ancestors_cache[n]=ancestors
        return ancestors
    for n in nodes:
        for parent in visit(n,set()):
            if frozenset((n,parent)) in related:raise ValueError('上下位概念之间不能同时标为非层级关联')
    # Composition, like taxonomy, cannot recursively contain itself.
    part_parents={n:[] for n in nodes}
    for relation in value['relations']:
        if relation['predicate']=='PART_OF':part_parents[relation['source']].append(relation['target'])
    done=set()
    def parts(n,path):
        if n in path:raise ValueError('组成关系不能形成循环')
        if n in done:return
        for parent in part_parents[n]:parts(parent,path|{n})
        done.add(n)
    for n in nodes:parts(n,set())
    if 'model' in value:
        from .ontology_model import validate_structure,validate_data as check_data
        validate_structure(value['model'],nodes,refs)
        report=check_data(value['model'])
        if validate_data and not report['conforms']:
            first=report['results'][0]
            raise ValueError(first['focus_node']+'.'+first['path']+'：'+first['message'])
    return value


def mock_ontology(context,operational=False):
    nodes=[];labels=set()
    for i,s in enumerate(context['sources']):
        # Equal titles do not establish concept equivalence. Keep each source's
        # facts separate and disambiguate under the validator's label rules.
        base=s['title'].strip() or s['ref'];label=base;suffix=0
        while label.casefold() in labels:
            suffix+=1;label=base+' ('+s['ref']+(' #'+str(suffix) if suffix>1 else '')+')'
        labels.add(label.casefold())
        nodes.append({'id':'concept-'+str(i+1),'label':label,'definition':str(s['content'].get('text',s['content'].get('lesson','来源资料中的业务概念')))[:1200],
                      'aliases':[],'properties':[{'id':'source-version','label':'来源版本','type':'string','description':'该概念依据的资料版本引用'}],'source_refs':[s['ref']]})
    # Do not invent semantic relationships from mere co-occurrence.
    result={'name':'资料领域本体','description':'离线模式按选定资料建立概念；请编辑概念、属性和关系，或选择真实模型进一步抽取。','concepts':nodes,'relations':[]}
    if operational:
        from .ontology_model import empty_model
        result['model']=empty_model()
    return result


def sources_current(library,access,asset):
    """Check the frozen source versions; later versions do not replace evidence."""
    try:
        sources=asset['provenance']['sources']
        context=source_context(library,access,[s['ref'] for s in sources])
        expected={s['ref']:s['content_hash'] for s in sources}
        return all(expected[s['ref']]==s['content_hash'] for s in context['sources'])
    except (KeyError,ValueError,PolicyDenied):return False


def ontology_current(library,access,asset):
    """One eligibility gate for concept retrieval, objects and action previews."""
    if asset['kind']!='ONTOLOGY' or asset['status']!='PUBLISHED' or not asset['effective_at']<=time.time()<asset['effective_until']:return False
    if library.active_ontology_ref(access,asset['id'])!=asset['ref']:return False
    return _intact(asset) and sources_current(library,access,asset)


def _intact(asset):
    body={k:v for k,v in asset.items() if k not in {'ref','id','version','kind','status','owner','tenant_id','project_id','environment','visibility','content_hash'}}
    return digest(body)==asset['content_hash']


def ontology_state(library,access,asset):
    now=time.time();effective=asset['effective_at']<=now<asset['effective_until']
    current=sources_current(library,access,asset);active=library.active_ontology_ref(access,asset['id'])
    integrity=_intact(asset)
    reason=('本体已撤回' if asset['status']=='WITHDRAWN' else '本体尚未发布' if asset['status']!='PUBLISHED' else
            '本体尚未生效' if now<asset['effective_at'] else '本体已过期' if not effective else
            '本体内容哈希不一致，请核对资产完整性' if not integrity else
            '来源已撤回、过期、变化或不可访问，请基于当前资料重新生成' if not current else
            '此版本未生效；撤回新版不会自动恢复旧版，可明确启用此版本' if active!=asset['ref'] else '')
    return {'sources_current':current,'effective':effective,'active_ref':active,'usable':not reason,'unavailable_reason':reason}


def activate(library,access,ref,data):
    if not isinstance(data,dict) or set(data)!={'expected_active_ref'}:raise ValueError('启用版本需要当前生效版本引用')
    asset=library.get(access,ref)
    if asset['kind']!='ONTOLOGY' or asset['owner']!=access.principal or 'curator' not in access.roles:raise PolicyDenied('只能启用本人管理的本体版本')
    with library.store.transaction() as db:
        asset=library.get(access,ref)
        state=ontology_state(library,access,asset)
        if state['active_ref']!=data['expected_active_ref']:raise ConfigConflict('生效版本已变化，请刷新后重试')
        if asset['status']!='PUBLISHED' or not state['effective'] or not state['sources_current']:raise PolicyDenied('仅有效、来源可访问的已发布版本可明确启用')
        validate_ontology(asset['content'],{s['ref'] for s in asset['provenance']['sources']})
        db.execute('INSERT OR REPLACE INTO ontology_activation VALUES(?,?,?)',(access.tenant,asset['id'],asset['version']))
        db.execute('INSERT INTO asset_events VALUES(?,?,?,?,?,?,?)',(access.tenant,asset['id'],asset['version'],time.time(),access.principal,'ontology.activated',canonical(data)))
    return {**asset,**ontology_state(library,access,asset)}


def revise(library,access,ref,data):
    if not isinstance(data,dict) or set(data)!={'content'}:raise ValueError('修订需要完整的本体内容')
    prior=library.get(access,ref)
    if prior['kind']!='ONTOLOGY' or prior['owner']!=access.principal or 'curator' not in access.roles:raise PolicyDenied('只能修订本人管理的本体')
    if not sources_current(library,access,prior):raise ConfigConflict('来源已撤回或变化，请基于当前资料重新生成')
    validate_ontology(data['content'],{s['ref'] for s in prior['provenance']['sources']})
    body={k:deepcopy(v) for k,v in prior.items() if k not in {'ref','id','version','kind','status','owner','tenant_id','project_id','environment','visibility','content_hash'}}
    body.update(content=data['content'],title=data['content']['name'],supersedes=prior['ref'],observed_at=time.time())
    with library.store.transaction() as db:
        latest=db.execute('SELECT MAX(version) FROM asset_versions WHERE tenant=? AND id=?',(access.tenant,prior['id'])).fetchone()[0]
        if latest!=prior['version']:raise ConfigConflict('本体已有新版本，请加载最新版本')
        if not sources_current(library,access,prior):raise ConfigConflict('来源已变化')
        insert_asset(db,access,prior['id'],latest+1,'ONTOLOGY',body,visibility=prior['visibility'])
        db.execute('INSERT INTO asset_events VALUES(?,?,?,?,?,?,?)',(access.tenant,prior['id'],latest+1,time.time(),access.principal,'ontology.revised','{}'))
    return library.get(access,prior['id']+'@'+str(latest+1))


def expand(library,access,query,limit=12,max_hops=2,predicates=None):
    """Rank direct matches before bounded paths; preserve each hop's source provenance."""
    allowed={'IS_A','PART_OF','RELATED_TO','REQUIRES','PRODUCES','VALIDATES'}
    if not isinstance(query,str) or len(query)>2000 or type(limit) is not int or not 1<=limit<=40 or type(max_hops) is not int or not 0<=max_hops<=3:raise ValueError('本体检索参数无效')
    predicates=allowed if predicates is None else predicates
    if not isinstance(predicates,(set,list,tuple)) or any(not isinstance(p,str) or p not in allowed for p in predicates):raise ValueError('本体检索关系类型无效')
    if not query.strip():return {'concepts':[],'source_refs':[],'paths':[]}
    terms=set(tokens(query));normalized=query.strip().casefold();ranked=[];seen=set()
    for asset in library.list(access,include_unpublished=True,kind='ONTOLOGY'):
        if asset['kind']!='ONTOLOGY' or asset['id'] in seen or not ontology_current(library,access,asset):continue
        seen.add(asset['id']);content=asset['content'];nodes={n['id']:n for n in content['concepts']};adjacency={key:[] for key in nodes}
        for relation in content['relations']:
            if relation['predicate'] not in predicates:continue
            adjacency[relation['source']].append((relation['target'],relation,'forward'))
            adjacency[relation['target']].append((relation['source'],relation,'reverse'))
        matches={}
        for node in nodes.values():
            labels=[node['label'],*node['aliases']]
            overlap=terms.intersection(tokens(' '.join(labels)))
            exact=normalized in {label.strip().casefold() for label in labels}
            if exact or overlap:
                matches[node['id']]={'score':1.0 if exact else .8+min(.15,len(overlap)*.03),'path':[],'matched':node['id']}
        frontier=list(matches)
        for _ in range(max_hops):
            following=[]
            for source in frontier:
                for target,relation,direction in adjacency[source]:
                    score=round(matches[source]['score']*.6,6)
                    if target in matches and matches[target]['score']>=score:continue
                    hop={'source':source,'target':target,'predicate':relation['predicate'],'direction':direction,'source_refs':relation['source_refs']}
                    matches[target]={'score':score,'path':matches[source]['path']+[hop],'matched':matches[source]['matched']};following.append(target)
            frontier=following
        for identity,match in matches.items():
            node=nodes[identity]
            refs=set(node['source_refs'])|set(nodes[match['matched']]['source_refs'])
            for hop in match['path']:refs.update(hop['source_refs']);refs.update(nodes[hop['source']]['source_refs']);refs.update(nodes[hop['target']]['source_refs'])
            ranked.append({'ontology_ref':asset['ref'],'ontology_hash':asset['content_hash'],**node,
                           'match_score':round(match['score'],4),'match_kind':'DIRECT' if not match['path'] else 'PATH',
                           'path':match['path'],'path_source_refs':sorted(refs)})
    ranked.sort(key=lambda item:(-item['match_score'],item['ontology_ref'],item['id']))
    result=ranked[:limit]
    return {'concepts':result,'source_refs':sorted({ref for item in result for ref in item['path_source_refs']}),
            'paths':[{'ontology_ref':item['ontology_ref'],'concept_id':item['id'],'score':item['match_score'],'hops':item['path']} for item in result],
            'max_hops':max_hops,'truncated':len(ranked)>limit}


def export_jsonld(asset):
    base='urn:agent-framework:ontology:'+asset['id']+':'
    graph=[{'@id':base+'scheme','@type':'skos:ConceptScheme','skos:prefLabel':asset['title'],'owl:versionInfo':str(asset['version']),'prov:wasDerivedFrom':[{'@id':'urn:agent-framework:source:'+s['ref']} for s in asset.get('provenance',{}).get('sources',[])]}]
    for n in asset['content']['concepts']:
        value={'@id':base+n['id'],'@type':'skos:Concept','skos:inScheme':{'@id':base+'scheme'},'skos:prefLabel':n['label'],
               'skos:definition':n['definition'],'skos:altLabel':n['aliases'],'dct:source':n['source_refs'],
               'af:properties':[{('af:'+k):v for k,v in p.items()} for p in n['properties']]}
        for r in asset['content']['relations']:
            if r['source']==n['id']:
                key={'IS_A':'skos:broader','RELATED_TO':'skos:related'}.get(r['predicate'],'af:'+r['predicate'].lower())
                value.setdefault(key,[]).append({'@id':base+r['target']})
        graph.append(value)
    if asset['content'].get('model'):
        from .ontology_model import jsonld_model
        graph.extend(jsonld_model(asset['content']['model'],base))
    return {'@context':{'rdf':'http://www.w3.org/1999/02/22-rdf-syntax-ns#','rdfs':'http://www.w3.org/2000/01/rdf-schema#','owl':'http://www.w3.org/2002/07/owl#','xsd':'http://www.w3.org/2001/XMLSchema#','sh':'http://www.w3.org/ns/shacl#','prov':'http://www.w3.org/ns/prov#','skos':'http://www.w3.org/2004/02/skos/core#','dct':'http://purl.org/dc/terms/','af':'urn:agent-framework:ontology:'},'@graph':graph}
