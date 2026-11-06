'use strict';

let runListNavigationObserver=null,runListNavigationNode=null;
function syncRunListNavigation(){
 const navigation=$('#run-list-navigation');
 if(navigation===runListNavigationNode)return;
 runListNavigationObserver?.disconnect();runListNavigationObserver=null;runListNavigationNode=navigation;
 if(!navigation||typeof ResizeObserver==='undefined')return;
 const measure=()=>{
  if(!navigation.isConnected)return;
  const height=getComputedStyle(navigation).position==='sticky'?navigation.getBoundingClientRect().height:0;
  navigation.closest('.run-list-panel').style.setProperty('--run-list-navigation-height',height+'px');
 };
 measure();runListNavigationObserver=new ResizeObserver(measure);runListNavigationObserver.observe(navigation);
}

function runHistoryScope(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal]);}
function runHistoryQuery(){return Object.fromEntries(['search','filter','runAgent','runDomain','runSort','runVisibility','runFavorites','runAfter','runBefore','runCursor','runCursorStack'].map(key=>[key,structuredClone(key==='runFavorites'?(state[key]||'all'):key==='runVisibility'?(state[key]||'active'):state[key])]));}
function validRunHistoryQuery(query){
 if(!query||typeof query!=='object'||Array.isArray(query))return false;
 const fields=['search','filter','runAgent','runDomain','runSort','runVisibility','runFavorites','runAfter','runBefore','runCursor','runCursorStack'];
 if(Object.keys(query).length!==fields.length||!fields.every(key=>Object.hasOwn(query,key)))return false;
 for(const [key,limit] of [['search',16000],['filter',64],['runAgent',200],['runDomain',200],['runSort',20],['runAfter',10],['runBefore',10]])if(typeof query[key]!=='string'||query[key].length>limit)return false;
 if(!['active','archived','all'].includes(query.runVisibility)||!['all','only'].includes(query.runFavorites))return false;
 if(!['created_desc','created_asc','updated_desc','updated_asc'].includes(query.runSort))return false;
 if(!['all','group:running','group:waiting','QUEUED','CANCELLING','CREATED','RUNNING','RECONCILING','VERIFYING','PAUSED','INTERRUPTED','SUCCEEDED','WAITING_AUTH','WAITING_INPUT','NEEDS_REVIEW','FAILED','EXPIRED','CANCELLED'].includes(query.filter))return false;
 const date=value=>!value||/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
 if(!date(query.runAfter)||!date(query.runBefore)||query.runAfter&&query.runBefore&&query.runAfter>query.runBefore)return false;
 const cursor=value=>typeof value==='string'&&value.length>0&&value.length<=2048;
 if(query.runCursor!==null&&!cursor(query.runCursor)||!Array.isArray(query.runCursorStack)||query.runCursorStack.length>1000)return false;
 if((query.runCursor===null)!==(query.runCursorStack.length===0)||!query.runCursorStack.every((value,index)=>index===0?value===null:cursor(value)))return false;
 return JSON.stringify(query).length<=1048576;
}
function restoreRunHistoryEntry(h){
 if(state.view!=='runs'||state.selected||!state.meta?.tenant||!state.meta?.principal||h.entryRoute===state.routeVersion)return;
 h.entryRoute=state.routeVersion;h.entryNotice='';
 try{
  if(typeof history==='undefined'||typeof location==='undefined'||state.routeHash!==location.hash)return;
  const saved=history.state?.agentRunHistory;
  if(!saved||saved.scope!==h.scope||saved.hash!==location.hash)return;
  const query={...saved.query,...(saved.version===1?{runVisibility:'active'}:{}),...([1,2].includes(saved.version)?{runFavorites:'all'}:{})};
  if(![1,2,3].includes(saved.version)||typeof saved.filtersOpen!=='boolean'||!validRunHistoryQuery(query)){h.entryNotice='上次列表条件无法恢复，当前列表将重新读取。';return;}
  Object.assign(state,structuredClone(query),{runFiltersOpen:saved.filtersOpen,runDateDraft:null});
  // Each browser entry may describe a different page of the same list route.
  if(typeof historyRoutePosition==='function'){
   const top=historyRoutePosition(state.routeKey);if(top!==undefined)state.routePosition={top};
  }
 }catch{h.entryNotice='浏览器未能恢复上次列表条件，当前列表将重新读取。';}
}
function saveRunHistoryEntry(){
 if(state.view!=='runs'||state.selected||!state.meta?.tenant||!state.meta?.principal||typeof history==='undefined'||typeof location==='undefined'||state.routeHash!==location.hash)return;
 const h=runHistoryState();
 try{
  const query=runHistoryQuery();if(!validRunHistoryQuery(query))throw Error('unsupported list state');
  history.replaceState({...history.state,agentRunHistory:{version:3,scope:h.scope,hash:location.hash,query,filtersOpen:!!state.runFiltersOpen}},'');h.storageError='';
 }catch{h.storageError='浏览器未能保留列表条件，刷新后可能无法恢复当前条件。';}
}
function runHistoryState(){
 const scope=runHistoryScope(),prior=state.runHistory;
 if(!prior||prior.scope!==scope){
  if(prior){clearTimeout(prior.timer);Object.assign(state,{search:'',filter:'all',runAgent:'',runDomain:'',runSort:'created_desc',runVisibility:'active',runFavorites:'all',runAfter:'',runBefore:'',runCursor:null,runCursorStack:[],runDateDraft:null});}
  state.runHistory={scope,request:0,pending:false,error:'',path:null,dataPath:null,data:null,lastSuccess:null,timer:null,promise:null,restored:false,entryRoute:null,entryNotice:'',storageError:''};
 }
 restoreRunHistoryEntry(state.runHistory);
 return state.runHistory;
}
function syncRunHistory(h){
 const data=h.dataPath===runsRequest()?h.data:null;
 state.runs=data?.runs||[];state.runPage=data?{filtered_total:data.filtered_total,next_cursor:data.next_cursor,sort:data.sort}:null;
 if(data){state.counts=data.counts;state.limit=data.limit;state.runDomains=data.processing_domains||[];}
}
function renderRunHistory(){if(state.view==='runs'&&!state.selected){state.fingerprint='';render();}}
function loadRunHistory({background=false}={}){
 if(state.view!=='runs')return Promise.resolve(false);
 const h=runHistoryState(),path=runsRequest(),route=state.routeVersion,workspace=state.workspaceId,scope=h.scope;
 if(background&&h.pending&&h.path===path&&h.route===route&&h.promise)return h.promise;
 if(background&&(h.timer||(h.error&&h.path===path))){syncRunHistory(h);return Promise.resolve(false);}
 const request=++h.request,query=runHistoryQuery();
 const current=()=>state.view==='runs'&&route===state.routeVersion&&scope===runHistoryScope()&&state.runHistory===h&&request===h.request&&path===runsRequest();
 h.path=path;h.route=route;h.pending=true;h.error='';h.restored=false;
 saveRunHistoryEntry();
 if(h.dataPath!==path)h.data=null;syncRunHistory(h);if(!background)renderRunHistory();
 h.promise=(async()=>{
  try{
   const data=await api(path,undefined,15000,true,{workspace,payload:undefined});if(!current())return false;
   h.data=data;h.dataPath=path;h.pending=false;h.lastSuccess={data,path,query};syncRunHistory(h);if(!background)renderRunHistory();return true;
  }catch(error){if(!current())return false;h.pending=false;h.error=error.message||'读取未完成';syncRunHistory(h);if(!background)renderRunHistory();return false;}
  finally{if(request===h.request)h.pending=false;}
 })();return h.promise;
}
function changeRunHistory(debounce=false){
 const h=runHistoryState();clearTimeout(h.timer);h.timer=null;h.request++;h.promise=null;h.error='';h.pending=true;h.restored=false;h.entryNotice='';h.path=runsRequest();
 if(h.dataPath!==h.path)h.data=null;syncRunHistory(h);
 saveRunHistoryEntry();
 if(debounce){
  renderRunHistory();const route=state.routeVersion,scope=h.scope;
  h.timer=setTimeout(()=>{h.timer=null;if(state.view==='runs'&&route===state.routeVersion&&scope===runHistoryScope()&&state.runHistory===h)return loadRunHistory();},280);
  return;
 }
 return loadRunHistory();
}
function restoreRunHistory(){
 const h=runHistoryState();if(h.pending||!h.lastSuccess)return;
 h.request++;clearTimeout(h.timer);h.timer=null;h.promise=null;
 const saved=h.lastSuccess;Object.assign(state,structuredClone(saved.query),{runDateDraft:null});h.data=saved.data;h.path=saved.path;h.dataPath=saved.path;h.error='';h.pending=false;h.restored=true;
 saveRunHistoryEntry();
 syncRunHistory(h);renderRunHistory();$('#runs-heading')?.focus({preventScroll:true});
}
function retryRunHistory(first=false){
 const h=runHistoryState();if(h.pending)return;
 if(first)resetRunCursor();const promise=loadRunHistory();$('#runs-heading')?.focus({preventScroll:true});return promise;
}
function runHistoryNotice(){
 const h=runHistoryState(),hasData=Boolean(h.data&&h.dataPath===runsRequest());
 const text=h.pending?(hasData?'正在更新，以下仍为本页上次读取的结果。':'正在读取符合当前条件的运行…'):h.error?(hasData?'读取失败，以下仍为本页上次读取的结果。':'当前条件的结果尚未读取成功。'):h.restored?'已返回上次成功读取的条件与结果，可刷新列表核对最新状态。':'';
 return `<div class="run-history-status" role="status">${[text,h.entryNotice,h.storageError].filter(Boolean).map(esc).join(' ')}</div>${h.error?`<div class="run-history-error"><p class="inline-error" role="alert">${esc(h.error)}</p><div class="toolbar"><button id="run-history-retry" type="button" class="button secondary" data-run-history="retry">重试读取</button>${h.lastSuccess?.path!==h.path&&h.lastSuccess?'<button id="run-history-restore" type="button" class="button secondary" data-run-history="restore">返回上次结果</button>':''}${state.runCursor?'<button id="run-history-first" type="button" class="text-button" data-run-history="first">返回第一页</button>':''}</div></div>`:''}`;
}
document.addEventListener('click',event=>{const action=event.target.closest('[data-run-history]')?.dataset.runHistory;if(action==='restore')restoreRunHistory();if(action==='retry')retryRunHistory();if(action==='first')retryRunHistory(true);});
