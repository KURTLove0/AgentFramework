'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../agent_framework/webui/task_conversation.js'),'utf8');
function fixture(initialHidden=false){
 const sources=[],timers=new Map(),events={},calls=[],clock={now:10000,next:0};
 const state={workspaceId:'workspace',meta:{tenant:'tenant',principal:'person'},detail:{conversation:{id:'task',revision:1,updated_at:1,active:true,can_reply:true,resumable:false,status:'RUNNING',queued_count:0,active_run_id:'task',turns:[{number:1,run_id:'task',status:'RUNNING',progress:[]}] }},composing:true};
 class EventSource{static OPEN=1;constructor(url){this.url=url;this.readyState=1;this.handlers={};sources.push(this);}addEventListener(type,fn){this.handlers[type]=fn;}close(){this.readyState=2;}}
 const listen=(type,fn)=>{(events[type]??=[]).push(fn);};
 const document={hidden:initialHidden,getElementById:()=>null,addEventListener:listen};
 const context=vm.createContext({state,document,window:{addEventListener:listen},EventSource,Date:{now:()=>clock.now},performance:{now:()=>clock.now},Math:Object.assign(Object.create(Math),{random:()=>0}),refresh:()=>calls.push('refresh'),render:()=>calls.push('render'),setTimeout:(fn,delay)=>{const id=++clock.next;timers.set(id,{fn,at:clock.now+delay});return id;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(source.slice(0,source.indexOf('function taskChatScope(')),context);
 const fire=type=>(events[type]||[]).forEach(fn=>fn({type}));
 const advance=ms=>{clock.now+=ms;for(const [id,timer] of [...timers])if(timer.at<=clock.now){timers.delete(id);timer.fn();}};
 context.syncTaskConversationStream();return {context,state,document,sources,timers,calls,clock,fire,advance};
}

test('hidden tabs release their stream and reopen only when visible',()=>{
 const h=fixture(),first=h.sources[0];h.document.hidden=true;h.fire('visibilitychange');
 assert.equal(first.readyState,2);h.context.syncTaskConversationStream();assert.equal(h.sources.length,1);
 h.document.hidden=false;h.fire('visibilitychange');assert.equal(h.sources.length,2);assert.deepEqual(h.calls,['refresh']);
});
test('stream errors close native retries and do not reopen on every render',()=>{
 const h=fixture(),first=h.sources[0];assert.equal(typeof first.handlers.error,'function');first.handlers.error({});
 assert.equal(first.readyState,2);assert.equal(h.context.isTaskChatStreaming(),false);
 for(let i=0;i<20;i++)h.context.syncTaskConversationStream();assert.equal(h.sources.length,1);
 h.advance(1000);assert.equal(h.sources.length,2);
});
test('consecutive failures back off to a bounded interval and a valid snapshot resets it',()=>{
 const h=fixture();
 for(const delay of [1000,2000,4000,8000,16000,30000,30000]){
  const count=h.sources.length;h.sources.at(-1).handlers.error({});h.advance(delay-1);assert.equal(h.sources.length,count);h.advance(1);assert.equal(h.sources.length,count+1);
 }
 h.sources.at(-1).handlers.conversation({data:JSON.stringify(h.state.detail.conversation)});
 const count=h.sources.length;h.sources.at(-1).handlers.error({});h.advance(1000);assert.equal(h.sources.length,count+1);
});
test('opening a connection or receiving malformed snapshots does not reset failure backoff',()=>{
 const h=fixture();h.sources[0].handlers.error({});h.advance(1000);const second=h.sources[1];
 second.handlers.conversation({data:'not json'});second.handlers.error({});h.advance(1000);assert.equal(h.sources.length,2);h.advance(1000);assert.equal(h.sources.length,3);
});
test('changing the task or actor abandons the old retry without postponing the new stream',()=>{
 for(const change of [h=>{h.state.detail.conversation.id='new';h.state.detail.conversation.active_run_id='new';h.state.detail.conversation.turns[0].run_id='new';},h=>h.state.meta.principal='other']){
  const h=fixture(),first=h.sources[0];first.handlers.error({});change(h);h.context.syncTaskConversationStream();
  assert.equal(h.sources.length,2);assert.equal(h.timers.size,0);first.handlers.error({});h.advance(50000);assert.equal(h.sources.length,2);assert.equal(h.sources[1].readyState,1);
 }
});
test('hidden pages cancel retry timers and respect backoff when shown again',()=>{
 const h=fixture();h.sources[0].handlers.error({});h.document.hidden=true;h.fire('visibilitychange');assert.equal(h.timers.size,0);
 h.advance(500);h.document.hidden=false;h.fire('visibilitychange');assert.equal(h.sources.length,1);h.advance(500);assert.equal(h.sources.length,2);
 h.document.hidden=true;h.fire('visibilitychange');h.advance(50000);assert.equal(h.sources.length,2);
});
test('page cache restore resumes polling and one stream without replaying a message',()=>{
 const h=fixture(),first=h.sources[0];h.fire('pagehide');assert.equal(first.readyState,2);
 h.context.syncTaskConversationStream();assert.equal(h.sources.length,1);h.fire('pageshow');assert.equal(h.sources.length,2);assert.deepEqual(h.calls,['refresh']);
 h.fire('pageshow');assert.equal(h.sources.length,2);assert.deepEqual(h.calls,['refresh']);
});
test('completion during backoff prevents reopening a finished conversation',()=>{
 const h=fixture();h.sources[0].handlers.error({});h.state.detail.conversation.active=false;h.advance(1000);
 assert.equal(h.sources.length,1);assert.equal(h.timers.size,0);assert.equal(h.context.isTaskChatStreaming(),false);
});
test('explicit close cancels pending retries and late source events cannot revive them',()=>{
 const h=fixture(),source=h.sources[0];source.handlers.error({});h.context.closeTaskChatStream();h.advance(10000);
 source.handlers.error({});source.handlers.settled({});assert.equal(h.sources.length,1);assert.equal(h.timers.size,0);assert.deepEqual(h.calls,[]);
});
test('a page that starts hidden does not allocate a stream on render',()=>{
 const h=fixture(true);assert.equal(h.sources.length,0);
 for(let i=0;i<10;i++)h.context.syncTaskConversationStream();assert.equal(h.sources.length,0);
 h.document.hidden=false;h.fire('visibilitychange');assert.equal(h.sources.length,1);
});
test('changing the wall clock cannot extend or skip the retry delay',()=>{
 const h=fixture();h.sources[0].handlers.error({});h.context.Date.now=()=>-100000000;
 h.advance(999);assert.equal(h.sources.length,1);h.advance(1);assert.equal(h.sources.length,2);
 h.sources[1].handlers.error({});h.context.Date.now=()=>900000000;
 h.context.syncTaskConversationStream();assert.equal(h.sources.length,2);h.advance(2000);assert.equal(h.sources.length,3);
});
