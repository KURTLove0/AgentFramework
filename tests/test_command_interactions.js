'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test');
const app=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/app.js'),'utf8');
const source=app.includes('function openCommand(){return startCommandSearch();}')?fs.readFileSync(path.join(__dirname,'../agent_framework/webui/commands.js'),'utf8')+'\nfunction openCommand(){return startCommandSearch();}':app.slice(app.indexOf('function openCommand(){'),app.indexOf("$('#command-results').addEventListener"));
const tick=()=>new Promise(resolve=>setImmediate(resolve)),deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
 const nodes=new Map(),listeners={},calls=[],navigation=[],messages=[],timers=new Map();let clock=0,handler;
 const document={activeElement:null,getElementById:id=>nodes.get(id)||null};
 const node=id=>{
  if(nodes.has(id))return nodes.get(id);
  const el={id,value:'',textContent:'',_html:'',open:false,hidden:false,disabled:false,isConnected:true,attrs:{},dataset:{},events:{},scrollTop:0,
   addEventListener(type,fn){(this.events[type]??=[]).push(fn);},setAttribute(k,v){this.attrs[k]=String(v);},removeAttribute(k){delete this.attrs[k];},focus(){document.activeElement=this;},scrollIntoView(){},querySelector(){return null;},
   showModal(){this.open=true;},close(){this.open=false;for(const fn of this.events.close||[])fn();},
   get innerHTML(){return this._html;},set innerHTML(value){this._html=value;for(const match of value.matchAll(/id="([^"]+)"/g))node(match[1]);}};
  nodes.set(id,el);return el;
 };
 const state={workspaceId:'space-a',meta:{tenant:'tenant-a',principal:'person-a'},routeVersion:1,runs:[{run_id:'filtered-background',goal:'不能混入搜索的旧运行'}],commandItems:[],commandIndex:0,view:'workbench'},location={hash:'#/workbench'};
 const empty=url=>url.startsWith('/api/runs')?{runs:[],filtered_total:0}:url.startsWith('/api/agents')?{agents:[]}:url.startsWith('/api/workflows')?{workflows:[],runs:[]}:url.startsWith('/api/skills')?{skills:[]}:{knowledge:[],memory:{preferences:[],notes:[]},experience:[],capability_methods:[],ontologies:[]};
 handler=async url=>empty(url);
 const context=vm.createContext({state,document,location,console,Promise,Set,Map,encodeURIComponent,
  window:{addEventListener:(key,fn)=>(listeners[key]??=[]).push(fn)},$:selector=>node(selector==='[data-action="command"]'?'trigger':selector.slice(1)),$$:selector=>selector==='dialog[open]'?[...nodes.values()].filter(n=>n.id.endsWith('dialog')&&n.open):[],
  esc:x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),icon:()=>'',labels:{SUCCEEDED:'已完成'},assetStatuses:{PUBLISHED:'已发布'},scenario:()=>'',
  flowHistory:()=>state.flowHistory??={search:'',status:'all',cursor:null,stack:[],request:0},
  pageNames:{workbench:'任务工作台',runs:'运行记录',agents:'智能体',workflows:'工作流',skills:'技能',library:'知识库'},
  api:async(url,body,timeout,retry,scope)=>{calls.push({url,body,scope});return handler(url,scope);},
  setTimeout:fn=>{timers.set(++clock,fn);return clock;},clearTimeout:id=>timers.delete(id),
  navigate:(view,id)=>navigation.push({view,id}),newTask:()=>navigation.push({newTask:true}),openSkillEditor:(id,mode)=>navigation.push({skill:id,mode}),toast:message=>messages.push(message)});
 vm.runInContext(source,context);document.activeElement=node('trigger');
 return {state,node,nodes,document,calls,navigation,messages,location,empty,run:code=>vm.runInContext(code,context),handle:fn=>handler=fn,
  async open(){const pending=vm.runInContext('openCommand()',context);await tick();return {pending};},
  async search(value){node('command-input').value=value;vm.runInContext('scheduleCommandSearch()',context);await tick();},
  async flush(){const callbacks=[...timers.values()];timers.clear();for(const fn of callbacks)fn();await tick();},
  close(){node('command-dialog').close();},changeRoute(){location.hash='#/agents';state.routeVersion++;for(const fn of listeners.hashchange||[])fn();}};
}
const agent=(id,name=id)=>({id,name,description:'整理事项',archived:false}),run=(id,goal=id)=>({run_id:id,goal,status:'SUCCEEDED'});
test('body-only search hits display the matching round and navigate with the query',async()=>{
 const f=fixture();f.run("function runTextMatchSummary(hit){return '第 '+hit.turn+' 轮 · '+hit.match;} function openRunTextMatch(row,query){state.textTarget={id:row.run_id,turn:row.search_match.turn,query};}");
 f.handle(async url=>url.startsWith('/api/runs')?{runs:[{...run('body-only','标题不含查询'),search_match:{turn:3,role:'assistant',before:'',match:'交付码',after:''}}],filtered_total:1}:f.empty(url));
 await f.open();await f.search('交付码');await f.flush();const index=f.state.commandItems.findIndex(item=>item.key==='run:body-only');assert(index>=0);assert.match(f.state.commandItems[index].sub,/第 3 轮 · 交付码/);f.run('runCommand('+index+')');assert.deepEqual(JSON.parse(JSON.stringify(f.state.textTarget)),{id:'body-only',turn:3,query:'交付码'});
});
test('opening shows pending feedback and never mixes the background run list',async()=>{
 const f=fixture(),hold=deferred();f.handle(()=>hold.promise);await f.open();
 assert.match(f.node('command-summary').textContent,/正在读取/);assert(!f.state.commandItems.some(x=>x.title==='不能混入搜索的旧运行'));hold.resolve({});await tick();
});
test('one failed catalog leaves successful results usable with inline recovery',async()=>{
 const f=fixture();f.handle(async url=>{if(url.includes('/agents'))return {agents:[agent('a','独立资源')]};if(url.includes('/skills'))throw Error('<暂不可用>');return f.empty(url);});await f.open();await f.search('独立资源');await f.flush();
 assert(f.state.commandItems.some(x=>x.title==='独立资源'));assert.match(f.node('command-errors').innerHTML,/重试技能/);assert.match(f.node('command-errors').innerHTML,/&lt;暂不可用&gt;/);assert.equal(f.messages.length,0);
});
test('a slow source does not block another catalog from appearing',async()=>{
 const f=fixture(),hold=deferred();f.handle(async url=>url.includes('/skills')?hold.promise:url.includes('/agents')?{agents:[agent('a','先到结果')]}:f.empty(url));await f.open();await f.search('先到结果');await f.flush();
 assert(f.state.commandItems.some(x=>x.title==='先到结果'));hold.resolve({skills:[]});await tick();
});
test('retry rereads only the failed source and preserves the input',async()=>{
 const f=fixture();let fail=true;f.handle(async url=>{if(url.includes('/skills')&&fail)throw Error('offline');return f.empty(url);});await f.open();await f.search('中文关键词');await f.flush();const before=f.calls.length;fail=false;await f.run('retryCommandSource("skills")');
 assert.deepEqual(f.calls.slice(before).map(x=>x.url),['/api/skills']);assert.equal(f.node('command-input').value,'中文关键词');assert(!f.node('command-errors').innerHTML.includes('offline'));
});
test('a new query clears prior query results before the debounce completes',async()=>{
 const f=fixture();f.handle(async url=>url.startsWith('/api/runs')?{runs:[run('old','旧查询结果')],filtered_total:1}:f.empty(url));await f.open();await f.search('旧');await f.flush();assert(f.state.commandItems.some(x=>x.title==='旧查询结果'));
 await f.search('新');assert(!f.state.commandItems.some(x=>x.title==='旧查询结果'));assert.match(f.node('command-summary').textContent,/正在读取/);
});
test('older success and failure cannot overwrite a newer query or show a toast',async()=>{
 const f=fixture(),old=deferred();f.handle(async url=>{if(url.startsWith('/api/runs')&&url.includes('old'))return old.promise;if(url.startsWith('/api/runs'))return {runs:[run('new','new')],filtered_total:1};return f.empty(url);});await f.open();await f.search('old');await f.flush();await f.search('new');await f.flush();old.reject(Error('late failure'));await tick();
 assert(f.state.commandItems.some(x=>x.title==='new'));assert(!f.node('command-errors').innerHTML.includes('late'));assert.deepEqual(f.messages,[]);
});
for(const scope of ['workspace','tenant','principal'])test('a '+scope+' change rejects late private results and activation',async()=>{
 const f=fixture(),hold=deferred();f.handle(async url=>url.includes('/agents')?hold.promise:f.empty(url));await f.open();await f.search('私有');await f.flush();if(scope==='workspace')f.state.workspaceId='space-b';else f.state.meta[scope]='other';hold.resolve({agents:[agent('secret','私有资料')]});await tick();f.run('runCommand(0)');
 assert(!f.state.commandItems.some(x=>x.title==='私有资料'));assert.deepEqual(f.navigation,[]);
});
test('all reads capture the opening workspace and remain GET requests',async()=>{
 const f=fixture();await f.open();await f.search('查询');await f.flush();assert(f.calls.length>=7);assert(f.calls.every(x=>x.body===undefined&&x.scope?.workspace==='space-a'&&x.scope.payload===undefined));
});
test('close and reopen isolate sessions and restore the same-scope query',async()=>{
 const f=fixture(),old=deferred();let opening=1;f.handle(async url=>url.includes('/agents')&&opening===1?old.promise:f.empty(url));await f.open();await f.search('原关键词');await f.flush();f.close();opening=2;await f.open();old.resolve({agents:[agent('stale','原关键词旧会话')]});await tick();
 assert.equal(f.node('command-input').value,'原关键词');assert(!f.state.commandItems.some(x=>x.title==='原关键词旧会话'));
});
test('leaving the route closes the palette and ignores late failure',async()=>{
 const f=fixture(),hold=deferred();f.handle(()=>hold.promise);await f.open();f.changeRoute();hold.reject(Error('late'));await tick();assert(!f.node('command-dialog').open);assert.deepEqual(f.messages,[]);
});
test('server matches in content are kept even when the title does not contain the query',async()=>{
 const f=fixture();f.handle(async url=>url.startsWith('/api/knowledge-hub')?{...f.empty(url),knowledge:[{ref:'asset@1',title:'标题不含正文关键词',status:'PUBLISHED',version:1}]}:f.empty(url));await f.open();await f.search('needle');await f.flush();assert(f.state.commandItems.some(x=>x.title==='标题不含正文关键词'));
});
test('late arrivals retain the selected identity instead of reusing its numeric position',async()=>{
 const f=fixture(),hold=deferred();f.handle(async url=>url.startsWith('/api/runs')?hold.promise:url.includes('/agents')?{agents:[agent('a','目标甲'),agent('b','目标乙')]}:f.empty(url));await f.open();await f.search('目标');await f.flush();f.run('moveCommandSelection(1)');assert.equal(f.state.commandItems[f.state.commandIndex].title,'目标乙');hold.resolve({runs:[run('r','目标运行')],filtered_total:1});await tick();assert.equal(f.state.commandItems[f.state.commandIndex].title,'目标乙');f.run('runCommand(state.commandIndex)');assert.deepEqual(f.navigation,[{view:'agents',id:'b'}]);
});
test('all matching catalog results remain reachable by result pages',async()=>{
 const f=fixture();f.handle(async url=>url.includes('/agents')?{agents:Array.from({length:31},(_,i)=>agent('a'+i,'匹配 '+i))}:f.empty(url));await f.open();await f.search('匹配');await f.flush();const ids=[];for(let i=0;i<3;i++){ids.push(...f.state.commandItems.map(x=>x.title));if(i<2)f.run('changeCommandPage(1)');}assert.equal(new Set(ids).size,31);assert.equal(f.node('command-next').disabled,true);
});
test('workflow selection targets its definition and opens no editor or write',async()=>{
 const f=fixture();f.handle(async url=>url.includes('/workflows')?{workflows:[{id:'flow-b',name:'目标流程',revision:2,nodes:[]}],runs:[]}:f.empty(url));await f.open();await f.search('目标流程');await f.flush();f.run('runCommand(0)');assert.equal(f.state.commandFlowTarget?.id,'flow-b');assert.deepEqual(f.navigation,[{view:'workflows',id:undefined}]);assert(f.calls.every(x=>x.body===undefined));
});
test('more than 50 run matches provide a route to the complete filtered history',async()=>{
 const f=fixture();f.handle(async url=>url.startsWith('/api/runs')?{runs:[run('one','匹配')],filtered_total:251}:f.empty(url));await f.open();await f.search('匹配');await f.flush();const i=f.state.commandItems.findIndex(x=>x.key==='runs:all');assert(i>=0);f.state.filter='FAILED';f.state.runAgent='old';f.state.runFavorites='only';f.run('runCommand('+i+')');assert.equal(f.state.search,'匹配');assert.equal(f.state.filter,'all');assert.equal(f.state.runAgent,'');assert.equal(f.state.runFavorites,'all');assert.deepEqual(f.navigation,[{view:'runs',id:undefined}]);
});
test('uncommitted programmatic or IME text cannot activate an old result',async()=>{
 const f=fixture();await f.open();f.node('command-input').value='尚未提交';f.run('runCommand(0)');assert.deepEqual(f.navigation,[]);
});
test('the generic task action no longer implies a fixed evaluation workflow',async()=>{
 const f=fixture();await f.open();assert(f.state.commandItems.some(x=>x.title==='新建任务'));assert(!f.state.commandItems.some(x=>x.title==='新建评估任务'));
});
test('clearing a query fetches unfiltered recent runs instead of reusing filtered results',async()=>{
 const f=fixture();f.handle(async url=>url.startsWith('/api/runs')?{runs:[run('r',url.endsWith('search=')?'未筛选任务':'筛选结果')],filtered_total:1}:f.empty(url));await f.open();await f.search('筛选');await f.flush();await f.search('');await f.flush();assert(f.state.commandItems.some(x=>x.title==='未筛选任务'));assert(!f.state.commandItems.some(x=>x.title==='筛选结果'));
});
test('retry keeps one in-flight request even when activated repeatedly',async()=>{
 const f=fixture(),hold=deferred();let retry=false;f.handle(async url=>{if(url.includes('/skills')){if(retry)return hold.promise;throw Error('offline');}return f.empty(url);});await f.open();retry=true;const before=f.calls.length,pending=f.run('retryCommandSource("skills")');await tick();f.run('retryCommandSource("skills")');assert.equal(f.calls.length,before+1);assert.match(f.node('command-errors').innerHTML,/aria-disabled="true"/);hold.resolve({skills:[]});await pending;
});
test('reopening restores a selected item on a later page after catalogs finish reading',async()=>{
 const f=fixture(),data={agents:Array.from({length:31},(_,i)=>agent('a'+i,'定位 '+i))};let hold;
 f.handle(async url=>url.includes('/agents')?(hold?hold.promise:data):f.empty(url));await f.open();await f.search('定位');await f.flush();f.run('changeCommandPage(1);moveCommandSelection(2)');const key=f.state.commandSelectedKey;f.close();hold=deferred();await f.open();assert.equal(f.node('command-input').value,'定位');hold.resolve(data);await tick();assert.equal(f.state.commandSelectedKey,key);assert.equal(f.state.commandPage,1);
});
test('a different workspace never inherits remembered private search text',async()=>{
 const f=fixture();await f.open();await f.search('私密关键词');await f.flush();f.close();f.state.workspaceId='space-b';await f.open();assert.equal(f.node('command-input').value,'');
});
test('workflow focus expands the exact card and an abandoned route clears its target',async()=>{
 const f=fixture();f.run('openCommandWorkflow("flow-a")');f.state.view='workflows';f.state.flows={workflows:[{id:'flow-a'}]};const details={open:false},card=f.node('flow-definition-flow-a');card.querySelector=()=>details;f.run('focusCommandWorkflow()');assert(details.open);assert.equal(f.document.activeElement,card);assert.equal(f.state.commandFlowTarget,null);f.run('openCommandWorkflow("flow-b")');f.changeRoute();assert.equal(f.state.commandFlowTarget,null);
});
  flowHistory:()=>state.flowHistory??={search:'',status:'all',cursor:null,stack:[],request:0},
test('workflow run search preserves server metadata matches outside the visible name',async()=>{
 const f=fixture();f.handle(async url=>url.startsWith('/api/workflow-runs?')?{runs:[{id:'oldest-flow',name:'早期流程',status:'SUCCEEDED'}],filtered_total:1}:f.empty(url));await f.open();await f.search('change-old');await f.flush();const i=f.state.commandItems.findIndex(x=>x.key==='flow-run:oldest-flow');assert(i>=0);f.run('runCommand('+i+')');assert.deepEqual(f.navigation,[{view:'workflows',id:'oldest-flow'}]);assert(f.calls.some(c=>c.url.includes('/api/workflow-runs?limit=50&search=change-old')));
});
test('complete workflow results reset the history filters while retaining the command keyword',async()=>{
 const f=fixture();f.handle(async url=>url.startsWith('/api/workflow-runs?')?{runs:[{id:'one',name:'匹配流程',status:'SUCCEEDED'}],filtered_total:267}:f.empty(url));await f.open();await f.search('匹配流程');await f.flush();f.run("Object.assign(flowHistory(),{search:'old',status:'FAILED',cursor:'old-page',stack:['first'],data:{runs:[]}})");const i=f.state.commandItems.findIndex(x=>x.key==='flow-runs:all');assert(i>=0);f.run('runCommand('+i+')');assert.equal(f.state.flowHistory.search,'匹配流程');assert.equal(f.state.flowHistory.status,'all');assert.equal(f.state.flowHistory.cursor,null);assert.equal(f.state.flowHistory.stack.length,0);assert.equal(f.state.flowSection,'runs');assert.deepEqual(f.navigation,[{view:'workflows',id:undefined}]);
});
test('closing search restores a rendered replacement of its original input',async()=>{
 const f=fixture(),original=f.node('original-input');original.tabIndex=0;original.getClientRects=()=>[{}];f.document.activeElement=original;await f.open();original.isConnected=false;const replacement={...original,isConnected:true,focus(){f.document.activeElement=this;}};f.nodes.set('original-input',replacement);f.close();assert.equal(f.document.activeElement,replacement);
});
test('a nonfocusable shortcut origin falls back to search and gives task creation a usable opener',async()=>{
 const f=fixture();f.document.activeElement={isConnected:true,tabIndex:-1};await f.open();f.close();assert.equal(f.document.activeElement.id,'trigger');f.document.activeElement={isConnected:true,tabIndex:-1};await f.open();f.run('function newTask(options,opener){state.newTaskFocus=opener.id;}');f.run('runCommand(0)');assert.equal(f.state.newTaskFocus,'trigger');
});
