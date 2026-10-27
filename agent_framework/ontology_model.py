"""Bounded operational ontology: types, typed objects, links, shapes and action mappings.

Inspired by object/link modeling and SHACL Core constraints. This module validates
our explicit subset; it is not a general SHACL/OWL engine or an action executor.
"""
from datetime import date
from decimal import Decimal
import math

from .contracts import canonical, identifier

VERSION = 'operational-ontology@1.0.0'
TYPES = ('string', 'number', 'boolean', 'date')
CARDINALITIES = ('ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_ONE', 'MANY_TO_MANY')
MODEL_FIELDS = {'version', 'object_types', 'link_types', 'objects', 'links', 'action_types'}
PROPERTY_FIELDS = {'id','label','description','type','min_count','max_count','enum_values','min_value','max_value'}


def empty_model():
    return dict(version=VERSION,object_types=[],link_types=[],objects=[],links=[],action_types=[])


def fields(value, expected, label):
    if not isinstance(value,dict) or set(value) != set(expected):
        raise ValueError(label + '字段不完整或包含未知字段')


def text(value, label):
    if not isinstance(value,str) or not value.strip() or len(value)>2000 or '\x00' in value:
        raise ValueError(label + '须为非空文本且不超过 2000 字符')


def literal(value, kind):
    if kind == 'string':return isinstance(value,str) and len(value)<=8000
    if kind == 'boolean':return type(value) is bool
    if kind == 'number':
        try:return type(value) in (int,float) and math.isfinite(value)
        except OverflowError:return False
    if kind == 'date':
        if not isinstance(value,str):return False
        try:return date.fromisoformat(value).isoformat()==value
        except ValueError:return False
    return False


def value_key(value,kind):
    return Decimal(str(value)) if kind=='number' and literal(value,kind) else canonical(value)


def validate_structure(model, concepts, refs):
    fields(model,MODEL_FIELDS,'业务对象模型')
    if model['version'] != VERSION:raise ValueError('不支持的业务对象模型版本')
    if len(canonical(model).encode())>200000:raise ValueError('业务对象模型超过 200 KB')
    for kind,limit in [('object_types',16),('link_types',32),('objects',200),('links',400),('action_types',32)]:
        if not isinstance(model[kind],list) or len(model[kind])>limit:raise ValueError(kind+' 超过数量上限或不是数组')
    def sources(item):
        values=item['source_refs']
        if not isinstance(values,list) or not 1<=len(values)<=12 or any(not isinstance(r,str) for r in values) or len(set(values))!=len(values) or not set(values)<=refs:
            raise ValueError('业务类型、实例、关系和动作映射必须引用选定的已发布来源')
    def unique(items,label):
        result={}
        for item in items:
            identifier(item['id'])
            if item['id'] in result:raise ValueError(label+'标识重复')
            result[item['id']]=item
        return result
    for item in model['object_types']:
        fields(item,{'id','label','concept_id','primary_key','properties','source_refs'},'对象类型')
        text(item['label'],'对象类型名称');sources(item)
        identifier(item['concept_id']);identifier(item['primary_key'])
        if item['concept_id'] not in concepts:raise ValueError('对象类型需要引用已存在的概念')
        if not isinstance(item['properties'],list) or not 1<=len(item['properties'])<=24:raise ValueError('对象类型需要 1–24 项属性')
        for prop in item['properties']:
            fields(prop,PROPERTY_FIELDS,'对象属性');identifier(prop['id']);text(prop['label'],'属性名称')
            if not isinstance(prop['description'],str) or len(prop['description'])>2000:raise ValueError('属性说明无效')
            if prop['type'] not in TYPES:raise ValueError('属性类型未登记')
            if type(prop['min_count']) is not int or type(prop['max_count']) is not int or not 0<=prop['min_count']<=prop['max_count']<=32 or prop['max_count']<1:raise ValueError('属性基数须满足 0 ≤ 最少 ≤ 最多 ≤ 32')
            values=prop['enum_values']
            if not isinstance(values,list) or len(values)>32 or any(not literal(v,prop['type']) for v in values) or len({value_key(v,prop['type']) for v in values})!=len(values):raise ValueError('属性枚举值类型错误或重复')
            for key in ('min_value','max_value'):
                if prop[key] is not None and (prop['type']!='number' or not literal(prop[key],'number')):raise ValueError('仅数值属性可设置数值范围')
            if prop['min_value'] is not None and prop['max_value'] is not None and prop['min_value']>prop['max_value']:raise ValueError('属性最小值不能大于最大值')
        props=unique(item['properties'],'属性')
        primary=props.get(item['primary_key'])
        if not primary or primary['type'] not in ('string','number') or primary['min_count']!=1 or primary['max_count']!=1:raise ValueError('主键必须是必填、单值的文本或数值属性')
    types=unique(model['object_types'],'对象类型')
    for item in model['link_types']:
        fields(item,{'id','label','source_type','target_type','cardinality','source_refs'},'关系类型')
        text(item['label'],'关系类型名称');sources(item)
        identifier(item['source_type']);identifier(item['target_type'])
        if item['source_type'] not in types or item['target_type'] not in types:raise ValueError('关系类型端点必须是已存在的对象类型')
        if item['cardinality'] not in CARDINALITIES:raise ValueError('关系基数无效')
    links=unique(model['link_types'],'关系类型')
    for item in model['objects']:
        fields(item,{'id','type_id','values','source_refs'},'对象实例');sources(item)
        identifier(item['type_id'])
        if item['type_id'] not in types or not isinstance(item['values'],dict):raise ValueError('实例需要已登记类型和属性值对象')
        if len(canonical(item['values']).encode())>16000:raise ValueError('单个实例的属性值超过 16 KB')
    unique(model['objects'],'对象实例')
    for item in model['links']:
        fields(item,{'type_id','source','target','source_refs'},'实例关系');sources(item)
        identifier(item['type_id'])
        if item['type_id'] not in links:raise ValueError('实例关系引用了未登记的关系类型')
        identifier(item['source']);identifier(item['target'])
    from .definitions import capability_definitions
    caps=capability_definitions()
    for item in model['action_types']:
        fields(item,{'id','label','target_type','capability_ref','source_refs'},'动作映射')
        text(item['label'],'动作名称');sources(item)
        identifier(item['target_type']);text(item['capability_ref'],'能力引用')
        if item['target_type'] not in types or item['capability_ref'] not in caps:raise ValueError('动作仅能映射已存在类型与已登记能力')
    unique(model['action_types'],'动作')
    return model


def validate_data(model):
    """SHACL-style results include focus node, path, constraint and offending value."""
    results=[]
    def fail(node,path,constraint,message,value=None):
        results.append({'focus_node':node,'path':path,'constraint':constraint,'severity':'Violation','message':message,'value':value})
    types={t['id']:t for t in model['object_types']};objects={o['id']:o for o in model['objects']}
    keys={};seen_links=set();outgoing={};incoming={}
    for item in model['objects']:
        shape=types[item['type_id']];props={p['id']:p for p in shape['properties']}
        for key in set(item['values'])-props.keys():fail(item['id'],key,'ClosedConstraintComponent','属性未在对象类型中定义',item['values'][key])
        for prop in props.values():
            raw=item['values'].get(prop['id']);values=raw if isinstance(raw,list) else [] if raw is None else [raw]
            if len(values)<prop['min_count']:fail(item['id'],prop['id'],'MinCountConstraintComponent','缺少必填属性或属性值数量不足')
            if len(values)>prop['max_count']:fail(item['id'],prop['id'],'MaxCountConstraintComponent','属性值数量超出限制',raw)
            if len({value_key(v,prop['type']) for v in values})!=len(values):fail(item['id'],prop['id'],'UniqueValueConstraint','多值属性不能包含重复值',raw)
            for value in values:
                if not literal(value,prop['type']):
                    fail(item['id'],prop['id'],'DatatypeConstraintComponent','属性值不符合 '+prop['type']+' 类型',value);continue
                if prop['enum_values'] and value not in prop['enum_values']:fail(item['id'],prop['id'],'InConstraintComponent','值不在允许的枚举中',value)
                if prop['min_value'] is not None and value<prop['min_value']:fail(item['id'],prop['id'],'MinInclusiveConstraintComponent','值低于允许范围',value)
                if prop['max_value'] is not None and value>prop['max_value']:fail(item['id'],prop['id'],'MaxInclusiveConstraintComponent','值高于允许范围',value)
            if prop['id']==shape['primary_key'] and len(values)==1 and literal(values[0],prop['type']):
                if isinstance(values[0],str) and not values[0].strip():fail(item['id'],prop['id'],'MinLengthConstraintComponent','主键文本不能为空',values[0])
                key=(item['type_id'],value_key(values[0],prop['type']))
                if key in keys:fail(item['id'],prop['id'],'UniquePrimaryKeyConstraint','主键与实例 '+keys[key]+' 重复',values[0])
                keys[key]=item['id']
    link_types={t['id']:t for t in model['link_types']}
    for link in model['links']:
        shape=link_types[link['type_id']];source=objects.get(link['source']);target=objects.get(link['target'])
        key=(link['type_id'],link['source'],link['target'])
        if key in seen_links:fail(link['source'],link['type_id'],'UniqueLinkConstraint','实例关系重复',link['target'])
        seen_links.add(key)
        if not source or not target:fail(link['source'],link['type_id'],'NodeConstraintComponent','关系端点实例不存在',link['target']);continue
        if source['type_id']!=shape['source_type'] or target['type_id']!=shape['target_type']:fail(link['source'],link['type_id'],'ClassConstraintComponent','关系端点类型与定义不一致',link['target'])
        outgoing.setdefault((link['type_id'],link['source']),set()).add(link['target'])
        incoming.setdefault((link['type_id'],link['target']),set()).add(link['source'])
    for (kind,node),targets in outgoing.items():
        if link_types[kind]['cardinality'] in ('ONE_TO_ONE','MANY_TO_ONE') and len(targets)>1:fail(node,kind,'MaxCountConstraintComponent','该关系每个起点最多关联一个终点',sorted(targets))
    for (kind,node),sources in incoming.items():
        if link_types[kind]['cardinality'] in ('ONE_TO_ONE','ONE_TO_MANY') and len(sources)>1:fail(node,kind,'MaxCountConstraintComponent','该关系每个终点最多关联一个起点',sorted(sources))
    return {'profile':VERSION,'conforms':not results,'results':results,
            'counts':{key:len(model[key]) for key in ('object_types','link_types','objects','links','action_types')}}


def validation_report(content, refs):
    from .ontology import validate_ontology
    try:
        validate_ontology(content,refs,validate_data=False)
        return validate_data(content['model']) if content.get('model') else {'profile':VERSION,'conforms':True,'results':[],'counts':{}}
    except (ValueError,KeyError,TypeError) as exc:
        return {'profile':VERSION,'conforms':False,'results':[{'focus_node':'model','path':'$','constraint':'SchemaConstraint','severity':'Violation','message':str(exc),'value':None}],'counts':{}}


def jsonld_model(model, base):
    """Export our shapes using standard SHACL terms; no claim of complete SHACL support."""
    from urllib.parse import quote
    from .definitions import capability_definitions
    graph=[];caps=capability_definitions();datatypes={'string':'xsd:string','number':'xsd:decimal','boolean':'xsd:boolean','date':'xsd:date'}
    def source(refs):return [{'@id':'urn:agent-framework:source:'+quote(r,safe='')} for r in refs]
    def rdf_literal(value,kind):
        # JSON-LD native numbers carry JSON datatypes. Decimal needs a lexical
        # form so independent RDF libraries materialize an actual xsd:decimal.
        lexical=format(Decimal(str(value)),'f') if kind=='number' and literal(value,kind) else str(value) if kind=='number' else value
        return {'@value':lexical,'@type':datatypes[kind]}
    for item in model['object_types']:
        uri=base+'type:'+item['id'];properties=[]
        for p in item['properties']:
            prop_uri=base+'property:'+item['id']+':'+p['id']
            graph.append({'@id':prop_uri,'@type':'rdf:Property','rdfs:label':p['label'],'rdfs:domain':{'@id':uri},'rdfs:range':{'@id':datatypes[p['type']]}})
            shape={'sh:path':{'@id':prop_uri},'sh:datatype':{'@id':datatypes[p['type']]},'sh:minCount':p['min_count'],'sh:maxCount':p['max_count']}
            if p['enum_values']:shape['sh:in']={'@list':[rdf_literal(v,p['type']) for v in p['enum_values']]}
            if p['id']==item['primary_key'] and p['type']=='string':shape['sh:minLength']=1;shape['sh:pattern']='\\S'
            if p['min_value'] is not None:shape['sh:minInclusive']=p['min_value']
            if p['max_value'] is not None:shape['sh:maxInclusive']=p['max_value']
            properties.append(shape)
        graph.append({'@id':uri,'@type':'owl:Class','rdfs:label':item['label'],'af:concept':{'@id':base+item['concept_id']},'prov:wasDerivedFrom':source(item['source_refs']),'af:primaryKey':{'@id':base+'property:'+item['id']+':'+item['primary_key']}})
        graph.append({'@id':base+'shape:'+item['id'],'@type':'sh:NodeShape','sh:targetClass':{'@id':uri},'sh:closed':True,'sh:ignoredProperties':{'@list':[{'@id':'rdf:type'},{'@id':'prov:wasDerivedFrom'}]},'sh:property':properties})
    for item in model['link_types']:
        uri=base+'link:'+item['id']
        graph.append({'@id':uri,'@type':'owl:ObjectProperty','rdfs:label':item['label'],'rdfs:domain':{'@id':base+'type:'+item['source_type']},'rdfs:range':{'@id':base+'type:'+item['target_type']},'af:cardinality':item['cardinality'],'prov:wasDerivedFrom':source(item['source_refs'])})
        source_shape=next(n for n in graph if n.get('@id')==base+'shape:'+item['source_type'])
        path={'sh:path':{'@id':uri},'sh:class':{'@id':base+'type:'+item['target_type']}}
        if item['cardinality'] in ('ONE_TO_ONE','MANY_TO_ONE'):path['sh:maxCount']=1
        source_shape['sh:property'].append(path)
        if item['cardinality'] in ('ONE_TO_ONE','ONE_TO_MANY'):
            target_shape=next(n for n in graph if n.get('@id')==base+'shape:'+item['target_type'])
            target_shape['sh:property'].append({'sh:path':{'sh:inversePath':{'@id':uri}},'sh:maxCount':1})
    for item in model['objects']:
        shape=next(t for t in model['object_types'] if t['id']==item['type_id']);props={p['id']:p for p in shape['properties']}
        node={'@id':base+'object:'+item['id'],'@type':base+'type:'+item['type_id'],'prov:wasDerivedFrom':source(item['source_refs'])}
        for key,raw in item['values'].items():
            if key not in props:continue
            values=raw if isinstance(raw,list) else [raw]
            node[base+'property:'+item['type_id']+':'+key]=[rdf_literal(v,props[key]['type']) for v in values]
        for link in model['links']:
            if link['source']==item['id']:node.setdefault(base+'link:'+link['type_id'],[]).append({'@id':base+'object:'+link['target']})
        graph.append(node)
    for item in model['action_types']:
        graph.append({'@id':base+'action:'+item['id'],'@type':'af:ActionMapping','rdfs:label':item['label'],'af:targetType':{'@id':base+'type:'+item['target_type']},'af:capabilityRef':item['capability_ref'],'af:effect':caps[item['capability_ref']]['effect'],'prov:wasDerivedFrom':source(item['source_refs'])})
    for index,item in enumerate(model['links']):
        graph.append({'@id':base+'assertion:'+str(index),'@type':'rdf:Statement',
                      'rdf:subject':{'@id':base+'object:'+item['source']},'rdf:predicate':{'@id':base+'link:'+item['type_id']},
                      'rdf:object':{'@id':base+'object:'+item['target']},'prov:wasDerivedFrom':source(item['source_refs'])})
    return graph


def object_set(library, access, asset, query='', type_id=None, limit=50):
    from .contracts import PolicyDenied
    from .ontology import ontology_current,validate_ontology
    if not ontology_current(library,access,asset):
        raise PolicyDenied('仅当前有效、来源可访问的已发布本体可用于对象检索')
    if not isinstance(query,str) or len(query)>2000 or type(limit) is not int or not 1<=limit<=100:raise ValueError('对象检索参数无效')
    validate_ontology(asset['content'],{s['ref'] for s in asset['provenance']['sources']})
    model=asset['content'].get('model',empty_model())
    if type_id is not None and type_id not in {t['id'] for t in model['object_types']}:raise ValueError('对象类型不存在')
    q=query.strip().casefold()
    items=[o for o in model['objects'] if (not type_id or o['type_id']==type_id) and (not q or q in (o['id']+' '+canonical(o['values'])).casefold())]
    selected=items[:limit];ids={o['id'] for o in selected}
    return {'ontology_ref':asset['ref'],'ontology_hash':asset['content_hash'],'items':selected,
            'object_types':model['object_types'],'link_types':model['link_types'],'action_types':model['action_types'],
            'links':[r for r in model['links'] if r['source'] in ids or r['target'] in ids],
            'total':len(items),'limit':limit,'truncated':len(items)>limit}


def generation_schema():
    """Closed model-output schema; dynamic property values use a typed entry list."""
    from .structured import obj
    from .definitions import capability_definitions
    text_schema={'type':'string','minLength':1,'maxLength':2000}
    description={'type':'string','maxLength':2000}
    source_refs={'type':'array','minItems':1,'maxItems':12,'items':text_schema}
    primitive={'anyOf':[text_schema,{'type':'number'},{'type':'boolean'}]}
    bound={'anyOf':[{'type':'number'},{'type':'null'}]}
    prop=obj(dict(id=text_schema,label=text_schema,description=description,type={'type':'string','enum':list(TYPES)},
                  min_count={'type':'integer','minimum':0},max_count={'type':'integer','minimum':1},
                  enum_values={'type':'array','maxItems':32,'items':primitive},min_value=bound,max_value=bound))
    return obj({'version':{'type':'string','enum':[VERSION]},
                'object_types':{'type':'array','maxItems':16,'items':obj(dict(id=text_schema,label=text_schema,concept_id=text_schema,primary_key=text_schema,
                                   properties={'type':'array','minItems':1,'maxItems':24,'items':prop},source_refs=source_refs))},
                'link_types':{'type':'array','maxItems':32,'items':obj(dict(id=text_schema,label=text_schema,source_type=text_schema,target_type=text_schema,
                                  cardinality={'type':'string','enum':list(CARDINALITIES)},source_refs=source_refs))},
                'objects':{'type':'array','maxItems':200,'items':obj(dict(id=text_schema,type_id=text_schema,
                               values={'type':'array','maxItems':24,'items':obj(dict(property_id=text_schema,values={'type':'array','maxItems':32,'items':primitive}))},source_refs=source_refs))},
                'links':{'type':'array','maxItems':400,'items':obj(dict(type_id=text_schema,source=text_schema,target=text_schema,source_refs=source_refs))},
                'action_types':{'type':'array','maxItems':32,'items':obj(dict(id=text_schema,label=text_schema,target_type=text_schema,
                                     capability_ref={'type':'string','enum':list(capability_definitions())},source_refs=source_refs))}})


def normalize_generated(content):
    from copy import deepcopy
    result=deepcopy(content)
    for item in result.get('model',{}).get('objects',[]):
        entries=item['values']
        if not isinstance(entries,list):raise ValueError('生成实例的属性值应为结构化条目数组')
        values={};seen=set()
        for entry in entries:
            key=entry['property_id']
            if key in seen:raise ValueError('生成实例包含重复属性')
            seen.add(key)
            if entry['values']:values[key]=entry['values'][0] if len(entry['values'])==1 else entry['values']
        item['values']=values
    return result
