'use strict';
// Text-only resizing: computed HTML font sizes and line heights are doubled once.
// This is distinct from browser zoom. SVG diagrams retain their pan/zoom controls.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),H=require('./ui95_helpers.cjs'),auditUI=require('./ui95_audit.cjs');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true}),errors=[],records=[];let p;
 const artifacts=JSON.parse(fs.readFileSync('docs/ui95/module-results.json')).artifacts;
 const base='http://127.0.0.1:8799/?workspace_id='+encodeURIComponent(artifacts.workspaceId);
 async function open(view,id){if(p)await p.close();p=await browser.newPage({viewport:{width:375,height:812}});p.on('pageerror',e=>errors.push(e.message));await p.emulateMedia({reducedMotion:'reduce'});await p.goto(base+'#/'+view+(id?'/'+id:''));await p.waitForFunction(()=>state.connected&&!state.busy);await H.settled(p);}
 async function inspect(name){await p.evaluate(()=>{const entries=[...document.querySelectorAll('body,body *')].filter(el=>el instanceof HTMLElement).map(el=>{const s=getComputedStyle(el);return {el,font:parseFloat(s.fontSize),line:parseFloat(s.lineHeight)}});for(const {el,font,line}of entries){if(font)el.style.setProperty('font-size',font*2+'px','important');if(line)el.style.setProperty('line-height',line*2+'px','important');}});await H.settled(p);
  const result=await p.evaluate(auditUI,name);result.unreachable=[];
  // Check each primary/footer action after scrolling, including its real hit target.
  const actions=await p.locator('dialog[open]').count()?p.locator('dialog[open] .dialog-foot button'):p.locator('#content .page-head .button, #runtime-form [type=submit]');
  for(const action of await actions.all()){if(!await action.isVisible()||await action.isDisabled())continue;await action.scrollIntoViewIfNeeded();const m=await action.evaluate(el=>{const b=el.getBoundingClientRect(),d=el.closest('dialog')?.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(el);const text=range.getBoundingClientRect();return {label:el.textContent.trim()||el.getAttribute('aria-label'),x:b.x,right:b.right,y:b.y,bottom:b.bottom,width:b.width,height:b.height,hit:el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)),dialogTop:d?.top??0,dialogBottom:d?.bottom??innerHeight,textLeft:text.left,textRight:text.right,viewportHeight:innerHeight}});
   if(m.x<-.5||m.right>375.5||m.y<Math.max(0,m.dialogTop)-1||m.bottom>Math.min(m.viewportHeight,m.dialogBottom)+1||!m.hit||m.textLeft<m.x-1||m.textRight>m.right+1)result.unreachable.push(m);}
  records.push(result);fs.writeFileSync('docs/ui95/text-resize-partial.json',JSON.stringify({records,errors},null,2));await p.screenshot({path:'docs/ui95/screenshots/text-'+name+'.png',animations:'disabled'});console.log('CHECK '+name);
 }
 try{
  for(const view of ['workbench','runs','agents','workflows','skills','library','daily','evaluations','workspaces','registry','runtimes']){await open(view,view==='workbench'?artifacts.runId:undefined);await inspect(view);}
  const dialogs=[['workspace','workspaces','openWorkspace()'],['agent','agents','openAgent()'],['task','agents','newTask({agentId:'+JSON.stringify(artifacts.agentId)+'})'],['flow','workflows','openFlowEditor()'],['flow-start','workflows','openFlowStart('+JSON.stringify(artifacts.workflowId)+')'],['flow-chat','workflows','openFlowChat()'],['skill','skills','openSkillEditor()'],['asset','library','openAsset()'],['schedule','daily','openScheduleSettings()'],['policy','evaluations','openEvaluationPolicy()'],['role-contract','evaluations','openRoleEvaluationSettings('+JSON.stringify(artifacts.agentId)+')'],['learning','library','openLearning('+JSON.stringify(artifacts.runId)+')']];
  for(const [name,view,code]of dialogs){await open(view);await p.evaluate(code);await p.locator('dialog[open]').last().waitFor();await inspect('dialog-'+name);}
  // The longer next-step labels and terminal submit are separate states.
  await open('agents');await p.evaluate(id=>newTask({agentId:id}),artifacts.agentId);await p.locator('#task-goal').fill('核对文字放大后完整可读的任务目标');await p.locator('#task-next').click();await inspect('task-execution');
  await open('agents');await p.evaluate(id=>newTask({agentId:id}),artifacts.agentId);await p.locator('#task-goal').fill('核对文字放大后的审查与许可');await p.locator('#task-next').click();await p.locator('#task-next').click();await inspect('task-review');
  const violations=records.filter(r=>r.rootWidth>376||r.clipping.length||r.smallTargets.length||r.nameIssues.length||r.lowContrast.length||r.unreachable.length||r.dialog&&(r.dialog.rect.x<0||r.dialog.rect.right>376||r.dialog.rect.y<0||r.dialog.rect.bottom>813));
  fs.writeFileSync('docs/ui95/text-resize-results.json',JSON.stringify({generatedAt:new Date().toISOString(),browser:browser.version(),method:'200% computed HTML text and line-height, 375x812, reduced motion; not browser zoom',records,errors,violations:violations.map(r=>({name:r.name,rootWidth:r.rootWidth,clipping:r.clipping,unreachable:r.unreachable,dialog:r.dialog}))},null,2));console.log(records.length+' text resize contexts; '+violations.length+' violations');assert.deepEqual(errors,[]);assert.equal(violations.length,0);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
