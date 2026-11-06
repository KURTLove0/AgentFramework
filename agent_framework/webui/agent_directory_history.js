'use strict';

const agentDirectoryDefaults = {search:'',status:'all',domain:'all',runtime:'all',sort:'updated',filtersOpen:false};
function agentDirectoryScope(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal]);}
function agentDirectoryQuery(){
 return {search:state.agentSearch||'',status:state.agentStatus||'all',domain:state.agentDomain||'all',runtime:state.agentRuntime||'all',sort:state.agentSort||'updated',filtersOpen:!!state.agentFiltersOpen};
}
function applyAgentDirectoryQuery(query){
 Object.assign(state,{agentSearch:query.search,agentStatus:query.status,agentDomain:query.domain,agentRuntime:query.runtime,agentSort:query.sort,agentFiltersOpen:query.filtersOpen});
}
function validAgentDirectoryQuery(query){
 if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).length!==6)return false;
 if(!Object.keys(agentDirectoryDefaults).every(key=>Object.hasOwn(query,key)))return false;
 return typeof query.search==='string'&&query.search.length<=2000&&['all','available','archived'].includes(query.status)
  &&typeof query.domain==='string'&&query.domain.length>0&&query.domain.length<=200
  &&typeof query.runtime==='string'&&query.runtime.length>0&&query.runtime.length<=64
  &&['updated','name','created'].includes(query.sort)&&typeof query.filtersOpen==='boolean';
}
function validAgentDirectoryReturn(value){
 return value===null||!!(value&&typeof value==='object'&&typeof value.agentId==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value.agentId)
  &&['agent-open-'+value.agentId,'agent-inspect-'+value.agentId].includes(value.focus)&&validRouteTop(value.top));
}
function syncAgentDirectoryReturn(){
 const h=state.agentDirectoryHistory;
 state.agentListReturn=h?.returnTo?{workspace:state.workspaceId,query:h.returnQuery.search,focus:h.returnTo.focus}:null;
}
function agentDirectoryHistoryNotice(){
 const h=state.agentDirectoryHistory;
 return h?.scope===agentDirectoryScope()?(h.storageError||h.entryNotice||''):'';
}
function saveAgentDirectoryEntry(changed=false){
 const h=state.agentDirectoryHistory;
 if(!h||h.scope!==agentDirectoryScope()||state.view!=='agents'||state.routeHash!==location.hash)return;
 if(changed){h.returnTo=null;h.entryNotice='';syncAgentDirectoryReturn();}
 const query=agentDirectoryQuery();
 if(!validAgentDirectoryQuery(query))return;
 try{
  history.replaceState({...history.state,agentDirectory:{version:1,scope:h.scope,hash:location.hash,query,returnTo:h.returnTo}},'');
  h.storageError='';
 }catch{h.storageError='浏览器暂时无法保留目录条件，刷新后可能需要重新筛选。';}
 const notice=document.getElementById('agent-directory-history-note');
 if(notice){notice.textContent=agentDirectoryHistoryNotice();notice.hidden=!notice.textContent;}
}
function restoreAgentDirectoryEntry(){
 if(state.view!=='agents'||!state.meta?.tenant||!state.meta?.principal)return;
 const scope=agentDirectoryScope();let h=state.agentDirectoryHistory;
 if(!h||h.scope!==scope){
  if(h)applyAgentDirectoryQuery(agentDirectoryDefaults);
  h=state.agentDirectoryHistory={scope,route:null,selected:null,returnTo:null,returnQuery:null,entryNotice:'',storageError:''};
  state.agentListReturn=null;
 }
 if(h.route===state.routeVersion)return;
 const fromDetail=h.selected&&h.route===state.routeVersion-1,previous=h.selected;
 h.route=state.routeVersion;h.selected=state.selected;h.entryNotice='';
 let saved;try{saved=history.state?.agentDirectory;}catch{}
 const matching=saved&&saved.scope===scope&&saved.hash===location.hash;
 if(matching){
  if(saved.version===1&&validAgentDirectoryQuery(saved.query)&&validAgentDirectoryReturn(saved.returnTo)&&(!state.selected||!saved.returnTo||saved.returnTo.agentId===state.selected)){
   applyAgentDirectoryQuery(saved.query);h.returnTo=saved.returnTo;h.returnQuery=saved.query;
   if(!state.selected){
    state.routeFocus=h.returnTo?.focus||(state.routeFocus?'content':null);
    state.routePosition={top:historyRoutePosition(state.routeKey)??h.returnTo?.top??state.routePosition?.top??0};
   }
  }else{
   applyAgentDirectoryQuery(agentDirectoryDefaults);h.returnTo=null;h.returnQuery=null;state.routePosition={top:0};
   h.entryNotice='上次目录条件无法恢复，已显示全部智能体。';
  }
 }else if(!state.selected&&fromDetail&&h.returnTo?.agentId===previous){
  applyAgentDirectoryQuery(h.returnQuery);state.routeFocus=h.returnTo.focus;state.routePosition={top:h.returnTo.top};
 }else if(state.selected?h.returnTo?.agentId!==state.selected:!fromDetail){
  h.returnTo=null;h.returnQuery=null;
 }
 syncAgentDirectoryReturn();saveAgentDirectoryEntry();
}
function rememberAgentDirectoryLink(link,event){
 if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||state.view!=='agents'||state.selected)return;
 const h=state.agentDirectoryHistory;if(!h||h.scope!==agentDirectoryScope())return;
 const agentId=link.closest('.agent-directory-row')?.id.slice('agent-card-'.length);
 const target={agentId,focus:link.id,top:window.scrollY};if(!validAgentDirectoryReturn(target))return;
 h.returnTo=target;h.returnQuery=agentDirectoryQuery();syncAgentDirectoryReturn();
 saveRoutePosition();saveAgentDirectoryEntry();
}
window.addEventListener('pagehide',()=>saveAgentDirectoryEntry());
