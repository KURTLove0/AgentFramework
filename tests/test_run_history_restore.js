'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/run_history.js'),'utf8');
const defaults=()=>({search:'',filter:'all',runAgent:'',runDomain:'',runSort:'created_desc',runAfter:'',runBefore:'',runCursor:null,runCursorStack:[]});
function fixture(saved=null){
 const state={...defaults(),view:'runs',selected:null,routeVersion:1,routeHash:'#/runs',workspaceId:'space',meta:{tenant:'tenant',principal:'person'}},history={state:saved,replaceState(value){this.state=structuredClone(value);}},location={hash:'#/runs'},context=vm.createContext({state,history,location,structuredClone,Date,JSON,URLSearchParams,document:{addEventListener(){}},window:{addEventListener(){}},clearTimeout(){},esc:String,render(){},runsRequest:()=>'/api/runs',api:async()=>({runs:[],counts:{},filtered_total:0}),$:()=>null});
 vm.runInContext(source,context);return {state,history,location,context,run:text=>vm.runInContext(text,context)};
}
function savedQuery(){return {...defaults(),search:'历史目标',filter:'SUCCEEDED',runAgent:'agent-one',runDomain:'none',runSort:'updated_asc',runAfter:'2026-10-01',runBefore:'2026-10-31',runCursor:'third-page',runCursorStack:[null,'second-page']};}
test('reload restores scoped query and page stack while preserving other history metadata',()=>{
 const first=fixture({agentRoutePosition:{key:'position',top:420},unrelated:'keep'});Object.assign(first.state,savedQuery(),{runFiltersOpen:true});first.run('runHistoryState()');first.run('saveRunHistoryEntry()');
 const second=fixture(first.history.state);second.run('runHistoryState()');for(const [key,value] of Object.entries(savedQuery()))assert.deepEqual(JSON.parse(JSON.stringify(second.state[key])),value,key);
 assert(second.state.runFiltersOpen);assert.equal(second.history.state.unrelated,'keep');assert.equal(second.history.state.agentRoutePosition.top,420);
});
test('back navigation restores that entry rather than the latest in-memory query',()=>{
 const f=fixture();Object.assign(f.state,savedQuery());f.run('runHistoryState()');f.run('saveRunHistoryEntry()');const older=structuredClone(f.history.state);
 Object.assign(f.state,defaults(),{search:'后来查找'});f.run('saveRunHistoryEntry()');f.state.routeVersion++;f.history.state=older;f.run('runHistoryState()');assert.equal(f.state.search,'历史目标');assert.equal(f.state.runCursor,'third-page');
});
test('scope mismatch never restores another workspace actor or tenant query',()=>{
 const f=fixture();Object.assign(f.state,savedQuery());f.run('runHistoryState()');f.run('saveRunHistoryEntry()');
 for(const key of ['workspace','tenant','principal']){
  const next=fixture(f.history.state);if(key==='workspace')next.state.workspaceId='other';else next.state.meta[key]='other';next.run('runHistoryState()');assert.equal(next.state.search,'');assert.equal(next.state.runCursor,null);
 }
});
test('malformed saved filters and pagination are ignored with an explicit notice',()=>{
 const first=fixture();Object.assign(first.state,savedQuery());first.run('runHistoryState()');first.run('saveRunHistoryEntry()');
 const invalid=[{runSort:'unknown'},{filter:'<script>'},{search:'x'.repeat(16001)},{runAfter:'2026-02-30'},{runAfter:'2026-11-01',runBefore:'2026-10-01'},{runCursor:4},{runCursor:null},{runCursorStack:['not-first']},{runCursorStack:[null,{}]},{extra:'unexpected'}];
 for(const patch of invalid){const saved=structuredClone(first.history.state);Object.assign(saved.agentRunHistory.query,patch);const f=fixture(saved);f.run('runHistoryState()');assert.equal(f.state.search,'');assert.match(f.run('runHistoryNotice()'),/上次列表条件无法恢复/);}
});
test('history write failure leaves live filters and reads usable and explains the limitation',async()=>{
 const f=fixture();Object.assign(f.state,savedQuery());f.history.replaceState=()=>{throw Error('quota');};await f.context.loadRunHistory();assert.equal(f.state.search,'历史目标');assert.equal(f.state.runCursor,'third-page');assert.equal(f.state.runHistory.error,'');assert.match(f.run('runHistoryNotice()'),/未能保留列表条件/);
 f.history.replaceState=value=>{f.history.state=structuredClone(value);};f.run('saveRunHistoryEntry()');assert.equal(f.state.runHistory.storageError,'');
});
test('outgoing state never overwrites a target history entry during hash navigation',()=>{
 const f=fixture({target:'keep'});Object.assign(f.state,savedQuery());f.location.hash='#/agents';f.run('saveRunHistoryEntry()');assert.deepEqual(f.history.state,{target:'keep'});
 f.location.hash='#/runs';f.state.selected='run-one';f.run('saveRunHistoryEntry()');assert.deepEqual(f.history.state,{target:'keep'});
});
test('restoring conditions performs a fresh read and stores no result bodies or errors',async()=>{
 const first=fixture();Object.assign(first.state,savedQuery());first.run('runHistoryState()');first.run('saveRunHistoryEntry()');let reads=0;
 const f=fixture(first.history.state);f.context.api=async()=>{reads++;return {runs:[{run_id:'fresh-result'}],counts:{},filtered_total:1};};await f.context.loadRunHistory();assert.equal(reads,1);assert.equal(f.state.runs[0].run_id,'fresh-result');assert(!JSON.stringify(f.history.state).includes('fresh-result'));
});
test('a late response cannot replace the newer saved query',async()=>{
 const f=fixture();f.context.runsRequest=()=>'/api/runs?search='+f.state.search;let resolve;f.context.api=()=>new Promise(r=>resolve=r);f.state.search='old';const old=f.context.loadRunHistory();
 f.context.api=async()=>({runs:[],counts:{},filtered_total:0});f.state.search='new';await f.context.changeRunHistory();resolve({runs:[{run_id:'stale'}],counts:{},filtered_total:1});await old;assert.equal(f.history.state.agentRunHistory.query.search,'new');assert.equal(f.state.runs.length,0);
});
test('same-entry intentional changes survive a new route evaluation',()=>{
 const f=fixture();Object.assign(f.state,savedQuery());f.run('runHistoryState()');f.run('saveRunHistoryEntry()');f.state.search='明确指定的新查询';f.run('saveRunHistoryEntry()');f.state.routeVersion++;f.run('runHistoryState()');assert.equal(f.state.search,'明确指定的新查询');
});
test('an explicit new query clears the previous restoration warning',async()=>{
 const f=fixture();f.run('runHistoryState()');f.state.runHistory.entryNotice='上次列表条件无法恢复，当前列表将重新读取。';f.state.search='重新选择的条件';await f.context.changeRunHistory();assert.equal(f.state.runHistory.entryNotice,'');assert.equal(f.history.state.agentRunHistory.query.search,'重新选择的条件');
});
test('archive visibility survives refresh and old entries migrate to unarchived tasks',()=>{
 const f=fixture();Object.assign(f.state,savedQuery(),{runVisibility:'archived'});f.run('runHistoryState()');f.run('saveRunHistoryEntry()');
 const next=fixture(f.history.state);next.run('runHistoryState()');assert.equal(next.state.runVisibility,'archived');assert.equal(next.history.state.agentRunHistory.version,3);
 const legacy=structuredClone(f.history.state);legacy.agentRunHistory.version=1;delete legacy.agentRunHistory.query.runVisibility;const old=fixture(legacy);old.run('runHistoryState()');assert.equal(old.state.runVisibility,'active');assert.equal(old.state.runCursor,'third-page');assert.equal(old.state.runHistory.entryNotice,'');
});

test('favorites persist on reload and version two entries migrate without changing their page',()=>{
 const f=fixture();Object.assign(f.state,savedQuery(),{runFavorites:'only'});f.run('runHistoryState()');f.run('saveRunHistoryEntry()');
 const next=fixture(f.history.state);next.run('runHistoryState()');assert.equal(next.state.runFavorites,'only');
 const saved=structuredClone(f.history.state);saved.agentRunHistory.version=2;delete saved.agentRunHistory.query.runFavorites;
 const old=fixture(saved);old.run('runHistoryState()');assert.equal(old.state.runFavorites,'all');assert.equal(old.state.runCursor,'third-page');assert.equal(old.state.runHistory.entryNotice,'');
 saved.agentRunHistory.version=3;saved.agentRunHistory.query.runFavorites='unexpected';const bad=fixture(saved);bad.run('runHistoryState()');assert.match(bad.state.runHistory.entryNotice,/无法恢复/);
});
