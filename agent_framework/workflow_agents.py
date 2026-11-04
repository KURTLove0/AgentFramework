"""Reviewable specialist drafts; creation is committed with the workflow."""
from copy import deepcopy

from .agents import text
from .contracts import identifier
from .definitions import AgentCompiler,default_definition
from .runtime_config import ConfigConflict


def prepare_drafts(app,drafts):
    if not isinstance(drafts,list) or len(drafts)>12:raise ValueError('最多创建 12 个流程智能体')
    normalized=[];profiles={};sources={};configuration_revision=None
    for draft in drafts:
        fields={'id','name','description','prompt','source_agent_id','source_agent_revision'}
        if not isinstance(draft,dict) or set(draft)!=fields:raise ValueError('新智能体需要名称、职责、执行指令和运行时来源')
        value=deepcopy(draft);identity=identifier(value['id'])
        if not identity.startswith('draft-agent-') or identity in profiles:raise ValueError('新智能体的临时 ID 无效或重复')
        value['name']=text(value['name'],'新智能体名称',80)
        value['description']=text(value['description'],'新智能体职责',500)
        value['prompt']=text(value['prompt'],'新智能体执行指令',8000)
        source=value['source_agent_id'];revision=value['source_agent_revision']
        if not isinstance(source,str) or type(revision) is not int:raise ValueError('运行时来源版本无效')
        if source:
            profile=app.agents.get(identifier(source))
            if profile['archived'] or profile['revision']!=revision:raise ConfigConflict('新智能体的运行时来源已更新或停用，请重新选择')
            runtime,model,options=profile['runtime'],profile['model'],deepcopy(profile['options'])
            sources[source]=revision
        else:
            if revision!=0:raise ValueError('默认运行时来源版本应为 0')
            settings=app.configuration.get();configuration_revision=settings['revision'];runtime=settings['default_runtime']
            config=deepcopy(settings['profiles'].get(runtime,{}));model=config.pop('model','builtin');options=config
        profile,_,_=app.agents.prepare(dict(name=value['name'],description=value['description'],prompt=value['prompt'],runtime=runtime,model=model,options=options,
            skills=[],mcp_servers=[],definition=default_definition(value['name'],'general-assistant@1.0.0'),revision=0))
        profile.update(id=identity,revision=1,archived=False)
        AgentCompiler().compile(profile)
        normalized.append(value);profiles[identity]=profile
    return normalized,profiles,sources,configuration_revision


def check_sources(db,app,sources,configuration_revision):
    for identity,revision in sources.items():
        row=db.execute('SELECT revision,archived FROM agent_profiles WHERE tenant=? AND workspace_id=? AND id=?',
            (app.tenant,app.workspace['id'],identity)).fetchone()
        if not row or row['archived'] or row['revision']!=revision:raise ConfigConflict('新智能体的运行时来源已更新或停用，请重新选择')
    if configuration_revision is not None:
        row=db.execute('SELECT revision FROM runtime_configuration WHERE tenant=?',(app.tenant,)).fetchone()
        if (row['revision'] if row else 0)!=configuration_revision:raise ConfigConflict('默认运行时已更新，请重新保存')
