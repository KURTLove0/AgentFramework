"""Track sources exposed by prior conversation text, separately from citations."""
import json

from .contracts import digest
from .conversation_history import compact_citations,is_redacted
from .source_exposure import exposed_sources


def history_sources(messages,redacted=()):
    sources=[]
    for message in messages:
        if message['role']!='assistant' or message['turn'] in redacted or is_redacted(message):continue
        sources.extend(compact_citations(message.get('citations',[])))
        sources.extend(compact_citations(message.get('source_dependencies',[])))
    return compact_citations(sources)


def dependencies(store,db,tenant,principal,project,identities,*,prior=None):
    """Read source lineage in the caller's snapshot, including pre-lineage tasks.

    A reply may use any visible prior answer. This records exposure, not a claim
    that a particular sentence used a particular source or cited it explicitly.
    """
    if not identities:return {}
    identities=list(dict.fromkeys(identities));slots=','.join('?' for _ in identities)
    manifests={identity:[] for identity in identities};result={};prior=prior or {}
    if store._optional_table_available(db,'context_manifests'):
        for row in db.execute('SELECT run_id,data FROM context_manifests WHERE tenant=? AND run_id IN ('+slots+
                              ") AND json_extract(data,'$.phase') IN ('execute','skill_activate','skill_resources') ORDER BY rowid",(tenant,*identities)):
            manifest=json.loads(row['data']);identity=row['run_id']
            try:
                valid=(manifest['run_id']==identity and manifest['scope']['principal']==principal
                       and manifest['scope']['project_id']==project
                       and manifest['scope']['environment']=='test'
                       and digest({k:v for k,v in manifest.items() if k!='hash'})==manifest['hash'])
                if not valid:raise ValueError('invalid history manifest')
                manifests[identity].append(manifest)
            except (KeyError,TypeError,ValueError):result[identity]={'valid':False,'sources':[]}
    exposed=exposed_sources(store,db,tenant,project,manifests)
    for identity,record in exposed.items():
        if not record['valid']:result[identity]={'valid':False,'sources':[]}
    legacy=[identity for identity,records in manifests.items()
            if not records or any('conversation_sources' not in record for record in records)]
    frozen={}
    if legacy:
        slots=','.join('?' for _ in legacy)
        for row in db.execute("SELECT id,json_extract(state,'$.task.conversation_context') AS context FROM runs "
                              'WHERE tenant_id=? AND id IN ('+slots+
                              ") AND json_type(state,'$.task.conversation_context')='object'",(tenant,*legacy)):
            frozen[row['id']]=json.loads(row['context'])
    visiting=set()
    def inherited(context,redacted):
        sources=history_sources(context['messages'],redacted)
        for message in context['messages']:
            if message['role']!='assistant' or message['turn'] in redacted or is_redacted(message):continue
            parent=resolve(message['run_id'])
            if not parent['valid']:raise ValueError('unverifiable historical source dependency')
            sources.extend(parent['sources'])
        return sources
    def resolve(identity):
        if identity in result:return result[identity]
        if identity not in manifests:return prior.get(identity,{'valid':False,'sources':[]})
        if identity in visiting:raise ValueError('cyclic historical source dependency')
        visiting.add(identity);records=manifests[identity]
        try:
            sources=list(exposed[identity]['sources']);context=frozen.get(identity)
            if not records and context:sources.extend(inherited(context,()))
            for record in records:
                if 'conversation_sources' in record:
                    sources.extend(compact_citations(record['conversation_sources']))
                elif context:
                    if record.get('conversation_history_hash')!=context['history_hash']:
                        raise ValueError('history manifest does not match frozen context')
                    redacted=record.get('conversation_redactions',[])
                    if not isinstance(redacted,list) or any(type(n) is not int for n in redacted):
                        raise ValueError('invalid history redactions')
                    sources.extend(inherited(context,redacted))
                elif record.get('conversation_history_hash') is not None:
                    raise ValueError('missing frozen history')
            sources=compact_citations(sources)
            result[identity]={'valid':True,'sources':sources}
        except (KeyError,TypeError,ValueError):result[identity]={'valid':False,'sources':[]}
        finally:visiting.remove(identity)
        return result[identity]
    for identity in identities:resolve(identity)
    return result
