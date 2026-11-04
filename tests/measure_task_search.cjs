'use strict';
// Synthetic DOM benchmark, isolated from application data and model execution.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{chromium}=require('playwright');
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];},sourcePath=path.resolve(option('--source')||'agent_framework/webui/task_search.js'),output=option('--output');
if(!output)throw Error('Provide --output; existing evidence is never overwritten.');
const source=fs.readFileSync(sourcePath,'utf8');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),samples=[],errors=[];
 try{
  for(let i=0;i<3;i++){
   const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
   await page.setContent('<style>#task-message-list{height:700px;overflow:auto}p{margin:4px}button{font-size:14px}</style><input id="task-search-input"><p id="task-search-status"></p><div id="task-message-list" data-chat-scope="measure"></div>');
   await page.evaluate(()=>{window.taskChatScope=()=> 'measure';window.taskChatUI={scroll:new Map()};const list=document.getElementById('task-message-list');for(let n=1;n<=160;n++){
    const turn=document.createElement('section');turn.dataset.chatTurn=n;const user=document.createElement('div');user.className='task-user-content';user.textContent='第 '+n+' 轮要求';const reply=document.createElement('div');reply.className='task-chat-answer';
    for(let p=0;p<80;p++){const text=document.createElement('p');text.textContent='历史正文和上下文保持完整。'.repeat(6);reply.append(text);}
    const end=document.createElement('p');end.textContent='needle 备用关键字 '+n;reply.append(end);const manual=document.createElement('button');manual.textContent='全选代码';manual.dataset.replySelectCode='';reply.append(manual);turn.append(user,reply);list.append(turn);
   }});
   await page.addScriptTag({content:source});
   const sample=await page.evaluate(()=>{
    const counts={walks:0,ranges:0,scans:0,characters:0},originalText=taskSearchText,originalRange=taskSearchRange,originalOffsets=taskSearchOffsets;
    taskSearchText=body=>{counts.walks++;const result=originalText(body);counts.characters+=result.text.length;return result;};taskSearchRange=(...args)=>{counts.ranges++;return originalRange(...args);};taskSearchOffsets=(...args)=>{counts.scans++;return originalOffsets(...args);};
    const h=taskSearchState();h.open=true;h.query='needle';const measure=fn=>{const before={...counts},start=performance.now();fn();return {milliseconds:performance.now()-start,...Object.fromEntries(Object.keys(counts).map(k=>[k,counts[k]-before[k]]))};};
    const initial=measure(()=>refreshTaskSearch({adopt:true})),matches=h.matches.length;
    const navigation=measure(()=>{for(let n=0;n<40;n++)moveTaskSearch(1);}),selected=h.selected;
    const passive=measure(()=>{for(let n=0;n<20;n++)refreshTaskSearch();});
    const last=document.querySelector('[data-chat-turn="160"] .task-chat-answer p');last.firstChild.textContent+=' needle';
    const mutation=measure(()=>refreshTaskSearch()),updatedMatches=h.matches.length,preserved=h.selected===selected;
    for(const button of document.querySelectorAll('[data-reply-select-code]'))button.textContent='重试全选代码';
    const controls=measure(()=>refreshTaskSearch());h.query='备用关键字';const anotherQuery=measure(()=>refreshTaskSearch({adopt:true}));
    const result={initial,navigation,passive,mutation,controls,anotherQuery,matches,updatedMatches,preserved,finalMatches:h.matches.length};leaveTaskSearch();return result;
   });
   assert.equal(sample.matches,160);assert.equal(sample.updatedMatches,161);assert(sample.preserved);assert.equal(sample.finalMatches,160);
   if(args.includes('--expect-index')){assert.equal(sample.navigation.walks,0);assert.equal(sample.navigation.ranges,0);assert.equal(sample.passive.scans,0);assert.equal(sample.mutation.walks,1);assert.equal(sample.controls.walks,0);assert.equal(sample.anotherQuery.walks,0);}
   samples.push(sample);await page.close();
  }
  assert.deepEqual(errors,[]);const result={source:sourcePath,source_sha256:crypto.createHash('sha256').update(source).digest('hex'),scope:'synthetic-search-DOM-only',turns:160,paragraphs_per_reply:81,navigation_steps:40,passive_refreshes:20,samples,errors,realModelCalls:0};fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,samples:samples.map(s=>({navigation:s.navigation,mutation:s.mutation}))},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
