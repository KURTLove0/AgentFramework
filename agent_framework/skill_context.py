"""Three-tier disclosure from frozen packages; activation grants no capabilities."""
import re
from .contracts import digest
from .skills import package_catalog,validate_frozen
from .structured import obj


def schemas(profile):
    catalog=package_catalog(profile);refs=[s['ref'] for s in catalog]
    paths=sorted({p for s in profile.get('skill_packages',[]) if s['enabled'] for p in s['package']['files'] if p!='SKILL.md'})
    return {
        'skill_activate':obj({'activate':{'type':'array','maxItems':8,'items':{'type':'string','enum':refs}}}),
        'skill_resources':obj({'reads':{'type':'array','maxItems':16,'items':obj({'ref':{'type':'string','enum':refs},'path':{'type':'string','enum':paths or ['SKILL.md']}})}})}


def bundle(profile,selection):
    packages={s['ref']:s['package'] for s in (profile or {}).get('skill_packages',[]) if s['enabled']}
    if not selection:return []
    if not isinstance(selection,dict) or set(selection)!={'activated_refs','resource_reads','ready'} or type(selection['ready']) is not bool:raise ValueError('Skill 激活状态无效')
    refs=selection['activated_refs'];reads=selection['resource_reads']
    if not isinstance(refs,list) or len(refs)!=len(set(refs)) or set(refs)-packages.keys():raise ValueError('Skill 激活越过 Agent 绑定范围')
    if not isinstance(reads,list) or len(reads)>16:raise ValueError('Skill 资源读取数量无效')
    out=[];size=0;seen=set()
    for ref in refs:
        package=packages[ref];validate_frozen(package)
        out.append({'ref':ref,'name':package['name'],'package_hash':package['hash'],'metadata':package['metadata'],'instructions':package['body'],
                    'resource_catalog':[{'path':p,'size':v['size'],'hash':v['hash'],'encoding':v['encoding']} for p,v in package['files'].items() if p!='SKILL.md'],'resources':[]})
        size+=len(package['body'].encode())
    for read in reads:
        if not isinstance(read,dict) or set(read)!={'ref','path'} or read['ref'] not in refs:raise ValueError('Skill 资源须属于已激活包')
        package=packages[read['ref']];path=read['path']
        if path=='SKILL.md' or path not in package['files'] or (read['ref'],path) in seen:raise ValueError('Skill 资源路径无效或重复')
        seen.add((read['ref'],path));file=package['files'][path]
        entry={'path':path,'hash':file['hash'],'encoding':file['encoding']}
        if file['encoding']=='utf-8':entry['content']=file['content'];size+=file['size']
        else:entry['note']='二进制资产保留在包中，不作为指令注入；可从 Skill 管理模块导出。'
        next(s for s in out if s['ref']==read['ref'])['resources'].append(entry)
    if size>128000:raise ValueError('Skill 已加载内容超过 128 KB 上下文预算')
    return out


def prepare(planner,context,profile,checkpoint,is_model=False):
    catalog=package_catalog(profile)
    if not catalog:return context
    state=context['state'];selection=state.get('skill_context')
    if selection is None:
        if is_model:refs=planner._request('skill_activate',context)['activate']
        else:
            from .knowledge import tokens
            terms=set(tokens(state['task']['goal']))
            refs=[s['ref'] for s in catalog if '$'+s['name'] in state['task']['goal'] or terms.intersection(tokens(s['description']+' '+s['name']))]
        explicit=[s['ref'] for s in catalog if re.search(r'\$'+re.escape(s['name'])+r'(?![\w-])',state['task']['goal'])]
        selection={'activated_refs':list(dict.fromkeys(refs+explicit)),'resource_reads':[],'ready':False}
        bundle(profile,selection);state['skill_context']=selection
        checkpoint('skill.activated',{'refs':selection['activated_refs'],'catalog_hash':digest(catalog)})
    activated=bundle(profile,selection)
    context={**context,'activated_skills':activated}
    if not selection['ready']:
        if selection['activated_refs']:
            if is_model:reads=planner._request('skill_resources',context)['reads']
            else:
                reads=[]
                for s in activated:
                    for path in re.findall(r'\]\(([^)\s]+)\)',s['instructions']):
                        path=path.split('#')[0].removeprefix('./')
                        if path in {r['path'] for r in s['resource_catalog']}:reads.append({'ref':s['ref'],'path':path})
            next_selection={**selection,'resource_reads':reads,'ready':True}
        else:next_selection={**selection,'ready':True}
        activated=bundle(profile,next_selection);state['skill_context']=next_selection
        checkpoint('skill.resources_loaded',{'reads':next_selection['resource_reads'],'context_hash':digest(activated)})
    return {**context,'activated_skills':activated}


def for_message(profile,message,generate=None):
    """Conversation designers use the same disclosure contract, without business tools."""
    catalog=package_catalog(profile)
    if not catalog:return None
    contract=schemas(profile)
    if generate:refs=generate('skill_activate',{'available_skills':catalog,'message':message},contract['skill_activate'])['activate']
    else:
        from .knowledge import tokens
        terms=set(tokens(message));refs=[s['ref'] for s in catalog if terms.intersection(tokens(s['name']+' '+s['description']))]
    refs+= [s['ref'] for s in catalog if re.search(r'\$'+re.escape(s['name'])+r'(?![\w-])',message)]
    selection={'activated_refs':list(dict.fromkeys(refs)),'resource_reads':[],'ready':False};activated=bundle(profile,selection)
    if activated:
        if generate:reads=generate('skill_resources',{'available_skills':catalog,'message':message,'activated_skills':activated},contract['skill_resources'])['reads']
        else:
            reads=[{'ref':s['ref'],'path':path.split('#')[0].removeprefix('./')} for s in activated for path in re.findall(r'\]\(([^)\s]+)\)',s['instructions']) if path.split('#')[0].removeprefix('./') in {r['path'] for r in s['resource_catalog']}]
    else:reads=[]
    selection={**selection,'resource_reads':reads,'ready':True}
    return {'selection':selection,'activated_skills':bundle(profile,selection)}
