'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{test}=require('node:test');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const decode=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(text='## 回复\n\n  空格 😀 <script>literal()</script>\n'){
 const state={view:'runs',routeVersion:1,workspaceId:'space',meta:{tenant:'tenant',principal:'person'},selected:'task',detail:{conversation:{id:'task',turns:[{number:1,run_id:'run-1',reply:{content:text}}]}}},nodes=new Map(),events={},clicks=[],timers=new Map(),copied=[],toasts=[];let serial=0,write=async()=>{};
 const document={activeElement:null,hidden:false,addEventListener:(name,fn)=>{if(name==='click')clicks.push(fn);},getElementById:id=>nodes.get(id)||null};
 const ctx=vm.createContext({state,document,window:{addEventListener:(name,fn)=>{events[name]=fn;}},navigator:{clipboard:{writeText:value=>{copied.push(value);return write(value);}}},esc,icon:()=>'',toast:s=>toasts.push(s),setTimeout:fn=>{const id=++serial;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
 const legacy=process.env.TASK_REPLY_COPY_LEGACY;
 vm.runInContext(fs.readFileSync(legacy||path.join(__dirname,'../agent_framework/webui/task_reply_copy.js'),'utf8'),ctx);
 const f={ctx,state,nodes,events,timers,copied,toasts,document,write:fn=>write=fn,turn:()=>state.detail.conversation.turns[0]};
 f.mount=()=>{
  if(f.button)f.button.isConnected=false;
  const attrs=new Map(),scope=JSON.stringify([state.meta.tenant,state.workspaceId,state.meta.principal,state.detail.conversation.id,state.routeVersion]);
  f.button={id:'task-reply-copy-1',isConnected:true,dataset:{chatCopy:'1',copyScope:scope,copyRun:f.turn().run_id},attrs,innerHTML:'复制回复',setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),closest:s=>s==='[data-chat-copy]'?f.button:null};
  f.status={textContent:'',hidden:true};f.manual={hidden:true,querySelector:()=>nodes.get('task-reply-copy-text-1')||null};
  Object.defineProperty(f.manual,'innerHTML',{set(html){if(!html){nodes.delete('task-reply-copy-text-1');return;}const match=html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);if(match){const area={value:decode(match[1]),selected:false,focus(){document.activeElement=this;},select(){this.selected=true;}};nodes.set('task-reply-copy-text-1',area);}}});
  nodes.set(f.button.id,f.button);nodes.set('task-reply-copy-status-1',f.status);nodes.set('task-reply-copy-feedback-1',{querySelector:()=>f.manual});
 };
 f.mount();document.activeElement=f.button;
 f.copy=()=>ctx.copyTaskReply?ctx.copyTaskReply(f.button):clicks.at(-1)({target:f.button});
 f.tick=()=>{const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());};
 return f;
}
test('whole reply copy captures the exact raw text and reports locally',async()=>{const f=fixture();await f.copy();assert.deepEqual(f.copied,[f.turn().reply.content]);assert.match(f.status.textContent,/原文已复制/);assert.deepEqual(f.toasts,[]);});
test('pending clipboard writes cannot be duplicated, even after a render replaces the button',async()=>{const f=fixture(),d=deferred();f.write(()=>d.promise);const p=f.copy();assert.equal(f.button.attrs.get('aria-busy'),'true');f.mount();await f.copy();assert.equal(f.copied.length,1);d.resolve();await p;assert.match(f.status.textContent,/已复制/);assert(!f.button.attrs.has('aria-busy'));});
test('denied clipboard exposes exact selected raw text and allows an explicit retry',async()=>{const f=fixture();f.write(async()=>{throw Error('denied');});await f.copy();const text=f.nodes.get('task-reply-copy-text-1');assert(text);assert.equal(text.value,f.turn().reply.content);assert(text.selected);assert.equal(f.document.activeElement,text);assert.match(f.status.textContent,/重试.*手动/);f.write(async()=>{});await f.copy();assert.equal(f.copied.length,2);assert.match(f.status.textContent,/已复制/);assert.equal(f.document.activeElement,text);});
test('unavailable clipboard is a recoverable local failure',async()=>{const f=fixture();delete f.ctx.navigator.clipboard;await f.copy();assert.equal(f.manual.hidden,false);assert.match(f.status.textContent,/自动复制未完成/);});
test('late failure cannot move focus away from later composing',async()=>{const f=fixture(),d=deferred();f.write(()=>d.promise);const p=f.copy(),composer={value:'keep draft'};f.document.activeElement=composer;d.reject(Error('denied'));await p;assert.equal(f.document.activeElement,composer);assert.equal(f.nodes.get('task-reply-copy-text-1')?.value,f.turn().reply.content);});
test('slow permission response offers manual copy while keeping one pending write',async()=>{const f=fixture(),d=deferred();f.write(()=>d.promise);const p=f.copy();f.tick();assert.match(f.status.textContent,/尚未确认/);assert.equal(f.manual.hidden,false);await f.copy();assert.equal(f.copied.length,1);d.resolve();await p;assert.match(f.status.textContent,/已复制/);assert.equal(f.timers.size,0);});
test('late clipboard results cannot affect another route identity workspace or reply',async()=>{
 for(const change of [f=>f.state.routeVersion++,f=>f.state.workspaceId='other',f=>f.state.meta.tenant='other',f=>f.state.meta.principal='other',f=>f.state.detail.conversation.id='other',f=>f.turn().run_id='other',f=>f.turn().reply.content='new body']){
  for(const reject of [false,true]){const f=fixture(),d=deferred();f.write(()=>d.promise);const p=f.copy();change(f);f.status.textContent='new surface';if(reject)d.reject(Error('denied'));else d.resolve();await p;assert.equal(f.status.textContent,'new surface');assert.deepEqual(f.toasts,[]);assert(!f.nodes.has('task-reply-copy-text-1'));}
 }
});
test('stale or detached copy controls cannot copy the current task by turn number',async()=>{for(const mutate of [f=>f.button.isConnected=false,f=>f.button.dataset.copyRun='old-run',f=>f.button.dataset.copyScope='old-scope']){const f=fixture();mutate(f);await f.copy();assert.equal(f.copied.length,0);}});
test('page departure fences old work and clears busy controls without copying automatically',async()=>{const f=fixture(),old=deferred(),next=deferred();f.write(()=>old.promise);const p=f.copy();f.events.pagehide();assert(!f.button.attrs.has('aria-busy'));assert.equal(f.timers.size,0);f.write(()=>next.promise);const q=f.copy();old.resolve();await p;assert.equal(f.button.attrs.get('aria-busy'),'true');next.resolve();await q;assert.match(f.status.textContent,/已复制/);assert.equal(f.copied.length,2);});
test('fallback markup escapes raw HTML and does not put a reply in editable controls',async()=>{const f=fixture('</textarea><img src=x onerror=bad()>');f.write(async()=>{throw Error('denied');});await f.copy();const html=f.ctx.taskReplyCopyFeedback(f.turn(),f.state.detail.conversation);assert.match(html,/readonly/);assert.match(html,/&lt;\/textarea&gt;&lt;img/);assert(!html.includes('<img'));assert.match(html,/role="status"/);});
test('manual selection rejects a detached or differently scoped old control',async()=>{const f=fixture();f.write(async()=>{throw Error('denied');});await f.copy();const text=f.nodes.get('task-reply-copy-text-1'),elsewhere={};f.document.activeElement=elsewhere;f.ctx.selectTaskReplyText(1,{isConnected:false,dataset:{}});assert.equal(f.document.activeElement,elsewhere);f.ctx.selectTaskReplyText(1,{isConnected:true,dataset:{copyScope:'other',copyRun:'run-1'}});assert.equal(f.document.activeElement,elsewhere);f.ctx.selectTaskReplyText(1);assert.equal(f.document.activeElement,text);});
