"""Per-cognition context compiler; exact working facts remain in Store.

Mandatory constraints/evidence are never trimmed. Optional knowledge and memory
are bounded and untrusted. A persisted manifest explains each inclusion/exclusion.
"""
from copy import deepcopy
import time
from uuid import uuid4

from .contracts import canonical, digest
from .knowledge import Access, Library, KnowledgeUnavailable
from .memory import episodes


def build(store, state, phase, base):
    binding=state['snapshot'].get('context_policy')
    if not binding:return base, None
    library=Library(store);access=Access.task(state['task'])
    required=library.validate_required(state)
    # Read-only answer evidence can be withdrawn after its original observation.
    # Check before another model call, not only after generating the answer.
    observed_sources=state['observations'].get('knowledge_documents',{}).get('data',{}).get('documents',[])+state['observations'].get('knowledge_hits',{}).get('data',{}).get('hits',[])
    for doc in observed_sources:
        try:current=library.get(access,doc['ref'])
        except KeyError:raise KnowledgeUnavailable('cited knowledge is no longer accessible')
        if current['status']!='PUBLISHED' or current['content_hash']!=doc['content_hash'] or not current['effective_at']<=time.time()<current['effective_until']:
            raise KnowledgeUnavailable('cited knowledge withdrawn, expired or changed')
    retrieval=state['task'].get('retrieval')
    result=library.search(access,retrieval['query'] if retrieval else state['task']['goal'],spaces=binding['spaces'],for_context=True,
                          limit=50 if retrieval else 12)
    if retrieval:
        result['items']=([a for a in result['items'] if a['kind']=='KNOWLEDGE'][:retrieval['top_k']]
                         +[a for a in result['items'] if a['kind']!='KNOWLEDGE'][:12])
    conflicts=[item for item in result['excluded'] if item['critical'] and item['reason']=='conflicting-published-sources' and item.get('standard_ref') in state['snapshot']['compiled_agent']['definition']['standard_refs']]
    if conflicts:raise KnowledgeUnavailable('conflicting critical knowledge requires review')
    allowed_evidence={}
    policy_excluded=[]
    for ref,item in base['evidence'].items():
        permitted=True
        if item['source'] in ('knowledge.read@1.0.0','knowledge.search@1.0.0'):
            for doc in item['data'].get('documents',[])+item['data'].get('hits',[]):
                try:current=library.get(access,doc['ref'])
                except (KeyError,KnowledgeUnavailable):permitted=False;break
                if current['status']!='PUBLISHED' or current['content_hash']!=doc['content_hash'] or not current['effective_at']<=time.time()<current['effective_until']:
                    permitted=False;break
        if permitted:allowed_evidence[ref]=item
        else:policy_excluded.append({'ref':ref,'reason':'historical-source-access-withdrawn'})
    base={**base,'evidence':allowed_evidence}
    if phase=='plan' and state['replans']:
        # Preserve old plans in audit, without carrying withdrawn quotations into a new plan.
        base['state']={**state,'plan':[]}
    pinned={a['id']:a for a in required}
    candidates=required+[a for a in result['items'] if a['id'] not in pinned]
    selected=[];excluded=list(result['excluded'])+policy_excluded;seen=set();used=0;knowledge=[];preferences=[];experience=[]
    required_refs={a['ref'] for a in required}
    for asset in candidates:
        if asset['kind']=='EXPERIENCE' and asset['content']['conditions']['domain_pack_ref'] != state['snapshot']['compiled_agent']['domain_pack']['ref']:
            excluded.append({'ref':asset['ref'],'reason':'experience-domain-not-applicable'})
            continue
        content_key=digest([asset['kind'],asset['content']])
        record={'ref':asset['ref'],'kind':asset['kind'],'content_hash':asset['content_hash'],
                'source_uri':asset['source_uri'],'source_version':asset['source_version'],
                'effective_until':asset['effective_until'],'reason':'required-standard' if asset['ref'] in required_refs else 'scoped-retrieval'}
        size=len(canonical(asset['content']).encode())
        if content_key in seen:
            excluded.append({'ref':asset['ref'],'reason':'duplicate-content'});continue
        if asset['ref'] not in required_refs and used+size>binding['max_optional_bytes']:
            excluded.append({'ref':asset['ref'],'reason':'optional-context-budget'});continue
        seen.add(content_key)
        if asset['ref'] not in required_refs:used+=size
        selected.append(record)
        item={key:asset[key] for key in ('ref','title','content','content_hash','source_uri','source_version','observed_at')}
        {'KNOWLEDGE':knowledge,'PREFERENCE':preferences,'EXPERIENCE':experience}[asset['kind']].append(item)
    # A private episode is historical evidence of one run, never a general rule.
    recalled=[]
    for episode in episodes(store,access,state['task']['goal'],limit=3):
        if episode['run_id']==state['run_id']:continue
        item={k:episode[k] for k in ('run_id','summary','outcome','domain_pack_ref','evidence_refs')}
        size=len(canonical(item).encode())
        if used+size>binding['max_optional_bytes']:
            excluded.append({'ref':'episode:'+episode['run_id'],'reason':'optional-context-budget'});continue
        used+=size;recalled.append(item)
        selected.append({'ref':'episode:'+episode['run_id'],'kind':'EPISODE','content_hash':digest(item),'reason':'same-principal-history'})
    manifest={'id':'context-'+uuid4().hex[:16],'run_id':state['run_id'],'phase':phase,
              'policy_ref':binding['ref'],'created_at':time.time(), 'scope':{'project_id':access.project,'environment':access.environment,'principal':access.principal},
              'selected':selected,'excluded':excluded,
              'evidence':[{'ref':key,'content_hash':value['content_hash']} for key,value in base['evidence'].items()],
              'budget':{'optional_bytes':used,'max_optional_bytes':binding['max_optional_bytes'],'mandatory_evidence_trimmed':False}}
    manifest['hash']=digest(manifest)
    preferences.sort(key=lambda item:item['observed_at'])
    presentation={}
    for item in preferences:presentation.update(item['content'])
    bundle={**base,'knowledge':knowledge,'memory':{'preferences':preferences,'presentation':presentation,'episodes':recalled},'experience':experience,
            'context_manifest':{k:manifest[k] for k in ('id','hash','policy_ref','selected','budget')}}
    return bundle,manifest


def enrich_mock(result, context, phase):
    """Deterministic cognition fixture that actually consumes the compiled context."""
    if not context.get('context_manifest'):return result
    if phase=='plan':
        refs=[a['ref'] for a in context['knowledge']+context['experience']]
        if refs:return [{'id':'context','description':'参考已治理资料与已发布经验：'+', '.join(refs),'tool_ref':None}]+result
    if phase=='compose' and context['state']['snapshot']['compiled_agent']['domain_pack']['ref']=='change-assessment@2.0.0':
        from .structured import REPORT, SchemaError, validate
        try:validate(result,REPORT)
        except SchemaError:return result
        result=deepcopy(result)
        # Resolve presentation in the context compiler; it never changes facts.
        choices=context['memory']['presentation']
        prefix=choices.get('report_title_prefix','')
        if prefix:result['title']=prefix+result['title']
        if choices.get('language')=='en':
            change=context['state']['observations']['change']['data']
            result['sections']={
                'summary':f"Change {change['id']} version {change['version']}; risk {result['risk_level']}.",
                'impact':f"Service: {change['service']}; dependencies: {', '.join(change['dependencies']) or 'none'}.",
                'risks':f"Risk is {result['risk_level']} under release-review-rubric@1.0.0.",
                'test_results':f"Tests: {change['tests']['passed']} passed; {change['tests']['failed']} failed.",
                'rollback':'Rollback source: '+change['rollback'],
                'recommendation':'Retain this draft for manual review; resolve failed tests before any release decision.'}
        if choices.get('report_style')=='detailed':
            evidence=context['state']['observations']['change']['id']
            for key in result['sections']:result['sections'][key]+=' ['+evidence+']'
        if context['knowledge']:
            refs='、'.join(a['ref'] for a in context['knowledge'])
            result['sections']['summary']+=' 资料依据：'+refs+'。'
        for experience in context['experience']:
            result['limitations'].append('参考经验 '+experience['ref']+'：'+experience['content']['lesson'])
    return result
