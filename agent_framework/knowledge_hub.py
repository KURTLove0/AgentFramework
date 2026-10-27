"""One scoped read model for knowledge, memory, experience and executable abilities."""
from .definitions import capability_definitions,get_domain,AgentCompiler
from .experience import ExperienceService
from .memory import episodes
from .knowledge import tokens


def hub(app,query=''):
    if not isinstance(query,str) or len(query)>2000:raise ValueError('检索内容过长')
    access=app.library_access();library=app.library();assets=library.list(access,include_unpublished=True)
    terms=set(tokens(query))
    from .ontology import expand
    semantic=expand(library,access,query);semantic_refs=set(semantic['source_refs'])|{item['ontology_ref'] for item in semantic['concepts']}
    def matches(value):return not query.strip() or (isinstance(value,dict) and value.get('ref') in semantic_refs) or bool(terms.intersection(tokens(str(value))))
    exp=ExperienceService(app.runtime().store).list(access)
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
            'memory':{'preferences':[a for a in assets if a['kind']=='PREFERENCE' and matches(a)],'notes':[a for a in assets if a['kind']=='MEMORY' and matches(a)],'episodes':episodes(app.runtime().store,access,query,limit=50)},
            'experience':[a for a in exp if matches(a)],'capabilities':[c for c in caps if matches(c)],
            'capability_methods':[a for a in assets if a['kind']=='CAPABILITY' and matches(a)],'ontologies':ontologies,'ontology_matches':semantic['concepts'],
            'skills':[get_domain(ref).descriptor()['skill'] for ref in ('general-assistant@1.0.0','change-assessment@2.0.0','knowledge-answer@1.0.0')],
            'counts':{'knowledge':sum(a['kind']=='KNOWLEDGE' for a in assets),'preferences':sum(a['kind']=='PREFERENCE' for a in assets),'notes':sum(a['kind']=='MEMORY' for a in assets),'episodes':len(episodes(app.runtime().store,access,limit=50)),'experience':len(exp),'capabilities':len(caps),'capability_methods':sum(a['kind']=='CAPABILITY' for a in assets),'ontologies':sum(a['kind']=='ONTOLOGY' for a in assets)},
            'identity':{'principal':access.principal,'roles':access.roles,'mode':'local-simulation'}}
