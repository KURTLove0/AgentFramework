'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../agent_framework/webui/operations.js'),'utf8');
const report=id=>({id,goal:'评测 '+id,agent_name:'历史岗位',created_at:1,verdict:'SIMULATED',score:null,run_id:'run-'+id});
function fixture(){
 const nodes=new Map(),events=[],calls=[],messages=[],shown=[],state={workspaceId:'space-a',meta:{tenant:'tenant-a',principal:'owner-a'},view:'evaluations',selected:null,routeVersion:1};
 const document={activeElement:null,addEventListener:(type,fn,capture)=>events.push({type,fn,capture}),body:{append:node=>nodes.set(node.id,node)},createElement:()=>node('operations-dialog')};
 function node(id){
  if(nodes.has(id))return nodes.get(id);
  const handlers=new Map(),item={id,open:false,disabled:false,dataset:{},innerHTML:'',elements:[],classList:{add(){}},setAttribute(){},removeAttribute(){},focus(){document.activeElement=this;},addEventListener(type,fn){if(!handlers.has(type))handlers.set(type,[]);handlers.get(type).push(fn);},fire(type){for(const fn of handlers.get(type)||[])fn({target:this});},showModal(){this.open=true;shown.push(this.innerHTML);},close(){this.open=false;this.fire('close');},querySelector(selector){if(selector==='details')return this.innerHTML.includes('<details')?node('record-details'):null;if(selector==='[data-evaluation-record-retry]')return this.innerHTML.includes('data-evaluation-record-retry')?node('record-retry'):null;return node('record-control');}};
  nodes.set(id,item);return item;
 }
 const lookup=selector=>{
  if(['#operations-error','#operations-check','#operations-current'].includes(selector))return node(selector.slice(1));
  if(selector==='#operations-form')return node('operations-dialog').innerHTML.includes('id="operations-form"')?node('operations-form'):null;
  if(selector.startsWith('[data-view-evaluation=')){const identity=selector.match(/"([^"]+)"/)?.[1];return [...nodes.values()].find(n=>n.dataset.viewEvaluation===identity)||null;}
  return nodes.get(selector.slice(1))||null;
 };
 node('operations-dialog');node('evaluation-alert-title');node('content');
 let handler=async url=>report(url.split('/').at(-1));
 const context=vm.createContext({state,document,location:{hash:'#/evaluations'},window:{addEventListener:(type,fn)=>events.push({type:'window:'+type,fn})},structuredClone,console,
  $:lookup,$$:selector=>selector==='dialog[open]'?[...nodes.values()].filter(n=>n.open&&n.id.endsWith('dialog')):selector==='[data-view-evaluation]'?[...nodes.values()].filter(n=>n.dataset.viewEvaluation):[],esc:v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),icon:()=>'',time:()=>'',fact:()=>'',checks:{},runtimeLabel:v=>v,toast:m=>messages.push(m),refresh:async()=>{},render(){},navigate(view,id){state.view=view;state.selected=id;},api:async(...args)=>{calls.push(args);return handler(...args);}});
 vm.runInContext(source,context);
 return {state,context,calls,messages,events,shown,node,document,run:code=>vm.runInContext(code,context),handle:fn=>handler=fn,button(id='first'){const b=node('open-'+id);b.dataset.viewEvaluation=id;return b;},open(id='first'){context.clicked=this.button(id);return this.run('openEvaluationRecord(clicked)');},close(){return this.run('requestOperationClose()');},hash(){for(const e of events.filter(e=>e.type==='window:hashchange'))e.fn();}};
}
test('evaluation details open immediately with a cancellable loading state',async()=>{
 const f=fixture();let finish;f.handle(()=>new Promise(resolve=>finish=resolve));const pending=f.open();assert(f.node('operations-dialog').open);assert.match(f.node('operations-dialog').innerHTML,/正在读取/);f.close();assert(!f.node('operations-dialog').open);finish(report('first'));await pending;assert(!f.node('operations-dialog').open);assert.equal(f.messages.length,0);
});
test('failed details stay in the chosen dialog and retry the exact record',async()=>{
 const f=fixture();f.handle(async()=>{throw Error('暂时 <不可用>');});await f.open('original');assert(f.node('operations-dialog').open);assert.match(f.node('operations-dialog').innerHTML,/暂时 &lt;不可用&gt;/);assert.match(f.node('operations-dialog').innerHTML,/data-evaluation-record-retry/);
 f.handle(async()=>report('original'));await f.node('record-retry').onclick();assert.equal(f.calls.at(-1)[0],'/api/agent-evaluations/original');assert.match(f.node('operations-dialog').innerHTML,/评测 original/);assert.doesNotMatch(f.node('operations-dialog').innerHTML,/data-evaluation-record-retry/);
});
test('a slow record cannot replace the more recently selected record',async()=>{
 const f=fixture();let finish;f.handle(async url=>url.endsWith('/first')?new Promise(resolve=>finish=resolve):report('second'));const old=f.open('first');await f.open('second');finish(report('first'));await old;assert.match(f.node('operations-dialog').innerHTML,/评测 second/);assert.doesNotMatch(f.node('operations-dialog').innerHTML,/评测 first/);
});
test('the same pending record is not fetched twice through a replaced source button',async()=>{
 const f=fixture();let finish;f.handle(()=>new Promise(resolve=>finish=resolve));const first=f.open();f.context.replacement={dataset:{viewEvaluation:'first'},disabled:false};const again=f.run('openEvaluationRecord(replacement)');assert.equal(f.calls.length,1);finish(report('first'));await Promise.all([first,again]);
});
for(const field of ['workspace','tenant','principal'])test('details cannot appear after the '+field+' changes',async()=>{
 const f=fixture();let finish;f.handle(()=>new Promise(resolve=>finish=resolve));const pending=f.open();if(field==='workspace')f.state.workspaceId='space-b';else f.state.meta[field]='other';finish(report('private'));await pending;assert(!f.node('operations-dialog').open);assert.doesNotMatch(f.node('operations-dialog').innerHTML,/评测 private/);
});
test('leaving the page closes read-only details and ignores its late failure',async()=>{
 const f=fixture();let fail;f.handle(()=>new Promise((_resolve,reject)=>fail=reject));const pending=f.open();f.context.location.hash='#/agents';f.state.view='agents';f.state.routeVersion++;f.hash();assert(!f.node('operations-dialog').open);fail(Error('old page failed'));await pending;assert.equal(f.messages.length,0);assert(!f.node('operations-dialog').open);
});
test('leaving and returning to the same route invalidates the prior details request',async()=>{
 const f=fixture();let finish;f.handle(()=>new Promise(resolve=>finish=resolve));const pending=f.open();f.hash();f.hash();finish(report('first'));await pending;assert(!f.node('operations-dialog').open);
});
test('new settings take ownership of the shared dialog and block old record content',async()=>{
 const f=fixture();let finish;f.handle(()=>new Promise(resolve=>finish=resolve));const pending=f.open();f.run('operationDialog("空间设置","<p>正在编辑的设置</p>","保存",async()=>{})');finish(report('first'));await pending;assert.match(f.node('operations-dialog').innerHTML,/正在编辑的设置/);assert.doesNotMatch(f.node('operations-dialog').innerHTML,/评测 first/);
});
test('a request to inspect cannot replace an open settings editor',async()=>{
 const f=fixture();f.run('operationDialog("空间设置","<p>未保存设置</p>","保存",async()=>{})');await f.open();assert.equal(f.calls.length,0);assert.match(f.node('operations-dialog').innerHTML,/未保存设置/);
});
test('read-only close restores a surviving record button without a new request',async()=>{
 const f=fixture();await f.open();f.close();assert.equal(f.document.activeElement,f.button());assert.equal(f.calls.length,1);
});
test('a delayed close event from the old opening cannot cancel a newly opened record',async()=>{
 const f=fixture(),dialog=f.node('operations-dialog');dialog.close=function(){this.open=false;};let finish;f.handle(()=>new Promise(resolve=>finish=resolve));const old=f.open('first');f.close();f.handle(async()=>report('second'));await f.open('second');dialog.fire('close');finish(report('first'));await old;assert(dialog.open);assert.match(dialog.innerHTML,/评测 second/);
});
test('record reading freezes its workspace and sends no mutations',async()=>{
 const f=fixture();await f.open();assert.equal(f.calls[0][4].workspace,'space-a');assert(f.calls.every(c=>c[1]===undefined));
});
test('a mismatched report is rejected inside the chosen record window',async()=>{
 const f=fixture();f.handle(async()=>report('wrong'));await f.open('expected');assert.match(f.node('operations-dialog').innerHTML,/本次选择不一致/);assert.doesNotMatch(f.node('operations-dialog').innerHTML,/评测 wrong/);assert(f.node('operations-dialog').open);
});
test('closing a record whose source disappeared focuses the inbox heading',async()=>{
 const f=fixture();await f.open();f.button().dataset={};f.close();assert.equal(f.document.activeElement.id,'evaluation-alert-title');
});
test('retry remains a stable waiting control and suppresses duplicate reads',async()=>{
 const f=fixture();f.handle(async()=>{throw Error('offline');});await f.open();let finish;f.handle(()=>new Promise(resolve=>finish=resolve));const pending=f.node('record-retry').onclick(),count=f.calls.length;
 assert.match(f.node('operations-dialog').innerHTML,/aria-disabled="true" aria-busy="true"/);const duplicate=f.node('record-retry').onclick();assert.equal(f.calls.length,count);
 finish(report('first'));await Promise.all([pending,duplicate]);assert.doesNotMatch(f.node('operations-dialog').innerHTML,/data-evaluation-record-retry/);
});
test('history and alert entrances to the same report restore focus to their own source',async()=>{
 const f=fixture();f.button('same');const history=f.node('history-same');history.dataset={viewEvaluation:'same',evaluationOrigin:'history'};f.context.historyButton=history;
 await f.run('openEvaluationRecord(historyButton)');assert.match(f.node('operations-dialog').innerHTML,/执行评测明细/);f.close();assert.equal(f.document.activeElement,history);
});
