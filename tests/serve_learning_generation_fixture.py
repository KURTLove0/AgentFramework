"""Restart an isolated service after an interrupted offline ontology generation."""
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

from agent_framework.learning import Learning, agent_generate
from agent_framework.web import Application, WebServer
from tests.test_learning_acceptance import profile


if __name__ == '__main__':
    root = tempfile.mkdtemp(prefix='learning-generation-browser-', dir='/private/tmp')
    seed = Application(root)
    agent = seed.agents.save(profile())
    library, access = seed.library(), seed.library_access()
    sources = []
    for name in ('保留的会议资料', '已撤回的补充资料'):
        source = library.create(access, {'title': name, 'content': {'text': '会议记录应包含负责人、行动项和原始依据。'}})
        library.transition(access, source['ref'], 'REVIEW')
        sources.append(library.transition(access, source['ref'], 'PUBLISHED'))
    request = dict(request_id='interrupted-browser-generation', purpose='ontology', source_refs=[s['ref'] for s in sources],
                   agent_id=agent['id'], agent_revision=1, instruction='保留原始要求：抽取会议中的概念与关系，并明确来源。', operational=False, consent=False)
    class ProcessExit(BaseException): pass
    with patch('agent_framework.learning.agent_generate', side_effect=ProcessExit):
        try: Learning(seed).generate(request)
        except ProcessExit: pass
    pending = Learning(seed).get_by_request(request['request_id'])
    with seed.control_store.transaction() as db:
        db.execute("UPDATE learning_proposals SET data=json_set(data,'$.generation_claim.expires_at',0) WHERE id=?", (pending['id'],))
    changed = profile(1); changed['prompt'] = '更新后的指令：明确缺失信息并保留原始依据。'
    seed.agents.save(changed, agent['id'])
    library.transition(access, sources[1]['ref'], 'WITHDRAWN')
    seed.close()
    evidence = {'proposal_id': pending['id'], 'request': request, 'agent_id': agent['id'], 'available_ref': sources[0]['ref'], 'withdrawn_ref': sources[1]['ref'], 'new_model_calls': 0}
    path = Path(os.environ['AUDIT_FIX_SEED']); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(evidence), encoding='utf-8')
    def generate(*args):
        evidence['new_model_calls'] += 1
        path.write_text(json.dumps(evidence), encoding='utf-8')
        if args[1]['runtime'] != 'mock': raise ValueError('Only offline models are allowed in this fixture')
        return agent_generate(*args)
    with patch('agent_framework.learning.agent_generate', side_effect=generate):
        app = Application(root)
        server = WebServer(('127.0.0.1', int(os.environ['LEARNING_GENERATION_PORT'])), app)
        print('Restarted isolated data: ' + root, flush=True)
        try: server.serve_forever()
        except KeyboardInterrupt: pass
        finally: server.server_close(); app.close()
