'use strict';

const commandSources={runs:'任务运行',agents:'智能体',flows:'工作流定义',flowRuns:'流程运行',skills:'技能',library:'知识与资料'};
function commandScope(){return {workspace:state.workspaceId,tenant:state.meta?.tenant,principal:state.meta?.principal};}
function commandScopeMatches(scope){const now=commandScope();return scope&&Object.keys(now).every(key=>scope[key]===now[key]);}
function commandCurrent(session){return state.commandSession===session&&$('#command-dialog').open&&commandScopeMatches(session.scope)&&session.route===location.hash&&session.routeVersion===state.routeVersion;}
function commandRemember(session){if(session&&commandScopeMatches(session.scope))state.commandHistory={scope:session.scope,query:$('#command-input').value,selectedKey:state.commandSelectedKey,page:state.commandPage||0};}
function closeCommandSearch(activated=false){
 const session=state.commandSession;if(!session)return;
 commandRemember(session);session.activated=activated;clearTimeout(session.timer);state.commandSession=null;
 if($('#command-dialog').open)$('#command-dialog').close();
 if(!activated&&commandScopeMatches(session.scope)&&session.route===location.hash&&!$$('dialog[open]').length){const target=session.opener?.isConnected?session.opener:$('[data-action="command"]');target?.focus({preventScroll:true});}
}
function startCommandSearch(){
 if($('#command-dialog').open||$$('dialog[open]').length)return;
 const scope=commandScope(),history=commandScopeMatches(state.commandHistory?.scope)?state.commandHistory:null;
 const session={scope,route:location.hash,routeVersion:state.routeVersion,query:(history?.query||'').trim(),opener:document.activeElement,sources:{},generation:0,resumeKey:history?.selectedKey||null};
 state.commandSession=session;state.commandPage=history?.page||0;state.commandIndex=0;state.commandSelectedKey=history?.selectedKey||null;
 $('#command-input').value=history?.query||'';$('#command-dialog').showModal();$('#command-input').focus();
 for(const key of Object.keys(commandSources))session.sources[key]={pending:true,data:null,error:'',generation:0,query:session.query};
 renderCommands();
 return Promise.all(Object.keys(commandSources).map(key=>readCommandSource(session,key)));
}
function commandSourcePath(key,query){
 return ({runs:'/api/runs?limit=50&visibility=all&search='+encodeURIComponent(query),agents:'/api/agents?view=catalog',flows:'/api/workflows?view=definitions',flowRuns:'/api/workflow-runs?limit=50&search='+encodeURIComponent(query),skills:'/api/skills',library:'/api/knowledge-hub?query='+encodeURIComponent(query)})[key];
}
async function readCommandSource(session,key){
 if(!commandCurrent(session))return false;
 const source=session.sources[key],generation=++source.generation,query=session.query;
 source.pending=true;source.retrying=Boolean(source.error);source.error='';source.data=null;source.query=query;renderCommands();
 try{
  const data=await api(commandSourcePath(key,query),undefined,15000,true,{workspace:session.scope.workspace,payload:undefined});
  if(!commandCurrent(session)||generation!==source.generation||(['runs','library','flowRuns'].includes(key)&&query!==session.query))return false;
  source.data=data;source.pending=false;source.retrying=false;renderCommands();return true;
 }catch(error){
  if(!commandCurrent(session)||generation!==source.generation||(['runs','library','flowRuns'].includes(key)&&query!==session.query))return false;
  source.pending=false;source.retrying=false;source.error=error.message||'读取未完成';renderCommands();return false;
 }
}
function retryCommandSource(key){const session=state.commandSession,source=session?.sources[key];if(!session||!commandCurrent(session)||!source||source.pending)return;return readCommandSource(session,key);}
function scheduleCommandSearch(){
 const session=state.commandSession;if(!session||!commandCurrent(session))return;
 clearTimeout(session.timer);session.query=$('#command-input').value.trim();session.generation++;session.resumeKey=null;
 state.commandIndex=0;state.commandPage=0;state.commandSelectedKey=null;
 for(const key of ['runs','library','flowRuns']){const source=session.sources[key];source.generation++;source.data=null;source.error='';source.retrying=false;source.pending=true;source.query=session.query;}
 commandRemember(session);renderCommands();
 const generation=session.generation;
 session.timer=setTimeout(()=>{if(commandCurrent(session)&&generation===session.generation)Promise.all(['runs','library','flowRuns'].map(key=>readCommandSource(session,key)));},260);
}
function openLibraryAsset(ref,tab){state.libraryTab=tab;state.libraryFocusRef=ref;state.libraryQuery='';state.librarySearch='';state.libraryStatus='';navigate('library');}
function openCommandWorkflow(identity){state.flowSection='definitions';state.commandFlowTarget={id:identity,scope:commandScope()};state.flows=null;navigate('workflows');}
function focusCommandWorkflow(){
 const target=state.commandFlowTarget;if(!target)return;
 if(!commandScopeMatches(target.scope)){state.commandFlowTarget=null;return;}
 if(state.view!=='workflows'||state.selected||!state.flows)return;
 const card=document.getElementById('flow-definition-'+target.id);state.commandFlowTarget=null;
 if(!card){toast('这条流程定义已不可用，可重新搜索或查看当前目录。');return;}
 const details=card.querySelector('details');if(details)details.open=true;
 card.scrollIntoView({block:'center',behavior:'instant'});if(!$$('dialog[open]').length)card.focus({preventScroll:true});
}
function openCommandRuns(query){
 state.search=query;state.runVisibility='all';state.runFavorites='all';state.filter='all';state.runAgent='';state.runDomain='';state.runAfter='';state.runBefore='';state.runSort='created_desc';state.runCursor=null;state.runCursorStack=[];state.runPage=null;navigate('runs');
}
function commandResourceItems(query){
 const session=state.commandSession;if(!session||!commandCurrent(session))return [];
 const ready=key=>{const source=session.sources[key];return !source.pending&&!source.error?source.data:null;};
 const runs=ready('runs'),agents=ready('agents'),flows=ready('flows'),flowRuns=ready('flowRuns'),skills=ready('skills'),hub=ready('library'),items=[];
 items.push(...(runs?.runs||[]).map(r=>({key:'run:'+r.run_id,group:'运行',title:r.title||r.goal,sub:(r.search_match&&typeof runTextMatchSummary==='function'?runTextMatchSummary(r.search_match)+' · ':'')+r.run_id+(r.archive?.archived?' · 已归档':'')+' · '+(labels[r.status]||r.status||scenario(r.scenario)),icon:'file',matched:true,fn:()=>{if(r.search_match&&typeof openRunTextMatch==='function')openRunTextMatch(r,session.query);else navigate('runs',r.run_id);}})));
 if(query&&runs?.filtered_total>(runs?.runs||[]).length)items.push({key:'runs:all',group:'运行',title:'查看全部 '+runs.filtered_total+' 条匹配运行',sub:'保留本次关键词，打开可翻页的运行列表',icon:'list',matched:true,fn:()=>openCommandRuns(session.query)});
 items.push(...(agents?.agents||[]).map(a=>({key:'agent:'+a.id,group:'智能体',title:a.name,sub:(a.description||a.definition?.identity?.role||'Agent')+' · '+(a.archived?'已归档':'可用')+' · '+a.id,icon:'agent',fn:()=>navigate('agents',a.id)})));
 items.push(...(flows?.workflows||[]).map(w=>({key:'flow:'+w.id,group:'工作流定义',title:w.name,sub:(w.description||'')+' · '+(w.archived?'已归档':'v'+w.revision)+' · '+w.nodes.length+' 个节点 · '+w.id,icon:'flow',fn:()=>openCommandWorkflow(w.id)})));
 items.push(...(flowRuns?.runs||[]).map(r=>({key:'flow-run:'+r.id,group:'工作流运行',title:r.name,sub:r.id+' · '+(typeof flowLabels!=='undefined'?flowLabels[r.display_status||r.status]:r.status),icon:'flow',matched:true,fn:()=>{state.flowSection='runs';navigate('workflows',r.id);}})));
 if(query&&flowRuns?.filtered_total>(flowRuns?.runs||[]).length)items.push({key:'flow-runs:all',group:'工作流运行',title:'查看全部 '+flowRuns.filtered_total+' 条匹配流程运行',sub:'保留关键词，打开可翻页的流程历史',icon:'list',matched:true,fn:()=>{const h=flowHistory();Object.assign(h,{search:session.query,status:'all',cursor:null,stack:[],data:null,error:''});h.request++;state.flowSection='runs';navigate('workflows');}});
 items.push(...(skills?.skills||[]).map(s=>({key:'skill:'+s.id,group:'技能',title:s.name,sub:(s.metadata?.description||'')+' · '+(s.archived?'已归档':s.status||'')+' · '+s.id,icon:'puzzle',fn:()=>{navigate('skills');openSkillEditor(s.id,'view');}})));
 if(hub){
  const groups=[['knowledge',hub.knowledge||[],'知识'],['memory',hub.memory?.preferences||[],'私有偏好'],['memory',hub.memory?.notes||[],'工作记忆'],['experience',hub.experience||[],'经验'],['capabilities',hub.capability_methods||[],'能力方法'],['ontology',hub.ontologies||[],'业务本体']];
  for(const [tab,assets,label] of groups)items.push(...assets.map(a=>({key:'asset:'+a.ref,group:label,title:a.title,sub:(typeof assetStatuses!=='undefined'?assetStatuses[a.status]:a.status)+' · 资料版本 v'+(a.version||a.source_version)+' · '+a.ref,icon:tab==='ontology'?'box':'book',matched:true,fn:()=>openLibraryAsset(a.ref,tab)})));
 }
 return items.filter(item=>item.matched||(item.title+' '+item.sub+' '+item.group).toLowerCase().includes(query.toLowerCase()));
}
function commandActions(){
 return [{key:'new',title:'新建任务',icon:'plus',fn:()=>newTask()},...Object.entries(pageNames).map(([view,title])=>({key:'nav:'+view,title,icon:({workbench:'grid',runs:'list',agents:'agent',workflows:'flow',skills:'puzzle',library:'book',daily:'clock',evaluations:'shield',workspaces:'workspace',registry:'box',domains:'box',runtimes:'bolt'})[view],fn:()=>navigate(view)})),{key:'help',title:'使用说明',icon:'help',fn:()=>$('#help-dialog').showModal()}].map(item=>({...item,key:'command:'+item.key,group:'命令',sub:item.key==='new'?'使用已保存的智能体创建任务':'导航与帮助'}));
}
function renderCommands(){
 const session=state.commandSession;if(!session)return;
 if(!commandCurrent(session)){if($('#command-dialog').open)closeCommandSearch();return;}
 const query=$('#command-input').value.trim();
 // A composition or programmatic input change must never activate old results.
 if(query!==session.query){state.commandItems=[];$('#command-results').innerHTML='';$('#command-input').removeAttribute('aria-activedescendant');return;}
 const actions=commandActions().filter(i=>(i.title+' '+i.sub+' '+i.group).toLowerCase().includes(query.toLowerCase())),resources=commandResourceItems(query);
 const all=query?[...resources,...actions]:[...actions,...resources.filter(item=>item.group==='运行').slice(0,5)],size=query?12:20;
 if(session.resumeKey&&all.some(item=>item.key===session.resumeKey)){state.commandSelectedKey=session.resumeKey;session.resumeKey=null;}
 const selected=all.findIndex(item=>item.key===state.commandSelectedKey);
 if(selected>=0)state.commandPage=Math.floor(selected/size);
 state.commandPage=Math.min(state.commandPage||0,Math.max(0,Math.ceil(all.length/size)-1));
 state.commandItems=all.slice(state.commandPage*size,(state.commandPage+1)*size);
 state.commandIndex=Math.max(0,state.commandItems.findIndex(item=>item.key===state.commandSelectedKey));state.commandSelectedKey=state.commandItems[state.commandIndex]?.key||null;
 const pending=Object.keys(commandSources).filter(key=>session.sources[key].pending),failed=Object.keys(commandSources).filter(key=>session.sources[key].error),focus=document.activeElement?.id;
 $('#command-summary').textContent=pending.length?'正在读取：'+pending.map(key=>commandSources[key]).join('、')+'。已读结果可先打开。':failed.length?'部分资源读取失败，当前只显示已读结果。':'已读取当前空间的搜索结果。';
 $('#command-errors').innerHTML=Object.keys(commandSources).filter(key=>session.sources[key].error||session.sources[key].retrying).map(key=>{const source=session.sources[key];return `<div class="command-read-error"><p ${source.error?'role="alert"':''}><strong>${esc(commandSources[key])}</strong> · ${esc(source.error||'正在重新读取…')}</p><button type="button" class="button secondary" id="command-retry-${key}" data-command-retry="${key}" aria-disabled="${source.pending}" aria-busy="${source.pending}">${source.pending?'正在读取…':'重试'+esc(commandSources[key])}</button></div>`;}).join('');
 $('#command-results').setAttribute('aria-busy',String(pending.length>0));
 let previousGroup='';const markup=state.commandItems.map((item,n)=>{const heading=item.group!==previousGroup?`<div class="command-group-label" role="presentation">${esc(item.group)}</div>`:'';previousGroup=item.group;return heading+`<button class="command-option ${n===state.commandIndex?'selected':''}" role="option" tabindex="-1" aria-selected="${n===state.commandIndex}" id="cmd-${n}" data-command="${n}">${icon(item.icon)}<span>${esc(item.title)}<small>${esc(item.sub)}</small></span></button>`;}).join('');
 $('#command-results').innerHTML=state.commandItems.length?markup:`<div class="empty">${pending.length?'正在查找匹配结果…':failed.length?'搜索尚未完成，可重试上方失败的资源。':'没有匹配的命令或资源。试试名称、标识，或缩短关键词。'}</div>`;
 $('#command-input').setAttribute('aria-controls','command-results');if(state.commandItems.length)$('#command-input').setAttribute('aria-activedescendant','cmd-'+state.commandIndex);else $('#command-input').removeAttribute('aria-activedescendant');
 $('#command-page').textContent=all.length?'显示 '+(state.commandPage*size+1)+'–'+Math.min((state.commandPage+1)*size,all.length)+' / '+all.length+' 条已读匹配':'';
 $('#command-prev').disabled=state.commandPage===0;$('#command-next').disabled=(state.commandPage+1)*size>=all.length;
 $('#command-pagination').hidden=all.length<=size;
 if(focus?.startsWith('command-retry-'))(document.getElementById(focus)||$('#command-input')).focus({preventScroll:true});
 commandRemember(session);
}
function moveCommandSelection(delta){
 if(!state.commandItems?.length)return;
 if(state.commandSession)state.commandSession.resumeKey=null;
 state.commandIndex=(state.commandIndex+delta+state.commandItems.length)%state.commandItems.length;state.commandSelectedKey=state.commandItems[state.commandIndex].key;renderCommands();$('#cmd-'+state.commandIndex)?.scrollIntoView({block:'nearest'});
}
function changeCommandPage(delta){if(state.commandSession)state.commandSession.resumeKey=null;state.commandPage=Math.max(0,(state.commandPage||0)+delta);state.commandSelectedKey=null;state.commandIndex=0;renderCommands();$('#command-input').focus({preventScroll:true});$('#command-results').scrollTop=0;}
function runCommand(n){
 const session=state.commandSession;if(!session||!commandCurrent(session)||session.query!==$('#command-input').value.trim()||state.composing)return;
 const item=state.commandItems[n];if(item){closeCommandSearch(true);item.fn();}
}
$('#command-errors').addEventListener('click',event=>{const button=event.target.closest('[data-command-retry]');if(button)retryCommandSource(button.dataset.commandRetry);});
$('#command-prev').addEventListener('click',()=>changeCommandPage(-1));$('#command-next').addEventListener('click',()=>changeCommandPage(1));
$('#command-dialog').addEventListener('close',()=>{if(!$('#command-dialog').open)closeCommandSearch();});
window.addEventListener('hashchange',()=>{if(state.commandSession&&!commandCurrent(state.commandSession))closeCommandSearch(true);if(state.commandFlowTarget&&location.hash!=='#/workflows')state.commandFlowTarget=null;});
