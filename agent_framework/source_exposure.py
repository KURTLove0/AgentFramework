"""Knowledge actually supplied by a context manifest or verified governed read."""
import json

from .contracts import canonical,digest
from .conversation_history import compact_citations


KNOWLEDGE_READS={'knowledge.read@1.0.0':'documents','knowledge.search@1.0.0':'hits'}


def exposed_sources(store,db,tenant,project,manifests):
    result={identity:{'valid':True,'sources':[]} for identity in manifests}
    expected={identity:{} for identity in manifests};native={identity:{} for identity in manifests}
    for identity,records in manifests.items():
        try:
            for record in records:
                for selected in record.get('selected',[]):
                    if selected['kind']=='KNOWLEDGE':
                        result[identity]['sources'].extend(compact_citations([{'asset_ref':selected['ref'],'content_hash':selected['content_hash']}]))
                for evidence in record.get('evidence',[]):
                    ref=evidence['ref'];content_hash=evidence['content_hash']
                    if not isinstance(ref,str) or not ref or not isinstance(content_hash,str) or not content_hash:
                        raise ValueError('invalid context evidence identity')
                    expected[identity].setdefault(ref,set()).add(content_hash)
        except (KeyError,TypeError,ValueError):result[identity]['valid']=False
    if manifests and store._optional_table_available(db,'native_reads'):
        slots=','.join('?' for _ in manifests)
        rows=db.execute("SELECT run_id,id,json_extract(data,'$.id','$.ref','$.evidence_ref') AS fields FROM native_reads "
            'WHERE tenant_id=? AND run_id IN ('+slots+
            ") AND json_extract(data,'$.status')='VERIFIED' AND json_extract(data,'$.ref') IN ('knowledge.read@1.0.0','knowledge.search@1.0.0')",(tenant,*manifests))
        for row in rows:
            try:
                identity,ref,evidence_ref=json.loads(row['fields'])
                if identity!=row['id'] or not isinstance(evidence_ref,str) or not evidence_ref:
                    raise ValueError('invalid native evidence identity')
                previous=native[row['run_id']].setdefault(evidence_ref,ref)
                if previous!=ref:raise ValueError('conflicting native evidence source')
            except (TypeError,ValueError):result[row['run_id']]['valid']=False
    wanted={(identity,ref) for identity in manifests for ref in expected[identity].keys()|native[identity].keys()}
    remaining=set(wanted)
    if wanted:
        # JSON pairs keep parameter count bounded while using the evidence PK.
        rows=db.execute('''SELECT e.run_id,e.id,e.data FROM json_each(?) wanted JOIN evidence e
            ON e.tenant_id=? AND e.run_id=json_extract(wanted.value,'$[0]') AND e.id=json_extract(wanted.value,'$[1]')''',
            (canonical(sorted(wanted)),tenant))
        for row in rows:
            identity=row['run_id'];ref=row['id'];remaining.discard((identity,ref))
            try:
                evidence=json.loads(row['data']);data=evidence['data'];source=evidence['source'];hashed=digest(data)
                if (evidence['id']!=ref or evidence['tenant_id']!=tenant or evidence['run_id']!=identity
                    or evidence['content_hash']!=hashed
                    or any(value!=hashed for value in expected[identity].get(ref,()))
                    or ref in native[identity] and native[identity][ref]!=source):
                    raise ValueError('invalid exposed evidence')
                if source not in KNOWLEDGE_READS:continue
                if data['tenant_id']!=tenant or data['project_id']!=project:
                    raise ValueError('exposed knowledge outside scope')
                documents=data[KNOWLEDGE_READS[source]]
                if not isinstance(documents,list):raise ValueError('invalid exposed knowledge')
                result[identity]['sources'].extend(compact_citations([
                    {'asset_ref':document['ref'],'content_hash':document['content_hash']} for document in documents]))
            except (KeyError,TypeError,ValueError):result[identity]['valid']=False
    for identity,_ in remaining:result[identity]['valid']=False
    for record in result.values():
        record['sources']=compact_citations(record['sources']) if record['valid'] else []
    return result
