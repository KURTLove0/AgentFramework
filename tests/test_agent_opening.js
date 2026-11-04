'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test');
const source=fs.readFileSync(process.env.AGENT_OPENING_SOURCE||path.join(__dirname,'../agent_framework/webui/agents.js'),'utf8');
const select=source.slice(source.indexOf('function selectAgentConfigSection('),source.indexOf('function agentFieldLabel('));
const start=source.includes('let agentOpeningRequest=')?'let agentOpeningRequest=':'async function openAgent(';
const open=source.slice(source.indexOf(start),source.indexOf('const csv='));
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function sandbox(){
 const nodes={},calls=[],events={},timers=new Map();let handler=null,release,timer=0;
 const node=id=>nodes[id]||(nodes[id]={id,value:'',hidden:false,open:false,innerHTML:'',textContent:'',dataset:{},attrs:{},classList:{toggle(){}},setAttribute(k,v){this.attrs[k]=v;},focus(){document.activeElement=this;},scrollIntoView(){},reset(){calls.push({reset:true});},showModal(){this.open=true;},close(){this.open=false;},addEventListener(){}});
 const document={activeElement:null,addEventListener(){}},sections=['identity','runtime','advanced'];
 const tabs=sections.map(id=>{const tab=node('agent-config-tab-'+id);tab.dataset.agentConfigTab=id;return tab;});
 const runtime={settings:{default_runtime:'codex',profiles:{codex:{model:'fresh-model',reasoning_effort:'high',timeout:91,max_attempts:3},mock:{model:'builtin'}}}};
 const state={workspaceId:'space-a',meta:{tenant:'tenant',principal:'actor'},runtimeConfig:{settings:{default_runtime:'mock',profiles:{mock:{model:'builtin'}}}},roleCatalog:{old:true}};
 const definition={domain_pack_ref:'general-assistant@1.0.0',identity:{role:'角色'},responsibilities:[],standard_refs:[]};
 const profile={id:'agent-a',revision:1,name:'测试助手',description:'测试',runtime:'codex',model:'saved-model',prompt:'原工作指令',options:{timeout:42,max_attempts:1,reasoning_effort:'low'},skills:[],mcp_servers:[],definition};
 const replies={'/api/runtime-config':runtime,'/api/agent-domains':{domains:[{id:'fresh-domain'}]},'/api/standards':{standards:[]},'/api/domain-packs':{domain_packs:[]},'/api/capabilities':{capabilities:[]},'/api/skills':{skills:[{id:'fresh-skill'}]},'/api/agent-definition-default?domain=general-assistant%401.0.0':{definition}};
 const api=async(url,...args)=>{calls.push({url,args});return handler?handler(url,()=>structuredClone(replies[url]||profile)):structuredClone(replies[url]||profile);};
 const context=vm.createContext({state,document,console,Set,location:{hash:'#/agents'},window:{addEventListener:(name,fn)=>(events[name]??=[]).push(fn)},setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),agentConfigSections:sections.map(id=>[id,id]),
  $:selector=>node(selector.slice(1)),$$:()=>tabs,esc:String,toast:message=>calls.push({toast:message}),
  initAgentFormLayout:()=>{calls.push({layout:true});},renderAgentSaveRecovery:()=>{},clearAgentFormErrors:()=>{},loadAgentDomains:async()=>{},initRoleEditor:async()=>{},updateRolePreview:()=>{},initAgentSkills:async(p,c)=>calls.push({skills:c}),mcpRow:()=>'',agentDefaultPrompt:()=> '默认工作指令',
  refreshAgentConfiguration:()=>{},agentSetSaveAvailability:()=>{node('agent-save').disabled=!!state.agentModelLoading;},
  agentSaveContext:()=>({workspace:state.workspaceId,session:state.agentEditorSession,tenant:state.meta.tenant,principal:state.meta.principal}),
  agentSaveCurrent:s=>s.workspace===state.workspaceId&&s.session===state.agentEditorSession&&s.tenant===state.meta.tenant&&s.principal===state.meta.principal,
  loadAgentModels:async(...args)=>{calls.push({modelLoad:args});state.agentModelLoading=true;context.agentSetSaveAvailability();await new Promise(resolve=>release=resolve);state.agentModelLoading=false;context.agentSetSaveAvailability();},api});
 vm.runInContext(select+'\n'+open,context);
 return {state,node,document,calls,context,runtime,run:code=>vm.runInContext(code,context),handler:fn=>handler=fn,fire:name=>(events[name]||[]).forEach(fn=>fn()),timers:()=>{for(const [id,fn]of timers){timers.delete(id);fn();}},release(){release();}};
}
test('edit instructions opens its requested section before model discovery settles',async()=>{
 const s=sandbox(),pending=s.run('openAgent("agent-a",false,null,"runtime")');await settle();
 assert(s.node('agent-dialog').open,JSON.stringify(s.calls));assert.equal(s.state.agentConfigSection,'runtime');assert.equal(s.node('agent-config-tab-runtime').attrs['aria-selected'],'true');assert(s.node('agent-save').disabled);
 const count=s.calls.filter(c=>c.url).length;s.node('agent-prompt').value='加载期间正在编辑的指令';await s.run('openAgent("another-agent",false,null,"identity")');assert.equal(s.calls.filter(c=>c.url).length,count);
 s.release();await pending;assert.equal(s.node('agent-prompt').value,'加载期间正在编辑的指令');assert(!s.state.agentOpening);assert(!s.node('agent-save').disabled);assert.equal(s.calls.find(c=>c.modelLoad).modelLoad[2],true);
 assert.equal(s.node('agent-timeout').value,42);assert.match(s.node('agent-effort').innerHTML,/low/);
});
test('skill entry opens advanced disclosure immediately and default opening keeps basic focus',async()=>{
 for(const [requested,expected]of [['skills','advanced'],['identity','identity']]){
  const s=sandbox(),pending=s.run('openAgent("agent-a",false,null,'+JSON.stringify(requested)+')');await settle();
  assert.equal(s.state.agentConfigSection,expected);assert.equal(s.document.activeElement.id,expected==='identity'?'agent-name':'agent-config-tab-advanced');
  if(requested==='skills')assert(s.node('agent-review-skills').open);s.release();await pending;
 }
});
test('all opening data is read in parallel before any form or catalog mutation',async()=>{
 const s=sandbox(),wait=gate();s.handler(async(url,reply)=>{if(url==='/api/skills')await wait.promise;return reply();});s.node('agent-name').value='原表单';
 const pending=s.run('openAgent()');await settle();assert.equal(s.calls.filter(c=>c.url).length,7);assert(!s.calls.some(c=>c.reset));assert.equal(s.node('agent-name').value,'原表单');assert.deepEqual(s.state.roleCatalog,{old:true});
 s.timers();assert(s.node('agent-opening-dialog').open);wait.resolve();await settle();assert(!s.node('agent-opening-dialog').open);assert(s.node('agent-dialog').open);s.release();await pending;
});
test('new agent uses freshly read runtime defaults including model effort and tuning',async()=>{
 const s=sandbox(),pending=s.run('openAgent()');await settle();assert.equal(s.node('agent-runtime').value,'codex');assert.equal(s.node('agent-timeout').value,91);assert.equal(s.node('agent-attempts').value,3);assert.match(s.node('agent-effort').innerHTML,/high/);assert.equal(s.calls.find(c=>c.modelLoad).modelLoad[1],'fresh-model');assert.equal(s.calls.find(c=>c.modelLoad).modelLoad[2],true);s.release();await pending;
});
test('failed prerequisite keeps previous editor untouched and offers a retry',async()=>{
 const s=sandbox();s.handler(async(url,reply)=>{if(url==='/api/skills')throw Error('技能目录离线');return reply();});s.node('agent-name').value='原表单';await s.run('openAgent()');assert(!s.calls.some(c=>c.reset));assert.equal(s.node('agent-name').value,'原表单');assert.deepEqual(s.state.roleCatalog,{old:true});assert(!s.node('agent-dialog').open);assert(s.node('agent-opening-dialog').open);assert.match(s.node('agent-opening-status').textContent,/技能目录离线/);assert(!s.state.agentOpening);assert.equal(s.node('data-agent-opening-retry]').hidden,false);
});
test('cancel releases the opening gate immediately and fences a late success',async()=>{
 const s=sandbox(),wait=gate();s.handler(async(url,reply)=>{await wait.promise;return reply();});const pending=s.run('openAgent()');await settle();s.timers();s.run('cancelAgentOpening()');assert(!s.state.agentOpening);assert(!s.node('agent-opening-dialog').open);wait.resolve();await pending;assert(!s.node('agent-dialog').open);assert(!s.calls.some(c=>c.reset));
});
test('old failure cannot replace a new opening or release its pending state',async()=>{
 const s=sandbox(),old=gate(),next=gate();s.handler(async(url,reply)=>{await old.promise;return reply();});const first=s.run('openAgent()');await settle();s.run('cancelAgentOpening()');s.handler(async(url,reply)=>{await next.promise;return reply();});const second=s.run('openAgent()');await settle();s.timers();old.reject(Error('旧请求失败'));await first;assert(s.state.agentOpening);assert.doesNotMatch(s.node('agent-opening-status').textContent,/旧请求失败/);next.resolve();await settle();s.release();await second;
});
test('route departure and pagehide cancel a pending open without reopening on completion',async()=>{
 for(const event of ['hashchange','pagehide']){const s=sandbox(),wait=gate();s.handler(async(url,reply)=>{await wait.promise;return reply();});const pending=s.run('openAgent()');await settle();if(event==='hashchange')s.context.location.hash='#/skills';s.fire(event);assert(!s.state.agentOpening);wait.resolve();await pending;assert(!s.node('agent-dialog').open);assert(!s.calls.some(c=>c.reset));}
});
test('workspace tenant principal or editor replacement prevents late hydration',async()=>{
 for(const change of [s=>s.state.workspaceId='other',s=>s.state.meta.tenant='other',s=>s.state.meta.principal='other',s=>s.state.agentEditorSession++]){const s=sandbox(),wait=gate();s.handler(async(url,reply)=>{await wait.promise;return reply();});const pending=s.run('openAgent()');await settle();change(s);wait.resolve();await pending;assert(!s.node('agent-dialog').open);assert(!s.calls.some(c=>c.reset));assert(!s.state.agentOpening);}
});
test('reads use the captured workspace and mismatched agent response is rejected',async()=>{
 const s=sandbox();await s.run('openAgent("wrong-agent")');assert(s.calls.filter(c=>c.url).every(c=>c.args[3]?.workspace==='space-a'));assert(!s.calls.some(c=>c.reset));assert.match(s.node('agent-opening-status').textContent,/不一致/);
});
