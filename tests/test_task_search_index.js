'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture({observer=true}={}){
 let scope='scope',walks=0,ranges=0,reads=0;const observers=[],nodes=new Map(),bodies=[],controls=[];
 class Observer{constructor(callback){this.callback=callback;this.records=[];observers.push(this);}observe(root){this.root=root;this.connected=true;}disconnect(){this.connected=false;this.records=[];}takeRecords(){const r=this.records;this.records=[];return r;}}
 const classes=names=>({contains:n=>names.includes(n),add(){},remove(){}}),list={dataset:{chatScope:scope,chatSignature:'fixture'},contains:el=>bodies.includes(el),querySelectorAll:()=>bodies.map(body=>({dataset:{chatTurn:body.turn},querySelectorAll:()=>[body]})),getBoundingClientRect:()=>({top:0}),clientHeight:400,scrollTop:0};
 nodes.set('task-message-list',list);nodes.set('task-search-status',{textContent:''});nodes.set('task-search-input',{value:''});
 const doc={getElementById:id=>nodes.get(id),querySelectorAll:()=>[],addEventListener(){},createTreeWalker:body=>{walks++;let i=0;return {nextNode:()=>body.nodes[i++]||null};},createRange:()=>{ranges++;return {setStart(node,offset){this.startContainer=node;this.startOffset=offset;},setEnd(node,offset){this.endContainer=node;this.endOffset=offset;},getClientRects:()=>[{top:0}],toString(){return this.startContainer.textContent.slice(this.startOffset,this.endOffset);}};}};
 const c=vm.createContext({document:doc,NodeFilter:{SHOW_TEXT:4},taskChatScope:()=>scope,taskChatUI:{scroll:new Map()},setTimeout,clearTimeout,Date,...(observer?{MutationObserver:Observer}:{})});
 vm.runInContext(fs.readFileSync(process.env.TASK_SEARCH_LEGACY||path.join(__dirname,'../agent_framework/webui/task_search.js'),'utf8'),c);
 function add(text,turn=String(bodies.length+1),ignored=false){
  const body={turn,nodeType:1,classList:classes(['task-chat-answer']),nodes:[],matches:s=>s.includes('.task-chat-answer'),contains:el=>body.nodes.includes(el),closest:s=>s.includes('.task-chat-answer')?body:null,querySelectorAll:()=>[]};
  const parent={nodeType:1,closest:s=>s.includes('button')&&ignored?parent:s.includes('.task-chat-answer')?body:null,matches:s=>s.includes('button')&&ignored,contains:()=>false};
  const node={nodeType:3,parentElement:parent};Object.defineProperty(node,'textContent',{get(){reads++;return text;},set(value){text=value;},configurable:true});body.nodes.push(node);bodies.push(body);return {body,node,parent};
 }
 const h=c.taskSearchState();h.open=true;const f={c,h,list,nodes,bodies,observers,add,counts:()=>({walks,ranges,reads}),query(q){h.query=q;c.refreshTaskSearch({adopt:true});},change(item,value,notify=false){item.node.textContent=value;const record={type:'characterData',target:item.node};for(const o of observers)if(o.connected){if(notify)o.callback([record]);else o.records.push(record);}},mutate(record){for(const o of observers)if(o.connected)o.records.push(record);},scope(value){scope=value;list.dataset.chatScope=value;},text:()=>Array.from(h.matches,m=>m.range.toString())};
 return f;
}
test('repeated navigation reuses unchanged text and range objects',()=>{
 const f=fixture();f.add('needle first');f.add('needle second');f.query('needle');const before=f.counts(),ranges=[...f.h.matches.map(m=>m.range)];for(let i=0;i<20;i++)f.c.moveTaskSearch(1);assert.deepEqual(f.counts(),before);assert.deepEqual(Array.from(f.h.matches,m=>m.range),ranges);
});
test('new queries reuse the text index while returning exact new matches',()=>{const f=fixture();f.add('first needle second');f.query('needle');const before=f.counts().walks;f.query('second');assert.equal(f.counts().walks,before);assert.deepEqual(f.text(),['second']);});
test('same-tick text mutations refresh only the changed message without moving the selected match',()=>{
 const f=fixture(),a=f.add('needle first'),b=f.add('needle second');f.query('needle');const old=f.h.matches[0].range,key=f.h.selected,before=f.counts();f.change(b,'needle needle new');f.c.refreshTaskSearch();assert.equal(f.h.matches.length,3);assert.equal(f.h.matches[0].range,old);assert.equal(f.h.selected,key);assert.equal(f.counts().walks,before.walks+1);assert.equal(f.list.scrollTop,0);
});
test('observer-delivered mutations cannot leave stale matches',()=>{const f=fixture(),a=f.add('old phrase');f.query('old');f.change(a,'new phrase',true);f.c.refreshTaskSearch();assert.equal(f.h.matches.length,0);f.query('new');assert.deepEqual(f.text(),['new']);});
test('copy recovery buttons never become searchable message text or invalidate existing results',()=>{
 const f=fixture();f.add('needle');const button=f.add('全选代码','2',true);f.query('全选代码');assert.equal(f.h.matches.length,0);f.query('needle');const before=f.counts();f.change(button,'重试复制');f.c.refreshTaskSearch();assert.deepEqual(f.counts(),before);assert.deepEqual(f.text(),['needle']);
});
test('literal control labels in actual message text remain searchable',()=>{const f=fixture();f.add('原文提到了全选代码。');f.add('全选代码','2',true);f.query('全选代码');assert.equal(f.h.matches.length,1);assert.equal(f.h.matches[0].turn,'1');assert.deepEqual(f.text(),['全选代码']);});
test('new or removed message bodies rebuild ordering and release removed matches',()=>{
 const f=fixture(),a=f.add('needle one');f.query('needle');const b=f.add('needle two');f.mutate({type:'childList',target:f.list,addedNodes:[b.body],removedNodes:[]});f.c.refreshTaskSearch();assert.equal(f.h.matches.length,2);f.bodies.splice(0,1);f.mutate({type:'childList',target:f.list,addedNodes:[],removedNodes:[a.body]});f.c.refreshTaskSearch();assert.equal(f.h.matches.length,1);assert.equal(f.h.matches[0].body,b.body);
});
test('hidden source changes invalidate its text index while hidden controls do not',()=>{
 const f=fixture(),a=f.add('needle');f.query('needle');const before=f.counts().walks;f.mutate({type:'attributes',attributeName:'hidden',target:a.body});f.c.refreshTaskSearch();assert.equal(f.counts().walks,before+1);const button=f.add('全选代码','2',true);f.mutate({type:'attributes',attributeName:'hidden',target:button.parent});const count=f.counts().walks;f.c.refreshTaskSearch();assert.equal(f.counts().walks,count);
});
test('exactly 500 results are not capped unless a later message has another match',()=>{
 const f=fixture(),a=f.add('x'.repeat(500)),b=f.add('none');f.query('x');assert.equal(f.h.matches.length,500);assert.equal(f.h.capped,false);f.change(b,'x');f.c.refreshTaskSearch();assert.equal(f.h.matches.length,500);assert.equal(f.h.capped,true);f.change(a,'x'.repeat(499));f.c.refreshTaskSearch();assert.equal(f.h.matches.length,500);assert.equal(f.h.capped,false);
});
test('leaving disconnects observation and releases DOM indexes but preserves query preference',()=>{
 const f=fixture();f.add('needle');f.query('needle');assert.equal(f.observers.filter(o=>o.connected).length,1);f.c.leaveTaskSearch();assert.equal(f.observers.filter(o=>o.connected).length,0);assert.equal(f.h.matches.length,0);assert.equal(f.h.indexRoot,null);assert.equal(f.h.textIndex,null);assert.equal(f.h.query,'needle');
});
test('replaced root attaches a new observer and cannot reuse the former DOM ranges',()=>{
 const f=fixture(),a=f.add('needle');f.query('needle');const prior=f.h.matches[0].range,next={...f.list};f.nodes.set('task-message-list',next);f.c.refreshTaskSearch();assert.notEqual(f.h.matches[0].range,prior);assert.equal(f.observers.filter(o=>o.connected).length,1);assert.equal(f.observers.at(-1).root,next);
});
test('without mutation observation search remains correct through an uncached fallback',()=>{const f=fixture({observer:false}),a=f.add('old');f.query('old');f.change(a,'new');f.c.refreshTaskSearch();assert.equal(f.h.matches.length,0);f.query('new');assert.deepEqual(f.text(),['new']);});
