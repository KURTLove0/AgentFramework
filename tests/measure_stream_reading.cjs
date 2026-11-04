'use strict';
// Synthetic 160-turn stream; no network, persisted data or model execution.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{chromium}=require('playwright');
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];},output=option('--output');
if(!output)throw Error('Provide --output; existing evidence is never overwritten.');
const sources={markdown:path.resolve(option('--markdown-source')||'agent_framework/webui/reply_markdown.js'),conversation:path.resolve(option('--conversation-source')||'agent_framework/webui/task_conversation.js')};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),samples=[],errors=[];
 try{
  for(let sample=0;sample<3;sample++){
   const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
   await page.setContent('<style>#task-message-list{height:700px;overflow:auto}p{margin:4px}pre{overflow:auto;max-width:500px}</style><article data-conversation-id="task"><div id="task-message-list" data-chat-scope="tenant:workspace:person:task"></div></article><input id="draft">');
   await page.evaluate(()=>{
    window.esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));window.refresh=()=>{};window.render=()=>{throw Error('Unexpected full render');};
    window.streamSources=[];window.EventSource=class {static OPEN=1;constructor(){this.readyState=1;this.handlers={};streamSources.push(this);}addEventListener(type,fn){this.handlers[type]=fn;}close(){this.readyState=2;}};
    window.state={workspaceId:'workspace',meta:{tenant:'tenant',principal:'person'},routeVersion:1,detail:{conversation:{id:'task',revision:1,updated_at:1,active:true,can_reply:true,resumable:false,status:'RUNNING',queued_count:0,active_run_id:'run-160',current:{job:{active:true}},turns:[]}}};
   });
   await page.addScriptTag({path:path.resolve('agent_framework/webui/markdown-it-15.0.3.min.js')});for(const source of Object.values(sources))await page.addScriptTag({path:source});
   const result=await page.evaluate(()=>{
    const list=document.getElementById('task-message-list'),c=state.detail.conversation,content=Array.from({length:12},(_,i)=>'稳定的第 '+i+' 段正文。').join('\n\n')+'\n\n```js\n  const stable = 1;\n```\n\n| 一 | 二 |\n|---|---|\n|a|b|\n\n正在生成';
    for(let n=1;n<=160;n++){
     const active=n===160,turn={number:n,run_id:'run-'+n,status:active?'RUNNING':'SUCCEEDED',progress:[],reply:active?null:{content},preview:active?{seq:1,content}:null};c.turns.push(turn);
     const section=document.createElement('section');section.dataset.chatTurn=n;section.innerHTML=active?'<section data-chat-preview><div class="task-chat-answer" data-chat-preview-body>'+renderReplyMarkdown(content)+'</div></section>':'<div class="task-chat-answer">'+renderReplyMarkdown(content)+'</div>';list.append(section);
    }
    list.dataset.chatStructure=taskChatStructure(c);list.dataset.chatSignature=taskChatSignature(c);restoreTaskConversationUI();
    const counts={captures:0,restores:0,parses:0},capture=captureReplyReading,restore=restoreReplyReading,parse=renderReplyMarkdown;
    captureReplyReading=(...args)=>{counts.captures++;return capture(...args);};restoreReplyReading=(...args)=>{counts.restores++;return restore(...args);};renderReplyMarkdown=(...args)=>{counts.parses++;return parse(...args);};
    const history=list.firstChild,selection=history.querySelector('p').firstChild;getSelection().setBaseAndExtent(selection,2,selection,6);
    const draft=document.getElementById('draft');draft.value='独立草稿';syncTaskConversationStream();const source=streamSources.at(-1);
    const measure=fn=>{const before={...counts},start=performance.now();fn();return {milliseconds:performance.now()-start,...Object.fromEntries(Object.keys(counts).map(k=>[k,counts[k]-before[k]]))};};
    const push=(n,text)=>{const next=structuredClone(state.detail.conversation);next.updated_at++;const last=next.turns.at(-1);last.preview={seq:n,content:text};last.progress=[{id:n,kind:'status',text:'运行进度 '+n}];source.handlers.conversation({data:JSON.stringify(next)});};
    const progress=measure(()=>{for(let n=2;n<=21;n++)push(n,content);});
    const text=measure(()=>{for(let n=22;n<=41;n++)push(n,content+' 新增文字 '+n);});
    const preserved=list.firstChild===history&&getSelection().anchorNode===selection&&getSelection().focusNode===selection&&getSelection().anchorOffset===2&&getSelection().focusOffset===6&&draft.value==='独立草稿';
    closeTaskChatStream();return {progress,text,preserved,finalText:document.querySelector('[data-chat-preview-body]').textContent.includes('新增文字 41')};
   });
   assert(result.preserved&&result.finalText);if(args.includes('--expect-local')){assert.equal(result.progress.captures,0);assert.equal(result.progress.restores,0);assert.equal(result.progress.parses,0);assert.equal(result.text.captures,20);assert.equal(result.text.restores,20);assert.equal(result.text.parses,20);}
   samples.push(result);await page.close();
  }
  assert.deepEqual(errors,[]);const report={sources:Object.fromEntries(Object.entries(sources).map(([name,p])=>[name,{path:p,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}])),turns:160,progress_updates:20,text_updates:20,samples,errors,realModelCalls:0};fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,samples},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
