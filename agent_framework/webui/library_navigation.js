'use strict';

const libraryNavigationDefaults={tab:'knowledge',query:'',input:'',status:'',memory:{cursor:null,stack:[]}};
function libraryNavigationScope(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal]);}
function libraryNavigationValue(){
 const memory=state.libraryMemory&&libraryScopeCurrent(state.libraryMemory.scope)&&state.libraryMemory.query===(state.libraryQuery||'')?state.libraryMemory:null;
 return {tab:state.libraryTab||'knowledge',query:state.libraryQuery||'',input:state.librarySearch??state.libraryQuery??'',status:state.libraryStatus||'',memory:{cursor:memory?.cursor??null,stack:[...(memory?.stack||[])]}};
}
function validLibraryNavigation(value){
 const cursor=value=>value===null||typeof value==='string'&&value.length>0&&value.length<=16384;
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===5
  &&typeof value.tab==='string'&&Object.hasOwn(libraryModules,value.tab)&&typeof value.query==='string'&&value.query.length<=2000
  &&typeof value.input==='string'&&value.input.length<=2000&&['',...Object.keys(assetStatuses)].includes(value.status)
  &&value.memory&&Object.keys(value.memory).length===2&&cursor(value.memory.cursor)
  &&Array.isArray(value.memory.stack)&&value.memory.stack.length<=1000&&value.memory.stack.every(cursor);
}
function applyLibraryNavigation(value){
 state.libraryTab=value.tab;state.libraryQuery=value.query;state.librarySearch=value.input;state.libraryStatus=value.status;
 state.libraryMemory={scope:libraryScope(),query:value.query,cursor:value.memory.cursor,stack:[...value.memory.stack]};
 state.libraryRequest=(state.libraryRequest||0)+1;state.libraryRead=null;
}
function libraryNavigationNotice(){const entry=state.libraryNavigation;return entry?.scope===libraryNavigationScope()?(entry.storageError||entry.notice||''):'';}
function libraryNavigationFeedback(){const message=libraryNavigationNotice();return `<p id="library-navigation-note" class="field-help" role="status" ${message?'':'hidden'}>${esc(message)}</p>`;}
function saveLibraryNavigation(changed=false){
 const entry=state.libraryNavigation;
 if(!entry||entry.scope!==libraryNavigationScope()||state.view!=='library'||state.routeHash!==location.hash)return;
 if(changed)entry.notice='';
 const value=libraryNavigationValue();
 if(!validLibraryNavigation(value))return;
 try{history.replaceState({...history.state,libraryNavigation:{version:1,scope:entry.scope,hash:location.hash,value}},'');entry.storageError='';}
 catch{entry.storageError='浏览器暂时无法保留知识库浏览条件，刷新后可能需要重新查询。';}
 const note=document.getElementById('library-navigation-note');
 if(note){note.textContent=libraryNavigationNotice();note.hidden=!note.textContent;}
}
// An explicit result-opening action takes precedence over the destination's
// old browsing state, even when it navigates to the same library URL.
function prepareLibraryNavigation(){
 state.libraryNavigationIntent={scope:libraryNavigationScope(),route:state.routeVersion+1};
 state.libraryMemory=null;
}
function restoreLibraryNavigation(){
 if(state.view!=='library'||!state.meta?.tenant||!state.meta?.principal)return;
 const scope=libraryNavigationScope();let entry=state.libraryNavigation;
 const intent=state.libraryNavigationIntent;
 const explicit=intent?.scope===scope&&intent.route===state.routeVersion;
 if(intent&&state.routeVersion>=intent.route)state.libraryNavigationIntent=null;
 if(!entry||entry.scope!==scope){
  if(entry&&!explicit)applyLibraryNavigation(libraryNavigationDefaults);
  entry=state.libraryNavigation={scope,route:null,notice:'',storageError:''};
 }
 if(entry.route===state.routeVersion)return;
 entry.route=state.routeVersion;entry.notice='';
 let saved;try{saved=history.state?.libraryNavigation;}catch{}
 if(!explicit&&saved?.scope===scope&&saved.hash===location.hash){
  if(saved.version===1&&validLibraryNavigation(saved.value))applyLibraryNavigation(saved.value);
  else{applyLibraryNavigation(libraryNavigationDefaults);entry.notice='上次知识库浏览条件无法恢复，已显示全部知识资料。';}
  // Each visit owns its position, even when another visit used the same URL.
  state.routePosition={top:entry.notice?0:historyRoutePosition(state.routeKey)??state.routePosition?.top??0};
 }
 saveLibraryNavigation();
}
document.addEventListener('input',event=>{if(event.target.id==='hub-query')saveLibraryNavigation(true);});
document.addEventListener('change',event=>{if(event.target.id==='hub-status')saveLibraryNavigation(true);});
document.addEventListener('click',event=>{if(event.target.closest('[data-hub-tab],[data-hub-clear]'))saveLibraryNavigation(true);});
window.addEventListener('pagehide',event=>{if(!event.persisted)saveLibraryNavigation();});
