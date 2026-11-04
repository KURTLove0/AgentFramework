'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const conversation=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/task_conversation.js'),'utf8');
const wrappers=conversation.slice(conversation.indexOf('function taskChatDraft('),conversation.indexOf('function chatMarkdown('));
const file=process.env.CHAT_DRAFT_SOURCE||path.join(__dirname,'../agent_framework/webui/chat_draft.js');
function shared(){const storage=new Map(),queues=new Map();return {storage,locks:{request(name,fn){const next=(queues.get(name)||Promise.resolve()).then(fn);queues.set(name,next.catch(()=>{}));return next;}}};}
function harness(common=shared(),session=new Map()){
 const fields=new Map(),listeners={},messages=[],faults={tab:false,tabRemove:false,shared:false,read:false};let serial=0;
 const field=id=>{if(!fields.has(id))fields.set(id,{value:'',textContent:'',innerHTML:'',hidden:false,open:false,disabled:false,dataset:{},focus(){},showModal(){this.open=true;},close(){this.open=false;},setAttribute(){},removeAttribute(){}});return fields.get(id);};
 const state={workspaceId:'space',meta:{tenant:'tenant',principal:'person'},routeVersion:1,detail:{run:{task:{principal:'person'}},conversation:{id:'task-one',can_reply:true}}},ui={drafts:new Map(),pending:new Map()};
 const scope=()=>[state.meta.tenant,state.workspaceId,state.meta.principal,state.detail.conversation.id].join(':');
 const ctx=vm.createContext({state,taskChatUI:ui,taskChatScope:scope,crypto:{randomUUID:()=>String(++serial)+'-'+Math.random()},navigator:{locks:common.locks,clipboard:{writeText:async text=>messages.push(text)}},
  localStorage:{getItem:k=>{if(faults.read)throw Error('read');return common.storage.get(k)??null;},setItem:(k,v)=>{if(faults.shared)throw Error('quota');common.storage.set(k,v);},removeItem:k=>common.storage.delete(k)},
  sessionStorage:{getItem:k=>session.get(k)??null,setItem:(k,v)=>{if(faults.tab)throw Error('quota');session.set(k,v);},removeItem:k=>{if(faults.tabRemove)throw Error('remove denied');session.delete(k);}},
  document:{getElementById:field,addEventListener:(type,fn)=>listeners[type]=fn},window:{addEventListener:(type,fn)=>listeners[type]=fn},esc:x=>String(x??''),render(){},toast:s=>messages.push(s),console});
 vm.runInContext(wrappers,ctx);if(fs.existsSync(file)){vm.runInContext(fs.readFileSync(file,'utf8'),ctx);ctx.chatDraftSharedKey=vm.runInContext('chatDraftSharedKey',ctx);ctx.chatDraftTabKey=vm.runInContext('chatDraftTabKey',ctx);}
 return {ctx,state,ui,scope,common,session,faults,fields,field,listeners,messages,read:()=>ctx.taskChatDraft(),save:async text=>{field('task-chat-input').value=text;await ctx.saveTaskChatDraft(text);},record:()=>ctx.readChatDraft(scope()),run:s=>vm.runInContext(s,ctx),reload:()=>harness(common,session)};
}
test('each tab restores its own edits after another tab changes the shared recovery copy',async()=>{
 const common=shared(),a=harness(common),b=harness(common);a.read();b.read();await a.save('甲页输入');await b.save('乙页输入');assert.equal(a.reload().read(),'甲页输入');assert.equal(b.reload().read(),'乙页输入');
});
test('clearing an accepted message cannot delete a later draft from another tab',async()=>{
 const a=harness();a.read();await a.save('已发送文字');const b=harness(a.common);b.read();await b.save('另一页的新要求');await a.save('');assert.equal(harness(a.common).read(),'另一页的新要求');assert.equal(a.reload().read(),'');
});
test('failed browser persistence retains input and exposes a recovery status',async()=>{
 const h=harness();h.read();h.faults.tab=h.faults.shared=true;await h.save('不可丢失的输入');assert.equal(h.read(),'不可丢失的输入');const status=h.run("typeof renderChatDraftNotice==='function'?renderChatDraftNotice():''");assert.match(status,/复制|无法保存/);
});
test('shared saves serialize concurrent tabs and preserve the losing tab copy',async()=>{
 const common=shared(),a=harness(common),b=harness(common);a.read();b.read();await Promise.all([a.save('甲'),b.save('乙')]);assert.equal(a.ctx.readSharedChatDraft(a.scope()).text,'甲');assert(b.record().conflict);assert.equal(b.reload().read(),'乙');
});
test('the tab recovery copy is durable before waiting for the shared write lock',async()=>{
 const h=harness();h.read();let release;const gate=new Promise(resolve=>release=resolve);const block=h.common.locks.request(h.ctx.chatDraftSharedKey(h.scope()),()=>gate);
 const pending=h.save('排队保存期间的输入');assert.equal(h.reload().read(),'排队保存期间的输入');release();await block;await pending;assert(h.record().sharedSaved);
});
test('queued persistence coalesces later edits and cannot resurrect a cleared input',async()=>{
 const h=harness();h.read();let release;const gate=new Promise(resolve=>release=resolve);const block=h.common.locks.request(h.ctx.chatDraftSharedKey(h.scope()),()=>gate);
 const first=h.save('先输入'),last=h.save('');release();await block;await Promise.all([first,last]);assert.equal(h.ctx.readSharedChatDraft(h.scope()).text,'');assert.equal(h.reload().read(),'');
});
test('an unchanged owned draft is cleared with a tombstone that prevents legacy resurrection',async()=>{
 const h=harness();const legacy='task-chat-draft:'+h.scope();h.common.storage.set(legacy,'旧格式内容');assert.equal(h.read(),'旧格式内容');await h.save('');assert.equal(h.common.storage.get(legacy),'旧格式内容');assert.equal(harness(h.common).read(),'');
});
test('legacy JSON-looking user text remains literal and migration requires an edit',async()=>{
 const h=harness(),text='{"v":1,"text":"这是消息正文"}';h.common.storage.set('task-chat-draft:'+h.scope(),text);assert.equal(h.read(),text);assert(!h.common.storage.has(h.ctx.chatDraftSharedKey(h.scope())));await h.save(text+'补充');assert.equal(harness(h.common).read(),text+'补充');
});
test('explicit review can save the displayed local draft without sending a message',async()=>{
 const a=harness(),b=harness(a.common);a.read();b.read();await b.save('共享内容');await a.save('本页内容');a.ctx.reviewChatDraft();assert.equal(a.field('chat-draft-local').value,'本页内容');assert.equal(a.field('chat-draft-remote').value,'共享内容');await a.ctx.saveReviewedChatDraft();assert.equal(a.ctx.readSharedChatDraft(a.scope()).text,'本页内容');assert(!a.field('chat-draft-dialog').open);assert.equal(a.record().conflict,false);
});
test('another write after review cannot be overwritten without reviewing again',async()=>{
 const a=harness(),b=harness(a.common);a.read();b.read();await b.save('共享一');await a.save('本页');a.ctx.reviewChatDraft();await b.save('共享二');await a.ctx.saveReviewedChatDraft();assert.equal(a.ctx.readSharedChatDraft(a.scope()).text,'共享二');assert.equal(a.read(),'本页');assert.match(a.field('chat-draft-review-error').textContent,/又有更新/);assert(a.field('chat-draft-dialog').open);
});
test('later local edits invalidate a frozen review',async()=>{
 const a=harness(),b=harness(a.common);a.read();b.read();await b.save('共享');await a.save('本页一');a.ctx.reviewChatDraft();await a.save('本页二');await a.ctx.saveReviewedChatDraft();assert.equal(a.ctx.readSharedChatDraft(a.scope()).text,'共享');assert.equal(a.read(),'本页二');assert.match(a.field('chat-draft-review-error').textContent,/本页输入已变化/);
});
test('adopting the displayed shared draft updates only this tab and retains the shared stamp',async()=>{
 const a=harness(),b=harness(a.common);a.read();b.read();await b.save('采用的内容');await a.save('本页');a.ctx.reviewChatDraft();const raw=a.common.storage.get(a.ctx.chatDraftSharedKey(a.scope()));a.ctx.adoptReviewedChatDraft();assert.equal(a.read(),'采用的内容');assert.equal(a.reload().read(),'采用的内容');assert.equal(a.common.storage.get(a.ctx.chatDraftSharedKey(a.scope())),raw);
});
test('adoption refuses a shared draft changed since review',async()=>{
 const a=harness(),b=harness(a.common);a.read();b.read();await b.save('共享一');await a.save('本页');a.ctx.reviewChatDraft();await b.save('共享二');a.ctx.adoptReviewedChatDraft();assert.equal(a.read(),'本页');assert.match(a.field('chat-draft-review-error').textContent,/又有更新/);
});
test('late reviewed saves cannot mutate a new scope or unlock its dialog',async()=>{
 const h=harness();h.read();await h.save('原任务');h.ctx.reviewChatDraft();let release;const gate=new Promise(resolve=>release=resolve),oldScope=h.scope();const block=h.common.locks.request(h.ctx.chatDraftSharedKey(oldScope),()=>gate);const save=h.ctx.saveReviewedChatDraft();h.state.detail.conversation.id='task-two';h.read();h.ctx.reviewChatDraft();h.field('chat-draft-save').disabled=true;release();await block;await save;assert(h.field('chat-draft-save').disabled);assert(h.field('chat-draft-dialog').open);assert.equal(h.ctx.readSharedChatDraft(oldScope).text,'原任务');
});
test('missing cross-tab locks preserves a tab copy without risking a shared overwrite',async()=>{
 const h=harness();h.read();h.ctx.navigator.locks=undefined;await h.save('仅标签页');assert.equal(h.reload().read(),'仅标签页');assert.equal(h.ctx.readSharedChatDraft(h.scope()).text,'');assert(h.record().localError);
});
test('local storage failure can recover by retrying the unchanged original base',async()=>{
 const h=harness();h.read();h.faults.shared=true;await h.save('待保存');assert(!h.record().sharedSaved);h.faults.shared=false;await h.ctx.publishChatDraft(h.record());assert(h.record().sharedSaved);assert.equal(harness(h.common).read(),'待保存');assert.equal(h.record().localError,null);
});
test('restoring an unpublished tab copy offers retry instead of claiming shared persistence',async()=>{
 const h=harness();h.read();h.faults.shared=true;await h.save('仅标签页保存');const restored=h.reload();assert.equal(restored.read(),'仅标签页保存');assert(!restored.record().sharedSaved);assert.match(restored.ctx.renderChatDraftNotice(),/尚未保存到共享副本/);assert.match(restored.ctx.renderChatDraftNotice(),/data-chat-draft-retry/);await restored.ctx.publishChatDraft(restored.record());assert(restored.record().sharedSaved);
});
test('tab storage failure still permits shared persistence and reports the partial failure',async()=>{
 const h=harness();h.read();h.faults.tab=true;await h.save('共享副本');assert(h.record().sharedSaved);assert(!h.record().tabSaved);assert.match(h.ctx.renderChatDraftNotice(),/标签页副本暂不可用/);assert.equal(harness(h.common).read(),'共享副本');
});
test('corrupt shared records are retained and cannot be silently overwritten',async()=>{
 const h=harness(),key=h.ctx.chatDraftSharedKey(h.scope());h.common.storage.set(key,'{broken');h.read();await h.save('本页输入');assert.equal(h.common.storage.get(key),'{broken');assert.equal(h.reload().read(),'本页输入');assert(h.record().localError);
});
test('foreign tab records cannot populate another task',()=>{
 const h=harness();h.session.set(h.ctx.chatDraftTabKey(h.scope()),JSON.stringify({v:1,scope:'foreign',text:'另一人的文字',base:null}));assert.equal(h.read(),'');
});
test('storage notifications preserve text and only affect the matching scope',async()=>{
 const a=harness();a.read();await a.save('本页');const b=harness(a.common);b.read();await b.save('新共享');a.listeners.storage({key:'unrelated'});assert.equal(a.record().conflict,false);a.listeners.storage({key:a.ctx.chatDraftSharedKey(a.scope())});assert.equal(a.read(),'本页');assert(a.record().conflict);assert.equal(a.reload().read(),'本页');
});
test('leave protection applies only while nonempty input lacks a current shared copy',async()=>{
 const h=harness();h.read();let blocked=0;const event={preventDefault:()=>blocked++};await h.save('已存');h.listeners.beforeunload(event);assert.equal(blocked,0);h.faults.shared=true;await h.save('未存');h.listeners.beforeunload(event);assert.equal(blocked,1);await h.save('');h.listeners.beforeunload(event);assert.equal(blocked,1);
});
test('copying a draft is read-only and uses the current tab input',async()=>{
 const h=harness();h.read();await h.save('本页备份');const raw=h.common.storage.get(h.ctx.chatDraftSharedKey(h.scope()));await h.ctx.copyChatDraft();assert.equal(h.messages[0],'本页备份');assert.equal(h.common.storage.get(h.ctx.chatDraftSharedKey(h.scope())),raw);
});
test('changing the signed-in actor isolates drafts even while old task details remain visible',async()=>{
 const h=harness();h.read();await h.save('原用户草稿');
 vm.runInContext(conversation.slice(conversation.indexOf('function taskChatScope('),conversation.indexOf('function taskChatDraft(')),h.ctx);
 h.state.meta.principal='new-person';assert.equal(h.ctx.taskChatDraft(),'');
});
test('a conflict plus failed tab storage clearly warns that the current page must stay open',async()=>{
 const a=harness(),b=harness(a.common);a.read();b.read();await b.save('共享');a.faults.tab=true;await a.save('本页');assert.match(a.ctx.renderChatDraftNotice(),/无法保存本页副本/);
});
function inputEvents(h){
 const helper=conversation.indexOf('function taskChatInputScope('),start=helper<0?conversation.indexOf("document.addEventListener('input'"):helper;
 h.ctx.document.querySelector=()=>h.field('submit');vm.runInContext(conversation.slice(start,conversation.indexOf("document.addEventListener('keydown'")),h.ctx);
 return {id:'task-chat-input',value:'旧任务正在输入',dataset:{chatDraftScope:h.scope()},style:{},scrollHeight:64,removeAttribute(){}};
}
test('late input from an old composer is saved under its rendered scope',async()=>{
 const h=harness();h.read();const old=h.scope(),input=inputEvents(h);h.state.detail.conversation.id='task-two';h.listeners.input({target:input});await new Promise(resolve=>setImmediate(resolve));assert.equal(h.ctx.taskChatDraft(old),'旧任务正在输入');assert.equal(h.read(),'');
});
test('a late composition end cannot clear a newer IME session or move old text to its task',async()=>{
 const h=harness();h.read();const old=h.scope(),input=inputEvents(h);h.listeners.compositionstart({target:input});h.state.detail.conversation.id='task-two';const next={...input,value:'新任务输入',dataset:{chatDraftScope:h.scope()}};h.listeners.compositionstart({target:next});h.listeners.compositionend({target:input});await new Promise(resolve=>setImmediate(resolve));assert(h.ui.composing);assert.equal(h.ctx.taskChatDraft(old),'旧任务正在输入');assert.equal(h.read(),'');
});
test('navigation captures the rendered composer before releasing its composition state',async()=>{
 const h=harness();h.read();inputEvents(h);const input=h.field('task-chat-input');input.id='task-chat-input';input.dataset.chatDraftScope=h.scope();input.value='尚未派发 input 的组合文字';h.listeners.compositionstart({target:input});h.ctx.leaveTaskChatComposer();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.read(),'尚未派发 input 的组合文字');assert.equal(h.ui.composing,false);assert.equal(h.ui.compositionInput,null);
});
function globalComposition(){
 const app=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/app.js'),'utf8'),listeners={},queued=[],state={};let renders=0;
 const ctx=vm.createContext({state,document:{addEventListener:(name,fn)=>listeners[name]=fn},queueMicrotask:fn=>queued.push(fn),render:()=>renders++});
 vm.runInContext(app.slice(app.lastIndexOf("document.addEventListener('compositionstart'")),ctx);return {state,listeners,queued,renders:()=>renders};
}
test('global composition ownership ignores an old editor ending after a new one starts',()=>{
 const h=globalComposition(),old={id:'old'},next={id:'new'};h.listeners.compositionstart({target:old});h.listeners.compositionstart({target:next});h.listeners.compositionend({target:old});assert(h.state.composing);assert.equal(h.state.compositionTarget,next);assert.equal(h.queued.length,0);
});
test('a queued composition-end render does not interrupt another composition started meanwhile',()=>{
 const h=globalComposition(),old={id:'old'},next={id:'new'};h.listeners.compositionstart({target:old});h.listeners.compositionend({target:old});h.listeners.compositionstart({target:next});h.queued.forEach(fn=>fn());assert(h.state.composing);assert.equal(h.renders(),0);
});

test('a shared save with failed tab storage refreshes the current tab from the new shared copy',async()=>{
 const h=harness();h.read();await h.save('较早的输入');h.faults.tab=true;await h.save('需要恢复的新输入');
 assert(h.record().sharedSaved);assert(!h.record().tabSaved);assert.equal(h.reload().read(),'需要恢复的新输入');assert.match(h.ctx.renderChatDraftNotice(),/刷新将读取共享草稿/);
});
test('clearing sent text with a failed tab write cannot restore the old sent text on refresh',async()=>{
 const h=harness();h.read();await h.save('已经发送的输入');h.faults.tab=true;await h.save('');
 assert.equal(h.ctx.readSharedChatDraft(h.scope()).text,'');assert.equal(h.reload().read(),'');
});
test('failed shared and tab writes retain the previous recovery copy and current in-memory input',async()=>{
 const h=harness();h.read();await h.save('仍可恢复的旧输入');const raw=h.session.get(h.ctx.chatDraftTabKey(h.scope()));
 h.faults.tab=h.faults.shared=true;await h.save('本页尚未存下的新输入');assert.equal(h.read(),'本页尚未存下的新输入');assert.equal(h.session.get(h.ctx.chatDraftTabKey(h.scope())),raw);assert(!h.record().sharedSaved);
});
test('a conflicting shared copy never authorizes deletion of this tab recovery copy',async()=>{
 const h=harness();h.read();await h.save('本页先前的输入');const raw=h.session.get(h.ctx.chatDraftTabKey(h.scope()));const other=harness(h.common);other.read();await other.save('另一页的输入');
 h.faults.tab=true;await h.save('本页继续编辑');assert.equal(h.session.get(h.ctx.chatDraftTabKey(h.scope())),raw);assert(h.record().conflict);assert.equal(h.read(),'本页继续编辑');
});
test('failed stale-tab cleanup reports refresh risk and protects even an empty sent-message draft',async()=>{
 const h=harness();h.read();await h.save('已经发送的输入');h.faults.tab=h.faults.tabRemove=true;await h.save('');
 assert(h.record().sharedSaved);assert.equal(h.read(),'');assert.match(h.ctx.renderChatDraftNotice(),/刷新可能恢复旧输入/);let blocked=0;h.listeners.beforeunload({preventDefault:()=>blocked++});assert.equal(blocked,1);
 h.faults.tab=h.faults.tabRemove=false;h.ctx.persistChatDraftTab(h.record());assert.equal(h.reload().read(),'');h.listeners.beforeunload({preventDefault:()=>blocked++});assert.equal(blocked,1);assert.doesNotMatch(h.ctx.renderChatDraftNotice(),/刷新可能恢复旧输入/);
});
test('adopting shared text with failed tab storage cannot restore the replaced local text',async()=>{
 const h=harness();h.read();await h.save('本页旧输入');const other=harness(h.common);other.read();await other.save('已核对的共享输入');h.ctx.reviewChatDraft();h.faults.tab=true;h.ctx.adoptReviewedChatDraft();
 assert.equal(h.read(),'已核对的共享输入');assert.equal(h.reload().read(),'已核对的共享输入');
});
test('stale shared-saved state cannot authorize removal after a different page has updated shared text',async()=>{
 const h=harness();h.read();await h.save('本页独立输入');const raw=h.session.get(h.ctx.chatDraftTabKey(h.scope()));const other=harness(h.common);other.read();await other.save('另一页刚更新的输入');
 h.faults.tab=true;h.ctx.persistChatDraftTab(h.record());assert.equal(h.session.get(h.ctx.chatDraftTabKey(h.scope())),raw);assert(!h.record().sharedSaved);assert(h.record().conflict);
});
test('unreadable shared storage cannot authorize removal of the current tab recovery copy',async()=>{
 const h=harness();h.read();await h.save('本页可恢复输入');const raw=h.session.get(h.ctx.chatDraftTabKey(h.scope()));h.faults.tab=h.faults.read=true;h.ctx.persistChatDraftTab(h.record());
 assert.equal(h.session.get(h.ctx.chatDraftTabKey(h.scope())),raw);assert(!h.record().sharedSaved);assert(h.record().localError);
});
