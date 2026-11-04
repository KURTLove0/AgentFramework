'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../agent_framework/webui/task_search.js'),'utf8');
function fixture(){
 const handlers={},timers=new Map();let tick=0,scope='tenant:space:user:task-a';
 const list={dataset:{chatScope:scope}},input={value:''},status={textContent:''};
 const c=vm.createContext({console,Date,NodeFilter:{SHOW_TEXT:4},taskChatScope:()=>scope,taskChatUI:{scroll:new Map()},setTimeout:fn=>{timers.set(++tick,fn);return tick;},clearTimeout:id=>timers.delete(id),document:{getElementById:id=>({'task-message-list':list,'task-search-input':input,'task-search-status':status}[id]),querySelectorAll:()=>[],addEventListener:(name,fn)=>handlers[name]=fn}});
 vm.runInContext(source,c);return {c,handlers,timers,list,input,status,setScope:s=>{scope=s;list.dataset.chatScope=s;}};
}
const plain=value=>JSON.parse(JSON.stringify(value));
test('search treats regex characters as literal text and trims the query',()=>{
 const {c}=fixture();for(const text of ['a+b','[a]','x.y','a\\b','${x}','(hi)?','a^b|c','x*y'])assert.deepEqual(plain(c.taskSearchOffsets('pre '+text+' end',' '+text+' ')),{hits:[{start:4,end:4+text.length}],capped:false});
 assert.deepEqual(plain(c.taskSearchOffsets('anything',' \n ')),{hits:[],capped:false});
});
test('Unicode case-insensitive matching preserves original UTF-16 ranges',()=>{
 const {c}=fixture();assert.deepEqual(plain(c.taskSearchOffsets('İ ABC 🧭 中文 abc','abc').hits),[{start:2,end:5},{start:12,end:15}]);assert.deepEqual(plain(c.taskSearchOffsets('🧭中文🧭','🧭').hits),[{start:0,end:2},{start:4,end:6}]);
});
test('matches do not overlap and truncation is reported only when another match exists',()=>{
 const {c}=fixture();assert.equal(c.taskSearchOffsets('aaaaa','aa').hits.length,2);assert.equal(c.taskSearchOffsets('x'.repeat(500),'x').capped,false);const capped=c.taskSearchOffsets('x'.repeat(501),'x');assert.equal(capped.hits.length,500);assert(capped.capped);assert(c.taskSearchOffsets('x','x',0).capped);
});
test('range mapping spans formatting nodes without changing the text',()=>{
 const {c}=fixture(),a={textContent:'任务'},b={textContent:'进度'},record={};c.document.createRange=()=>({setStart:(node,offset)=>record.start=[node,offset],setEnd:(node,offset)=>record.end=[node,offset]});
 c.taskSearchRange([{node:a,start:0,end:2},{node:b,start:2,end:4}],{start:1,end:3});assert.deepEqual(record.start,[a,1]);assert.deepEqual(record.end,[b,1]);assert.equal(a.textContent+b.textContent,'任务进度');
});
test('search query and reading mode are isolated by task and workspace scope',()=>{
 const f=fixture(),a=f.c.taskSearchState();a.open=true;a.applied=a.query='first';assert(f.c.taskSearchHoldsReading());f.setScope('tenant:other:user:task-a');const b=f.c.taskSearchState();assert.equal(b.query,'');assert(!f.c.taskSearchHoldsReading());assert(!f.c.taskSearchCurrent(a));f.setScope(a.scope);assert.equal(f.c.taskSearchState(),a);assert(f.c.taskSearchHoldsReading());
});
test('debounced work checks the scope again and route departure clears timers and DOM references',()=>{
 const f=fixture(),h=f.c.taskSearchState();h.open=true;f.input.value='delayed';let refreshes=0;f.c.refreshTaskSearch=()=>refreshes++;f.c.scheduleTaskSearch();const pending=[...f.timers.values()][0];f.setScope('tenant:space:user:task-b');f.timers.clear();pending();assert.equal(refreshes,0);f.setScope(h.scope);f.c.scheduleTaskSearch();h.matches=[{body:{}}];f.c.leaveTaskSearch();assert.equal(h.matches.length,0);assert.equal(f.timers.size,0);
 assert.equal(h.query,'delayed');assert.equal(h.applied,'delayed');
});
test('IME confirmation does not navigate or submit; normal Enter and Shift+Enter navigate',()=>{
 const f=fixture(),h=f.c.taskSearchState();h.open=true;f.input.value='中文';let moves=0,prevented=0;f.c.moveTaskSearch=n=>moves+=n;const event={target:{id:'task-search-input'},key:'Enter',preventDefault:()=>prevented++};
 f.handlers.compositionstart(event);f.c.scheduleTaskSearch();assert.equal(f.timers.size,0);f.handlers.keydown(event);assert.equal(moves,0);f.handlers.compositionend(event);f.handlers.keydown(event);assert.equal(moves,0);h.compositionEnded=0;f.handlers.keydown(event);assert.equal(moves,1);f.handlers.keydown({...event,shiftKey:true});assert.equal(moves,0);assert.equal(prevented,2);
});
test('status explains no results, capped results and unsupported text highlighting',()=>{
 const {c}=fixture(),h=c.taskSearchState();h.applied='x';assert.match(c.taskSearchStatus(h),/没有找到.*不含运行过程与配置/);h.matches=[{turn:'4',role:'assistant',preview:true}];h.index=0;h.capped=true;assert.match(c.taskSearchStatus(h),/第 1 \/ 1 处 · 第 4 轮 · 生成片段/);assert.match(c.taskSearchStatus(h),/仅显示前 500 处/);assert.match(c.taskSearchStatus(h),/未提供文字高亮/);
});
