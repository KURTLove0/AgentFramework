'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(process.env.AGENT_DOMAIN_CREATE_SOURCE||path.join(__dirname,'../agent_framework/webui/agent_domains.js'),'utf8');
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function setup(){
 const nodes=new Map(),calls=[],state={workspaceId:'space',agentEditorSession:1,meta:{tenant:'tenant',principal:'user'},agentDomains:[]};let handler=async()=>({id:'domain-created',revision:1,name:'领域',description:'用途',work_method:'步骤'});
 const node=key=>{if(!nodes.has(key))nodes.set(key,{value:'',disabled:false,hidden:false,isConnected:true,open:key==='#agent-dialog',textContent:'',attrs:{},addEventListener(){},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},checkValidity:()=>true});return nodes.get(key);};
 node('#agent-domain-name').value='  领域  ';node('#agent-domain-description').value=' 用途 ';node('#agent-domain-method').value='步骤\n 保留缩进';node('#agent-domain-create').textContent='创建并选用';
 const context=vm.createContext({state,structuredClone,JSON,document:{addEventListener(){},contains:n=>n.isConnected},window:{addEventListener(){}},$:node,agentSetSaveAvailability:()=>calls.push({availability:true}),scheduleAgentConfigurationRefresh(){},showAgentFormError:message=>calls.push({error:message}),agentSaveContext:()=>({workspace:state.workspaceId,session:state.agentEditorSession,tenant:state.meta.tenant,principal:state.meta.principal}),agentSaveCurrent:s=>s.workspace===state.workspaceId&&s.session===state.agentEditorSession&&s.tenant===state.meta.tenant&&s.principal===state.meta.principal,lockFormSubmission:form=>{calls.push({lock:form});return()=>calls.push({unlock:true});},api:(url,...args)=>{calls.push({url,args});return handler(url,...args);}});
 vm.runInContext(source,context);context.toggleAgentDomainEditor=open=>{node('#agent-domain-create-fields').hidden=!open;calls.push({toggle:open});};context.changeAgentDomain=async id=>{state.agentSelectedDomain=id;calls.push({selected:id});};
 return {state,node,calls,context,create:()=>context.createAndUseAgentDomain(),handler:fn=>handler=fn};
}
test('inline creation captures a stable scoped payload and locks the full agent form',async()=>{
 const h=setup(),g=gate();h.handler(()=>g.promise);const p=h.create(),request=h.calls.find(c=>c.url);assert.equal(request.args[3]?.workspace,'space');assert.equal(request.args[3]?.payload,JSON.stringify({name:'领域',description:'用途',work_method:'步骤\n 保留缩进'}));assert.equal(h.calls.find(c=>c.lock)?.lock,h.node('#agent-form'));assert(h.state.agentDomainSaving);assert(h.node('#agent-domain-create').disabled);assert.match(h.node('#agent-domain-create').textContent,/正在创建/);g.resolve({id:'domain-created',revision:1,name:'领域'});await p;assert.equal(h.state.agentSelectedDomain,'domain-created');assert(!h.state.agentDomainSaving);assert.equal(h.calls.filter(c=>c.unlock).length,1);
});
test('inline creation ignores repeated activation until the accepted response is applied',async()=>{
 const h=setup(),g=gate();h.handler(()=>g.promise);const p=h.create();await h.create();assert.equal(h.calls.filter(c=>c.url).length,1);g.resolve({id:'domain-created',revision:1,name:'领域'});await p;assert.equal(h.node('#agent-domain-name').value,'');assert.equal(h.state.agentDomains.length,1);
});
test('inline creation failure unlocks the form and preserves exact fields for explicit retry',async()=>{
 const h=setup();h.handler(async()=>{throw Error('连接中断');});await h.create();assert.equal(h.calls.filter(c=>c.unlock).length,1);assert.equal(h.node('#agent-domain-name').value,'  领域  ');assert.equal(h.node('#agent-domain-method').value,'步骤\n 保留缩进');assert.equal(h.state.agentSelectedDomain,undefined);assert(h.calls.some(c=>c.error==='连接中断'));assert(!h.state.agentDomainSaving);assert(!h.node('#agent-domain-create').disabled);h.handler(async()=>({id:'domain-created',revision:1,name:'领域'}));await h.create();const requests=h.calls.filter(c=>c.url);assert.equal(JSON.stringify(requests[0].args[0]),JSON.stringify(requests[1].args[0]));assert.equal(h.state.agentSelectedDomain,'domain-created');
});
test('closed editor saving agent and hidden inline editor cannot start domain creation',async()=>{
 for(const change of [h=>h.node('#agent-dialog').open=false,h=>h.state.agentSaving=true,h=>h.state.agentSaveReviewLoading=true,h=>h.node('#agent-domain-create-fields').hidden=true]){const h=setup();change(h);await h.create();assert.equal(h.calls.filter(c=>c.url).length,0);}
});
test('invalid inline fields do not lock or submit the editor',async()=>{
 for(const change of [h=>h.node('#agent-domain-name').value=' ',h=>h.node('#agent-domain-method').checkValidity=()=>false]){const h=setup();change(h);await h.create();assert(!h.calls.some(c=>c.url||c.lock));assert(h.calls.some(c=>c.error));}
});
test('scope or editor replacement fences both accepted and failed inline creation responses',async()=>{
 for(const failed of [false,true])for(const change of [h=>h.state.agentEditorSession++,h=>h.state.workspaceId='other',h=>h.state.meta.tenant='other',h=>h.state.meta.principal='other',h=>h.node('#agent-dialog').open=false,h=>h.node('#agent-form').isConnected=false]){
  const h=setup(),g=gate();h.handler(()=>g.promise);const p=h.create();change(h);h.node('#agent-domain-name').value='后来输入';if(failed)g.reject(Error('旧提交失败'));else g.resolve({id:'domain-old',revision:1,name:'旧领域'});await p;assert(!h.calls.some(c=>c.selected||c.error));assert.equal(h.node('#agent-domain-name').value,'后来输入');assert(!h.state.agentDomainSaving);assert.equal(h.calls.filter(c=>c.unlock).length,1);
 }
});
