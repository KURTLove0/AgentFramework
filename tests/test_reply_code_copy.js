'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const markdownit=require('../agent_framework/webui/markdown-it-15.0.3.min.js');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
 const state={routeVersion:1,workspaceId:'workspace',meta:{tenant:'tenant',principal:'person'},detail:{conversation:{id:'task',turns:[{number:1,run_id:'run-1'}]}}},events={},documentEvents={},timers=new Map(),writes=[],blocks=[];let serial=0,write=async()=>{};
 const selection={rangeCount:0,anchorNode:null,focusNode:null,anchorOffset:0,focusOffset:0,removeAllRanges(){this.rangeCount=0;this.anchorNode=this.focusNode=null;},setBaseAndExtent(a,ao,b,bo){this.rangeCount=1;this.anchorNode=a;this.anchorOffset=ao;this.focusNode=b;this.focusOffset=bo;},toString(){return this.rangeCount?this.anchorNode.textContent.slice(Math.min(this.anchorOffset,this.focusOffset),Math.max(this.anchorOffset,this.focusOffset)):'';}};
 const document={activeElement:null,hidden:false,addEventListener:(name,fn)=>documentEvents[name]=fn,getSelection:()=>selection};
 const c=vm.createContext({state,document,navigator:{clipboard:{writeText:text=>{writes.push(text);return write(text);}}},window:{addEventListener:(name,fn)=>events[name]=fn,getSelection:()=>selection},markdownit,URL,esc:String,setTimeout:fn=>{const id=++serial;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(fs.readFileSync(process.env.REPLY_CODE_LEGACY||path.join(__dirname,'../agent_framework/webui/reply_markdown.js'),'utf8'),c);
 function mount(key='code-1',text='  print("<value>")\n\n'){
  const attrs=new Map(),manualAttrs=new Map(),node={textContent:text},code={textContent:text,firstChild:node,contains:n=>n===node},status={hidden:true,textContent:''};
  const pre={scrollLeft:130,scrollTop:4,focus(){document.activeElement=this;},contains:n=>n===code||code.contains(n)};
  const block={dataset:{replyBlock:key},isConnected:true,matches:s=>s==='.reply-code-block',closest:s=>s==='[data-conversation-id]'?{dataset:{conversationId:'task'}}:s==='[data-chat-turn]'?{dataset:{chatTurn:'1'}}:null,contains:n=>[button,manual,pre,code,node].includes(n)};
  const button={isConnected:true,disabled:false,textContent:'复制代码',closest:()=>block,hasAttribute:k=>k==='data-reply-copy-code'||attrs.has(k),getAttribute:k=>attrs.get(k),setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),focus(){document.activeElement=this;}};
  const manual={hidden:true,isConnected:true,closest:()=>block,hasAttribute:k=>k==='data-reply-select-code'||manualAttrs.has(k),focus(){document.activeElement=this;}};
  block.querySelector=s=>({'pre code':code,code,pre,'.reply-copy-status':status,'[data-reply-copy-code]':button,'[data-reply-select-code]':manual,'.reply-code-language':{textContent:'python'}}[s]||null);
  node.parentElement=code;code.closest=()=>block;
  const root={querySelectorAll:()=>[block]};const f={block,code,node,button,manual,status,pre,attrs,root};blocks.push(f);return f;
 }
 const f={c,state,document,selection,events,documentEvents,timers,writes,write:fn=>write=fn,mount,tick(){const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());},copy:item=>c.copyReplyCode(item.button)};
 f.first=mount();document.activeElement=f.first.button;
 f.replace=item=>{const snapshot=c.captureReplyReading(item.root);item.block.isConnected=item.button.isConnected=item.manual.isConnected=false;const next=mount(item.block.dataset.replyBlock,item.code.textContent);c.restoreReplyReading(next.root,snapshot);return next;};
 return f;
}
test('failed code copy exposes keyboard selection and explicit retry without changing parsed code',async()=>{
 const f=fixture(),item=f.first;f.write(async()=>{throw Error('denied');});await f.copy(item);assert.equal(item.manual.hidden,false);assert.match(item.button.textContent,/重试/);assert.match(item.status.textContent,/选中代码/);assert.equal(f.document.activeElement,item.pre);assert.equal(f.selection.toString(),item.code.textContent);
 f.write(async()=>{});await f.copy(item);assert.equal(item.status.textContent,'代码已复制');assert.deepEqual(f.writes,[item.code.textContent,item.code.textContent]);
});
test('pending code copy survives full rendering and coalesces another click',async()=>{
 const f=fixture(),d=deferred();f.write(()=>d.promise);const p=f.copy(f.first),next=f.replace(f.first);assert.equal(next.attrs.get('aria-busy'),'true');await f.copy(next);assert.equal(f.writes.length,1);d.resolve();await p;assert.equal(next.status.textContent,'代码已复制');assert(!next.attrs.has('aria-busy'));
});
test('slow clipboard access offers selection without starting another write or moving focus',async()=>{
 const f=fixture(),d=deferred();f.write(()=>d.promise);const p=f.copy(f.first);f.tick();assert.equal(f.first.manual.hidden,false);assert.match(f.first.status.textContent,/尚未确认/);assert.equal(f.document.activeElement,f.first.button);await f.copy(f.first);assert.equal(f.writes.length,1);d.resolve();await p;assert.equal(f.timers.size,0);
});
test('late denial preserves focus and selection in later user input',async()=>{
 const f=fixture(),d=deferred();f.write(()=>d.promise);const p=f.copy(f.first),input={value:'draft'};f.document.activeElement=input;d.reject(Error('denied'));await p;assert.equal(f.document.activeElement,input);assert.equal(f.selection.rangeCount,0);assert.equal(f.first.manual.hidden,false);
});
test('manual code selection and scroll survive unchanged redraws including partial backward selection',async()=>{
 const f=fixture(),item=f.first;f.write(async()=>{throw Error('denied');});await f.copy(item);f.selection.setBaseAndExtent(item.node,12,item.node,2);const next=f.replace(item);assert.equal(f.document.activeElement,next.pre);assert.equal(f.selection.anchorNode,next.node);assert.equal(f.selection.anchorOffset,12);assert.equal(f.selection.focusOffset,2);assert.equal(next.pre.scrollLeft,130);assert.equal(next.manual.hidden,false);
});
test('changed code drops the old copy receipt and selection before a new explicit copy',async()=>{
 const f=fixture(),d=deferred();f.write(()=>d.promise);const p=f.copy(f.first);f.first.code.textContent=f.first.node.textContent='new content\n';const next=f.replace(f.first);assert.notEqual(next.attrs.get('aria-busy'),'true');d.resolve();await p;assert(next.status.hidden);assert.equal(next.button.textContent,'复制代码');f.write(async()=>{});await f.copy(next);assert.equal(f.writes.at(-1),'new content\n');
});
test('independent code blocks keep separate pending operations and feedback',async()=>{
 const f=fixture(),a=deferred(),b=deferred(),other=f.mount('code-2','another\n');let calls=0;f.write(()=>++calls===1?a.promise:b.promise);const p=f.copy(f.first),q=f.copy(other);a.reject(Error('denied'));await p;assert.equal(f.first.manual.hidden,false);assert.equal(other.attrs.get('aria-busy'),'true');b.resolve();await q;assert.equal(other.status.textContent,'代码已复制');assert(other.manual.hidden);assert.equal(f.writes.length,2);
});
test('route, workspace, identity and run changes fence delayed copy completion',async()=>{
 for(const mutate of [f=>f.state.routeVersion++,f=>f.state.workspaceId='other',f=>f.state.meta.tenant='other',f=>f.state.meta.principal='other',f=>f.state.detail.conversation.id='other',f=>f.state.detail.conversation.turns[0].run_id='other'])for(const fail of [false,true]){
  const f=fixture(),d=deferred();f.write(()=>d.promise);const p=f.copy(f.first);mutate(f);f.first.status.textContent='new surface';if(fail)d.reject(Error('denied'));else d.resolve();await p;assert.equal(f.first.status.textContent,'new surface');assert(f.first.manual.hidden);
 }
});
test('detached or stale code buttons cannot start a clipboard write or select hidden text',async()=>{
 for(const stale of [f=>f.first.button.isConnected=false,f=>f.state.detail.conversation.id='other']){const f=fixture();stale(f);await f.copy(f.first);assert.equal(f.writes.length,0);f.c.selectReplyCode(f.first.manual);assert.equal(f.selection.rangeCount,0);}
});
test('page departure clears pending UI while old completion cannot finish a new copy',async()=>{
 const f=fixture(),old=deferred(),next=deferred();f.write(()=>old.promise);const p=f.copy(f.first);f.events.pagehide();assert(!f.first.attrs.has('aria-busy'));assert.equal(f.timers.size,0);f.write(()=>next.promise);const q=f.copy(f.first);old.resolve();await p;assert.equal(f.first.attrs.get('aria-busy'),'true');next.resolve();await q;assert.equal(f.first.status.textContent,'代码已复制');
});
test('missing clipboard support provides the same manual recovery',async()=>{const f=fixture();delete f.c.navigator.clipboard;await f.copy(f.first);assert.equal(f.first.manual.hidden,false);assert.equal(f.selection.toString(),f.first.code.textContent);});
test('native manual copy keeps all selected code whitespace and both selection directions',()=>{
 const f=fixture(),item=f.first;
 for(const [a,b] of [[0,item.code.textContent.length],[item.code.textContent.length,0],[2,12],[12,2]]){
  f.selection.setBaseAndExtent(item.node,a,item.node,b);const received=[];let prevented=false;f.documentEvents.copy?.({clipboardData:{setData:(type,text)=>received.push([type,text])},preventDefault:()=>prevented=true});assert(prevented);assert.deepEqual(received,[['text/plain',item.code.textContent.slice(Math.min(a,b),Math.max(a,b))]]);
 }
});
test('ordinary selections, mixed nodes, empty or stale code keep the browser default copy',()=>{
 for(const alter of [f=>f.selection.anchorNode={parentElement:{}},f=>f.selection.focusNode={},f=>f.selection.focusOffset=0,f=>f.state.detail.conversation.id='other',f=>f.first.block.isConnected=false,f=>f.document.activeElement={tagName:'TEXTAREA'},f=>f.document.activeElement={tagName:'INPUT'}]){
  const f=fixture(),item=f.first;f.selection.setBaseAndExtent(item.node,0,item.node,item.code.textContent.length);alter(f);let touched=false;f.documentEvents.copy?.({clipboardData:{setData:()=>touched=true},preventDefault:()=>touched=true});assert(!touched);
 }
});
test('unavailable event clipboard data leaves native manual copy available',()=>{
 const f=fixture(),item=f.first;f.selection.setBaseAndExtent(item.node,0,item.node,item.code.textContent.length);let prevented=false;
 for(const clipboardData of [null,{setData(){throw Error('unavailable');}}]){f.documentEvents.copy?.({clipboardData,preventDefault:()=>prevented=true});assert(!prevented);}
});
