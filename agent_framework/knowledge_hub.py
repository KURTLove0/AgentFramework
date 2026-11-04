"""One scoped read model for knowledge, memory, experience and executable abilities."""
from .definitions import capability_definitions,get_domain,AgentCompiler
from .memory import episodes,episode_count,page as episode_page
from .knowledge import tokens


def hub(app,query='',*,memory_page=False,memory_cursor=None,memory_limit=50):
    if not isinstance(query,str) or len(query)>2000:raise ValueError('检索内容过长')
    access=app.library_access();library=app.library();assets=library.list(access,include_unpublished=True,evaluation_summaries=True)
    terms=set(tokens(query))
    from .ontology import expand
    semantic=expand(library,access,query);semantic_refs=set(semantic['source_refs'])|{item['ontology_ref'] for item in semantic['concepts']}
    def matches(value):return not query.strip() or (isinstance(value,dict) and value.get('ref') in semantic_refs) or bool(terms.intersection(tokens(str(value))))
    exp=[a for a in assets if a['kind']=='EXPERIENCE']
    with library.store.read_snapshot() as db:
        if memory_page:
            memory_window=episode_page(library.store,access,query,limit=memory_limit,cursor=memory_cursor,db=db)
            memories=memory_window['episodes'];memory_count=memory_window['total']+memory_window['newer_count']
        else:
            memories=episodes(library.store,access,query,limit=50,db=db)
            memory_count=min(episode_count(library.store,access,db=db),50) if terms else len(memories)
    caps=[];agents=[]
    for a in app.agents.list():
        if a['archived']:continue
        try:compiled=AgentCompiler().compile(a)
        except ValueError:continue
        agents.append((a,compiled))
    for cap in capability_definitions().values():
        users=[{'id':a['id'],'name':a['name'],'revision':a['revision'],'adapter_ref':c['capabilities'][cap['ref']]['adapter_ref']} for a,c in agents if cap['ref'] in c['capabilities']]
        caps.append({**cap,'agents':users})
    from .ontology import ontology_state
    ontologies=[{**a,**ontology_state(library,access,a)} for a in assets if a['kind']=='ONTOLOGY' and matches(a)]
    return {'knowledge':[a for a in assets if a['kind']=='KNOWLEDGE' and matches(a)],
            'memory':{'preferences':[a for a in assets if a['kind']=='PREFERENCE' and matches(a)],'notes':[a for a in assets if a['kind']=='MEMORY' and matches(a)],'episodes':memories,**({'episode_page':{k:v for k,v in memory_window.items() if k!='episodes'}} if memory_page else {})},
            'experience':[a for a in exp if matches(a)],'capabilities':[c for c in caps if matches(c)],
            'capability_methods':[a for a in assets if a['kind']=='CAPABILITY' and matches(a)],'ontologies':ontologies,'ontology_matches':semantic['concepts'],
            'skills':[get_domain(ref).descriptor()['skill'] for ref in ('general-assistant@1.0.0','change-assessment@2.0.0','knowledge-answer@1.0.0')],
            'counts':{'knowledge':sum(a['kind']=='KNOWLEDGE' for a in assets),'preferences':sum(a['kind']=='PREFERENCE' for a in assets),'notes':sum(a['kind']=='MEMORY' for a in assets),'episodes':memory_count,'experience':len(exp),'capabilities':len(caps),'capability_methods':sum(a['kind']=='CAPABILITY' for a in assets),'ontologies':sum(a['kind']=='ONTOLOGY' for a in assets)},
            'identity':{'principal':access.principal,'roles':access.roles,'mode':'local-simulation'}}
