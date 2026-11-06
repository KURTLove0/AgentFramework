'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(process.env.TASK_EXPORT_LEGACY||path.join(__dirname,'../agent_framework/webui/task_export.js'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const response=(options={})=>({ok:true,status:200,headers:{get:()=> 'application/zip'},blob:async()=>({size:10}),...options});
function fixture(){
 const calls=[],downloads=[],revoked=[],nodes=new Map(),timers=new Map(),events={},region={scrollTop:0};let fetcher=async()=>response(),timer=0;
 const document={body:{append:el=>nodes.set(el.id,el)},getElementById:id=>nodes.get(id),addEventListener(){}};document.activeElement=document.body;
 document.createElement=tag=>tag==='a'?{click(){downloads.push({href:this.href,filename:this.download});},remove(){}}:{open:false,innerHTML:'',handlers:{},setAttribute(){},addEventListener(k,fn){this.handlers[k]=fn;},showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();},contains:el=>el?.inDialog,querySelector:()=>region};
 const state={meta:{tenant:'tenant',principal:'person'},workspaceId:'space-a',selected:'task-root',routeVersion:1,detail:{conversation:{id:'task-root'}}};
 const context=vm.createContext({state,document,window:{addEventListener:(k,fn)=>events[k]=fn},AbortController,
  esc:s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),icon:()=>'',
  URL:{createObjectURL:()=> 'blob:task',revokeObjectURL:url=>revoked.push(url)},setTimeout:(fn,ms)=>{timers.set(++timer,{fn,ms});return timer;},clearTimeout:id=>timers.delete(id),
  fetch:async(url,options)=>{calls.push({url,options});return fetcher(url,options);}});
 vm.runInContext(source,context);return {state,document,nodes,calls,downloads,revoked,timers,events,region,context,fetch:fn=>fetcher=fn,record:()=>vm.runInContext('taskExportRequest',context),dialog:()=>nodes.get('task-export-dialog'),open:context.openTaskExport,close:context.closeTaskExport,download:context.downloadTaskExport};
}
test('opening explains saved scope without immediately starting a download',()=>{const f=fixture();f.open();assert.equal(f.calls.length,0);assert.match(f.dialog().innerHTML,/同一快照/);assert.match(f.dialog().innerHTML,/未发送、未保存/);assert(f.dialog().open);});
test('explicit download freezes workspace and performs a read-only request',async()=>{const f=fixture();f.open();await f.download();assert.equal(f.calls[0].url,'/api/tasks/task-root/export?kind=bundle');assert.equal(f.calls[0].options.headers['X-Agent-Workspace'],'space-a');assert.equal(f.calls[0].options.method,undefined);assert.equal(f.calls[0].options.body,undefined);assert.equal(f.calls[0].options.cache,'no-store');assert.deepEqual(f.downloads,[{href:'blob:task',filename:'task-root-task-export.zip'}]);assert.match(f.dialog().innerHTML,/已交给浏览器下载/);assert.equal(f.timers.size,1);[...f.timers.values()][0].fn();assert.deepEqual(f.revoked,['blob:task']);});
test('duplicate clicks cannot create overlapping requests',async()=>{const f=fixture(),gate=deferred();f.fetch(()=>gate.promise);f.open();const first=f.download();await f.download();f.open();assert.equal(f.calls.length,1);assert.match(f.dialog().innerHTML,/正在准备/);gate.resolve(response());await first;assert.equal(f.downloads.length,1);});
test('request failure is escaped and explicit retry uses the same task',async()=>{const f=fixture();f.fetch(async()=>response({ok:false,status:503,json:async()=>({error:'<img src=x> unavailable'})}));f.open();await f.download();assert.equal(f.downloads.length,0);assert.match(f.dialog().innerHTML,/&lt;img/);assert.match(f.dialog().innerHTML,/重试下载/);f.fetch(async()=>response());await f.download();assert.equal(f.calls.length,2);assert.equal(f.downloads.length,1);assert.equal(f.record().error,null);});
test('non-json errors and invalid or empty payloads never become downloads',async()=>{for(const value of [response({ok:false,status:502,json:async()=>{throw Error('html');}}),response({headers:{get:()=> 'text/html'}}),response({blob:async()=>({size:0})})]){const f=fixture();f.fetch(async()=>value);f.open();await f.download();assert.equal(f.downloads.length,0);assert(f.record().error);assert.equal(f.timers.size,0);}});
test('closing aborts the request and fences a response that ignores abort',async()=>{const f=fixture(),gate=deferred();f.fetch(()=>gate.promise);f.open();const first=f.download();f.close();assert(f.calls[0].options.signal.aborted);gate.resolve(response());await first;assert.equal(f.downloads.length,0);assert.equal(f.record(),null);assert.equal(f.dialog().innerHTML,'');assert.equal(f.timers.size,0);});
test('an old blob cannot download into a reopened dialog',async()=>{const f=fixture(),gate=deferred();f.fetch(async()=>response({blob:()=>gate.promise}));f.open();const old=f.download();await Promise.resolve();await Promise.resolve();f.close();f.open();const current=f.record();gate.resolve({size:10});await old;assert.equal(f.record(),current);assert.equal(f.downloads.length,0);assert(!f.record().complete);});
test('workspace principal route and conversation changes fence success and failure',async()=>{for(const change of [s=>s.workspaceId='space-b',s=>s.meta.principal='other',s=>s.meta.tenant='other',s=>s.routeVersion++,s=>s.selected='other',s=>s.detail.conversation.id='other'])for(const failing of [false,true]){const f=fixture(),gate=deferred();f.fetch(()=>gate.promise);f.open();const p=f.download();change(f.state);if(failing)gate.reject(Error('late'));else gate.resolve(response());await p;assert.equal(f.downloads.length,0);assert.equal(f.record().error,null);assert.equal(f.timers.size,0);}});
test('timeout allows an explicit fresh retry without automatic replay',async()=>{const f=fixture();f.fetch((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(Error('abort'),{name:'AbortError'})))));f.open();const p=f.download();[...f.timers.values()].find(t=>t.ms===60000).fn();await p;assert.match(f.record().error,/超时/);assert.equal(f.calls.length,1);assert.equal(f.downloads.length,0);f.fetch(async()=>response());await f.download();assert.equal(f.downloads.length,1);});
test('navigation and page exit clear the owned dialog',()=>{for(const event of ['hashchange','pagehide']){const f=fixture();f.open();f.events[event]();assert.equal(f.record(),null);assert(!f.dialog().open);assert.equal(f.dialog().innerHTML,'');}});
test('a queued close event cannot clear a newly opened dialog',()=>{const f=fixture();f.open();const d=f.dialog();f.close();f.open();d.handlers.close();assert(f.record());assert(d.open);});

const conversation=()=>({id:'task-root',revision:3,turns:[{number:1,run_id:'task-root',content:'原文 😀',status:'SUCCEEDED'}],export_snapshot:{revision:3,captured_at:1000}});
const documentResponse=(kind,body)=>response({headers:{get:()=>kind==='json'?'application/json; charset=utf-8':'text/markdown; charset=utf-8'},blob:async()=>({size:body.length,text:async()=>body})});
test('Markdown entry offers formats and clear document boundaries before any download',()=>{const f=fixture();f.open('markdown');assert.equal(f.record().kind,'markdown');assert.match(f.dialog().innerHTML,/文件格式/);assert.match(f.dialog().innerHTML,/JSON/);assert.match(f.dialog().innerHTML,/完整修改历史/);assert.match(f.dialog().innerHTML,/下载 Markdown/);assert.equal(f.calls.length,0);});
test('Markdown and JSON use their own read-only endpoint and filename',async()=>{for(const kind of ['markdown','json']){const f=fixture(),body=kind==='json'?JSON.stringify(conversation()):'# 完整对话\n\n原文 😀\n';f.fetch(async()=>documentResponse(kind,body));f.open(kind);await f.download();assert.equal(f.calls[0].url,'/api/tasks/task-root/export?kind='+kind);assert.equal(f.calls[0].options.headers['X-Agent-Workspace'],'space-a');assert.equal(f.downloads[0]?.filename,'task-root-conversation.'+(kind==='json'?'json':'md'));assert(f.record().complete);}});
test('changing format clears the former outcome and does not start a request',async()=>{const f=fixture();f.open();await f.download();f.context.changeTaskExportFormat('json');assert.equal(f.record().kind,'json');assert.equal(f.record().complete,false);assert.equal(f.record().error,null);assert.equal(f.calls.length,1);assert.match(f.dialog().innerHTML,/结构化/);});
test('a pending download freezes its format even if another entry is requested',async()=>{const f=fixture(),gate=deferred();f.fetch(()=>gate.promise);f.open('markdown');const p=f.download();f.context.changeTaskExportFormat('json');f.open('json');assert.equal(f.record().kind,'markdown');assert.match(f.dialog().innerHTML,/id="task-export-format"[^>]*disabled/);await f.download();assert.equal(f.calls.length,1);gate.resolve(documentResponse('markdown','# 文档'));await p;assert.equal(f.downloads[0]?.filename,'task-root-conversation.md');});
test('unknown and inherited format names are refused before a request',()=>{for(const kind of ['html','constructor','toString','__proto__']){const f=fixture();f.open(kind);assert.equal(f.record(),null);assert.equal(f.calls.length,0);}});
test('every format rejects a mismatched or misleading MIME type',async()=>{for(const [kind,mime] of [['markdown','text/html'],['json','text/markdown'],['bundle','application/zip-invalid'],['markdown','text/markdown-invalid']]){const f=fixture();f.open(kind);f.fetch(async()=>response({headers:{get:()=>mime}}));await f.download();assert.equal(f.downloads.length,0);assert.match(f.record().error,/格式/);}});
test('invalid JSON and a mismatched task or snapshot cannot become document downloads',async()=>{for(const body of ['{bad',JSON.stringify({error:'upstream failure'}),JSON.stringify({...conversation(),id:'another-task'}),JSON.stringify({...conversation(),turns:[]}),JSON.stringify({...conversation(),export_snapshot:{revision:2,captured_at:1000}})]){const f=fixture();f.open('json');f.fetch(async()=>documentResponse('json',body));await f.download();assert.equal(f.downloads.length,0);assert(f.record().error);}});
test('failed document export retries the same selected format',async()=>{const f=fixture();f.open('markdown');f.fetch(async()=>response({ok:false,status:503,json:async()=>({error:'请稍后重试'})}));await f.download();assert.match(f.dialog().innerHTML,/重试下载/);f.fetch(async()=>documentResponse('markdown','# 回复\n'));await f.download();assert.equal(f.calls.length,2);assert(f.calls.every(c=>c.url.endsWith('kind=markdown')));assert.equal(f.downloads.length,1);});
test('timeout prevents a late download even when the transport ignores abort',async()=>{const f=fixture(),gate=deferred();f.open('markdown');f.fetch(()=>gate.promise);const p=f.download();[...f.timers.values()].find(t=>t.ms===60000).fn();gate.resolve(documentResponse('markdown','# too late'));await p;assert.equal(f.downloads.length,0);assert.match(f.record().error,/超时/);});
test('late JSON parsing cannot complete into a reopened format dialog',async()=>{const f=fixture(),gate=deferred(),entered=deferred();f.open('json');f.fetch(async()=>response({headers:{get:()=> 'application/json'},blob:async()=>({size:50,text:()=>{entered.resolve();return gate.promise;}})}));const p=f.download();await Promise.race([entered.promise,p]);assert.equal(f.record().loading,true);f.close();f.open('markdown');gate.resolve(JSON.stringify(conversation()));await p;assert.equal(f.record().kind,'markdown');assert.equal(f.downloads.length,0);assert(!f.record().complete);});

function keyboardFixture(kind='bundle'){
 const f=fixture(),doc=f.document,create=doc.createElement;let controls=[];
 doc.createElement=tag=>{
  const element=create(tag);if(tag==='a')return element;let html='';
  Object.defineProperty(element,'innerHTML',{get:()=>html,set:value=>{
   html=value;if(element.contains(doc.activeElement))doc.activeElement=doc.body;
   for(const control of controls){control.isConnected=false;if(control.id)f.nodes.delete(control.id);}controls=[];
   for(const match of value.matchAll(/<(button|select)\b([^>]*)>/g)){
    const attrs=match[2],id=attrs.match(/\bid="([^"]+)"/)?.[1]||'',label=attrs.match(/\baria-label="([^"]+)"/)?.[1]||'';
    const control={id,label,inDialog:true,isConnected:true,disabled:/(?:^|\s)disabled(?:\s|$)/.test(attrs),ariaDisabled:/aria-disabled="true"/.test(attrs),focus(){if(this.isConnected&&!this.disabled)doc.activeElement=this;}};
    controls.push(control);if(id)f.nodes.set(id,control);
   }
  }});return element;
 };
 f.open(kind);
 return {...f,field:id=>f.nodes.get(id),header:()=>controls.find(el=>el.label==='关闭任务导出'),focus:id=>f.nodes.get(id).focus(),active:()=>doc.activeElement};
}
test('keyboard download remains focused while pending and cannot submit twice',async()=>{
 const f=keyboardFixture(),gate=deferred();f.fetch(()=>gate.promise);f.focus('task-export-download');const pending=f.download();
 assert.equal(f.active().id,'task-export-download');assert.equal(f.active().disabled,false);assert.equal(f.active().ariaDisabled,true);
 await f.download();assert.equal(f.calls.length,1);gate.resolve(response());await pending;
 assert.equal(f.active().id,'task-export-download');assert.equal(f.active().ariaDisabled,false);
});
test('download completion preserves the footer close control chosen while waiting',async()=>{
 for(const failure of [false,true]){
  const f=keyboardFixture(),gate=deferred();f.fetch(()=>gate.promise);f.focus('task-export-download');const pending=f.download();
  f.focus('task-export-close');if(failure)gate.reject(Error('offline'));else gate.resolve(response());await pending;
  assert.equal(f.active().id,'task-export-close');assert.equal(f.downloads.length,failure?0:1);
 }
});
test('download completion preserves the header close control chosen while waiting',async()=>{
 for(const failure of [false,true]){
  const f=keyboardFixture(),gate=deferred();f.fetch(()=>gate.promise);f.focus('task-export-download');const pending=f.download();
  f.header().focus();if(failure)gate.reject(Error('offline'));else gate.resolve(response());await pending;
  assert.equal(f.active(),f.header());assert.equal(f.downloads.length,failure?0:1);
 }
});
test('programmatic download preserves the currently focused close control',async()=>{
 for(const location of ['header','footer']){
  const f=keyboardFixture();if(location==='header')f.header().focus();else f.focus('task-export-close');await f.download();
  assert.equal(f.active(),location==='header'?f.header():f.field('task-export-close'));
 }
});
test('pending completion does not invent a focus target after focus moved elsewhere',async()=>{
 const f=keyboardFixture(),gate=deferred();f.fetch(()=>gate.promise);f.focus('task-export-download');const pending=f.download();
 f.document.activeElement=f.document.body;gate.resolve(response());await pending;assert.equal(f.active(),f.document.body);
});
test('a stale completion cannot focus controls in a reopened export dialog',async()=>{
 const f=keyboardFixture(),gate=deferred();f.fetch(()=>gate.promise);f.focus('task-export-download');const pending=f.download();
 f.close();f.open('json');f.focus('task-export-format');const selected=f.active();gate.resolve(response());await pending;
 assert.equal(f.active(),selected);assert.equal(f.downloads.length,0);assert.equal(f.record().kind,'json');
});
test('cancel preparation keeps the selected format open and clears its timer immediately',async()=>{
 const f=fixture(),gate=deferred();f.open('markdown');f.fetch(()=>gate.promise);const pending=f.download(),record=f.record();
 f.context.cancelTaskExport();assert.equal(f.record(),record);assert(f.dialog().open);assert.equal(record.kind,'markdown');assert(!record.loading&&!record.complete&&record.cancelled);assert.equal(record.error,null);assert.equal(record.controller,null);assert(f.calls[0].options.signal.aborted);assert.equal(f.timers.size,0);assert.match(f.dialog().innerHTML,/本次准备已取消/);
 gate.resolve(documentResponse('markdown','# cancelled'));await pending;assert.equal(f.downloads.length,0);assert(record.cancelled);f.context.changeTaskExportFormat('json');assert(!record.cancelled);assert.equal(f.calls.length,1);
});
test('a cancelled response cannot finish or unlock a new request in the same dialog',async()=>{
 const f=fixture(),old=deferred(),next=deferred();f.open('markdown');f.fetch(()=>old.promise);const first=f.download();f.context.cancelTaskExport();f.context.changeTaskExportFormat('json');f.fetch(()=>next.promise);const second=f.download(),controller=f.record().controller;
 old.resolve(documentResponse('markdown','# late old document'));await first;assert.equal(f.record().controller,controller);assert(f.record().loading);assert.equal(f.timers.size,1);assert.equal(f.downloads.length,0);await f.download();assert.equal(f.calls.length,2);
 next.resolve(documentResponse('json',JSON.stringify(conversation())));await second;assert.equal(f.downloads.length,1);assert.equal(f.downloads[0].filename,'task-root-conversation.json');assert(f.record().complete);assert.equal(f.record().error,null);
});
test('a cancelled failure cannot overwrite a later successful download',async()=>{
 const f=fixture(),old=deferred();f.open();f.fetch(()=>old.promise);const first=f.download();f.context.cancelTaskExport();f.fetch(async()=>response());await f.download();old.reject(Error('late offline failure'));await first;
 assert.equal(f.downloads.length,1);assert(f.record().complete);assert.equal(f.record().error,null);assert(!f.record().cancelled);assert.match(f.dialog().innerHTML,/已交给浏览器下载/);assert.doesNotMatch(f.dialog().innerHTML,/late offline failure/);
});
test('cancellation fences an in-flight blob or JSON parse before creating a file',async()=>{
 for(const stage of ['blob','json']){
  const f=fixture(),gate=deferred(),entered=deferred();f.open(stage==='json'?'json':'bundle');f.fetch(async()=>response({headers:{get:()=>stage==='json'?'application/json':'application/zip'},blob:()=>{if(stage==='blob'){entered.resolve();return gate.promise;}return {size:50,text:()=>{entered.resolve();return gate.promise;}};}}));
  const pending=f.download();await entered.promise;f.context.cancelTaskExport();gate.resolve(stage==='json'?JSON.stringify(conversation()):{size:10});await pending;assert.equal(f.downloads.length,0);assert(f.record().cancelled);assert.equal(f.record().error,null);assert.equal(f.timers.size,0);
 }
});
test('cancel returns its own focus to format without replacing a newer focus choice',async()=>{
 for(const target of ['task-export-cancel','task-export-close','task-export-dismiss',null]){
  const f=keyboardFixture(),gate=deferred();f.fetch(()=>gate.promise);const pending=f.download();if(target)f.focus(target);else f.document.activeElement=f.document.body;f.context.cancelTaskExport();
  assert.equal(f.active(),target?f.field(target==='task-export-cancel'?'task-export-format':target):f.document.body);gate.reject(Object.assign(Error('abort'),{name:'AbortError'}));await pending;assert.equal(f.record().error,null);
 }
});
test('completion while focused on cancel returns to the available download action',async()=>{
 for(const failure of [false,true]){
  const f=keyboardFixture(),gate=deferred();f.fetch(()=>gate.promise);const pending=f.download();f.focus('task-export-cancel');if(failure)gate.reject(Error('offline'));else gate.resolve(response());await pending;
  assert.equal(f.active(),f.field('task-export-download'));assert.equal(f.active().ariaDisabled,false);
 }
});
