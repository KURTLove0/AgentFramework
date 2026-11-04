'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'../agent_framework/webui'),app=fs.readFileSync(path.join(root,'app.js'),'utf8');
const between=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const result=(id='one',extra={})=>({runs:[{run_id:id,goal:id}],counts:{total:101},limit:50,filtered_total:101,next_cursor:'next-page',sort:'created_desc',processing_domains:[],...extra});
function fixture(){
 const calls=[],nodes=new Map(),timers=new Map(),renders=[],listeners=[];let timer=0,handler=async()=>result();
 const state={workspaceId:'space-a',meta:{tenant:'tenant-a',principal:'owner-a'},view:'runs',selected:null,routeVersion:1,search:'',filter:'all',runAgent:'',runDomain:'',runSort:'created_desc',runAfter:'',runBefore:'',runCursor:null,runCursorStack:[],runs:[],runPage:{next_cursor:'next-page'},counts:{},busy:false};
 const document={activeElement:null,addEventListener:(type,fn)=>listeners.push({type,fn})};
 function node(id){if(!nodes.has(id))nodes.set(id,{id,focus(){document.activeElement=this;},setAttribute(){},removeAttribute(){}});return nodes.get(id);}
 const context=vm.createContext({state,document,structuredClone,console,Date,URLSearchParams,encodeURIComponent,clearTimeout:id=>timers.delete(id),setTimeout:fn=>{timers.set(++timer,fn);return timer;},$:q=>node(q.slice(1)),$$:()=>[],esc:v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),icon:()=>'',render:()=>renders.push({search:state.search,ids:state.runs.map(r=>r.run_id)}),api:async(...args)=>{calls.push(args);return handler(...args);}});
 vm.runInContext(between('function runsRequest(){','async function refresh(){'),context);
 context.refresh=async()=>{if(state.busy){state.refreshAgain=true;return;}return context.api(context.runsRequest());};
 const module=path.join(root,'run_history.js');if(fs.existsSync(module))vm.runInContext(fs.readFileSync(module,'utf8'),context);
 vm.runInContext(between('function resetRunCursor(){','async function act('),context);
 return {state,context,calls,renders,document,node,run:s=>vm.runInContext(s,context),handle:fn=>handler=fn,async flush(){for(const [id,fn] of [...timers]){timers.delete(id);await fn();}}};
}
test('active search can read while the background page refresh is busy',async()=>{
 const f=fixture();f.state.busy=true;f.state.search='new';await f.context.refreshRunList();assert.equal(f.calls.length,1);assert.match(f.calls[0][0],/search=new/);assert.equal(f.state.runs[0].run_id,'one');
});
test('repeated next clicks cannot advance the page twice while its read is pending',async()=>{
 const f=fixture(),pending=deferred();f.handle(()=>pending.promise);f.context.changeRunPage('next');f.context.changeRunPage('next');assert.equal(f.state.runCursorStack.length,1);assert.equal(f.calls.length,1);pending.resolve(result('second'));
});
test('a failed filter read clears mismatched rows and exposes a retry',async()=>{
 const f=fixture();f.state.runs=[{run_id:'old',goal:'old'}];f.handle(async()=>{throw Error('断线');});f.state.search='different';await f.context.refreshRunList();assert.equal(f.state.runs.length,0);assert.match(f.run('runHistoryNotice()'),/重试读取/);
});
test('a late result cannot replace the current search',async()=>{
 const f=fixture(),pending=deferred();f.handle(url=>url.includes('old')?pending.promise:Promise.resolve(result('new')));f.state.search='old';const first=f.context.refreshRunList();f.state.search='new';await f.context.refreshRunList();pending.resolve(result('old'));await first;assert.equal(f.state.runs[0].run_id,'new');assert(f.renders.every(r=>r.search!=='new'||!r.ids.includes('old')));
});
test('an old failure cannot mark a newer search as failed',async()=>{
 const f=fixture(),pending=deferred();f.handle(url=>url.includes('old')?pending.promise:Promise.resolve(result('new')));f.state.search='old';const first=f.context.refreshRunList();f.state.search='new';await f.context.refreshRunList();pending.reject(Error('old failure'));await first;assert.equal(f.state.runHistory.error,'');assert.equal(f.state.runs[0].run_id,'new');
});
test('same-page read failures retain and label the last successful result',async()=>{
 const f=fixture();await f.run('loadRunHistory()');f.handle(async()=>{throw Error('离线');});await f.run('retryRunHistory()');assert.equal(f.state.runs[0].run_id,'one');assert.match(f.run('runHistoryNotice()'),/上次读取/);assert.equal(f.state.runCursor,null);
});
test('failed next-page reads keep that page address for an exact retry',async()=>{
 const f=fixture();await f.run('loadRunHistory()');f.handle(async()=>{throw Error('离线');});await f.context.changeRunPage('next');assert.equal(f.state.runCursor,'next-page');assert.equal(f.state.runs.length,0);assert.equal(f.state.runPage,null);assert.match(f.run('runHistoryNotice()'),/返回上次结果/);f.handle(async()=>result('second'));await f.run('retryRunHistory()');assert.match(f.calls.at(-1)[0],/cursor=next-page/);assert.equal(f.state.runs[0].run_id,'second');
});
test('returning to the last result restores filters, dates, sort and pagination without a request',async()=>{
 const f=fixture();Object.assign(f.state,{search:'saved',runAgent:'agent-a',runDomain:'domain-a',runAfter:'2026-10-01',runBefore:'2026-10-10',runSort:'updated_asc',runCursor:'saved-page',runCursorStack:[null]});await f.run('loadRunHistory()');f.state.search='failed';f.handle(async()=>{throw Error('离线');});await f.context.refreshRunList();const count=f.calls.length;f.run('restoreRunHistory()');assert.equal(f.calls.length,count);assert.equal(f.state.search,'saved');assert.equal(f.state.runCursor,'saved-page');assert.equal(f.state.runCursorStack.length,1);assert.equal(f.state.runAgent,'agent-a');assert.equal(f.state.runBefore,'2026-10-10');assert.equal(f.state.runSort,'updated_asc');assert.equal(f.state.runs[0].run_id,'one');assert.match(f.run('runHistoryNotice()'),/上次成功/);assert.equal(f.document.activeElement.id,'runs-heading');
});
test('debounced search hides incompatible rows before its request begins',async()=>{
 const f=fixture();await f.run('loadRunHistory()');const count=f.calls.length;f.state.search='next';f.context.refreshRunList(true);assert.equal(f.state.runs.length,0);assert(f.state.runHistory.pending);assert.equal(f.calls.length,count);assert.match(f.run('runHistoryNotice()'),/正在读取/);await f.flush();assert.equal(f.calls.length,count+1);assert.match(f.calls.at(-1)[0],/search=next/);
});
test('a later search cancels a pending debounce and makes one request',async()=>{
 const f=fixture();f.state.search='first';f.context.refreshRunList(true);f.state.search='second';f.context.refreshRunList(true);await f.flush();assert.equal(f.calls.length,1);assert.match(f.calls[0][0],/search=second/);
});
test('background polling coalesces a matching in-flight read',async()=>{
 const f=fixture(),pending=deferred();f.handle(()=>pending.promise);const first=f.run('loadRunHistory()');const second=f.run('loadRunHistory({background:true})');assert.equal(f.calls.length,1);pending.resolve(result());await Promise.all([first,second]);
});
test('background polling leaves failed queries pending explicit recovery',async()=>{
 const f=fixture();f.handle(async()=>{throw Error('offline');});await f.run('loadRunHistory()');await f.run('loadRunHistory({background:true})');assert.equal(f.calls.length,1);assert.equal(f.state.runHistory.error,'offline');
});
test('new filters bypass a pending page read and prevent its late rows from appearing',async()=>{
 const f=fixture(),pending=deferred();await f.run('loadRunHistory()');f.handle(url=>url.includes('cursor=')?pending.promise:Promise.resolve(result('filtered')));const second=f.context.changeRunPage('next');f.state.filter='FAILED';await f.context.refreshRunList();assert.equal(f.state.runs[0].run_id,'filtered');assert.equal(f.state.runCursor,null);pending.resolve(result('old-page'));await second;assert.equal(f.state.runs[0].run_id,'filtered');
});
for(const key of ['workspace','tenant','principal'])test('history responses and prior queries are isolated after a '+key+' change',async()=>{
 const f=fixture(),pending=deferred();await f.run('loadRunHistory()');f.state.search='private';f.handle(()=>pending.promise);const first=f.context.refreshRunList();if(key==='workspace')f.state.workspaceId='other';else f.state.meta[key]='other';pending.resolve(result('private'));await first;const history=f.run('runHistoryState()');assert.equal(history.data,null);assert.equal(history.lastSuccess,null);assert.equal(f.state.search,'');assert(!f.renders.some(r=>r.ids.includes('private')));
});
test('a route change prevents late errors and renders',async()=>{
 const f=fixture(),pending=deferred();f.handle(()=>pending.promise);const first=f.run('loadRunHistory()');const renders=f.renders.length;f.state.view='agents';f.state.routeVersion++;pending.reject(Error('old page'));await first;assert.equal(f.renders.length,renders);assert.equal(f.state.runHistory.error,'');
});
test('leaving and returning invalidates a previous same-route read',async()=>{
 const f=fixture(),pending=deferred();f.handle(()=>pending.promise);const first=f.run('loadRunHistory()');f.state.routeVersion+=2;pending.resolve(result('old-route'));await first;assert.equal(f.state.runs.length,0);f.handle(async()=>result('current'));await f.run('loadRunHistory({background:true})');assert.equal(f.state.runs[0].run_id,'current');
});
test('recovery controls suppress duplicate reads',async()=>{
 const f=fixture(),pending=deferred();f.handle(()=>pending.promise);const first=f.run('retryRunHistory()');await f.run('retryRunHistory()');assert.equal(f.calls.length,1);pending.resolve(result());await first;
});
test('returning to the first page clears the full cursor stack',async()=>{
 const f=fixture();f.state.runCursor='later';f.state.runCursorStack=[null,'second'];await f.run('retryRunHistory(true)');assert.equal(f.state.runCursor,null);assert.equal(f.state.runCursorStack.length,0);assert.doesNotMatch(f.calls[0][0],/cursor=/);
});
test('history errors are escaped and requests are frozen reads',async()=>{
 const f=fixture();f.handle(async()=>{throw Error('<script>private</script>');});await f.run('loadRunHistory()');assert.match(f.run('runHistoryNotice()'),/&lt;script&gt;/);assert.doesNotMatch(f.run('runHistoryNotice()'),/<script>/);assert(f.calls.every(c=>c[1]===undefined&&c[4].workspace==='space-a'));
});
