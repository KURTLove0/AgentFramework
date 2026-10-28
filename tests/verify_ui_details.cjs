'use strict';
// Runs only on an explicitly supplied disposable service. The fixtures are real
// records, so table and task layouts cannot pass by rendering an empty shell.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.UI_DETAILS_BASE_URL;
assert(base,'UI_DETAILS_BASE_URL must point to a disposable preview service.');
const out=path.resolve(process.env.UI_DETAILS_OUTPUT||'/private/tmp/agent-ui-details');
fs.mkdirSync(out,{recursive:true});
const routes=['workbench','runs','daily','evaluations','workspaces','agents','workflows','skills','domains','library','registry','runtimes'];
const widths=[320,375,414,768,1440];
const report={records:[],violations:[],errors:[],zoom:[],checks:[],screenshots:[]};
function measure(){
 const root=document.querySelector('dialog[open]')||document.querySelector('#content');
 const visible=e=>e.checkVisibility()&&e.getBoundingClientRect().width>4&&e.getBoundingClientRect().height>4&&!e.closest('[aria-hidden=true],.sr-only');
 const cv=document.createElement('canvas'),ctx=cv.getContext('2d');cv.width=cv.height=1;
 const rgb=c=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=c;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
 const lum=c=>rgb(c).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
 const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
 const fields=[...root.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not(.enhanced-select),textarea,.select-trigger')].filter(visible).map(e=>{
  const shell=e.closest('.filter-input,.resource-search')||e,s=getComputedStyle(shell),f=getComputedStyle(e),r=shell.getBoundingClientRect();
  return {id:e.id,tag:e.tagName,height:r.height,width:r.width,font:parseFloat(f.fontSize),radius:s.borderRadius,disabled:e.matches(':disabled'),readonly:e.readOnly,multiline:e.tagName==='TEXTAREA',boundary:parseFloat(s.borderTopWidth)?ratio(s.borderTopColor,s.backgroundColor):null,text:ratio(f.color,s.backgroundColor),border:s.borderTopColor,bg:s.backgroundColor};
 });
 const prose=[...root.querySelectorAll('.page-head p:not(.eyebrow),.library-module-heading p,.empty p,.domain-explanation,.domain-builtin-grid p,.task-user-content,.task-chat-answer')].filter(visible).map(e=>({kind:e.className||e.tagName,font:parseFloat(getComputedStyle(e).fontSize),line:parseFloat(getComputedStyle(e).lineHeight)}));
 const help=[...root.querySelectorAll('.field-help,.required-note,.run-advanced-filters label,.runtime-choice small,.agent-row-description,.agent-section-copy')].filter(visible).map(e=>({kind:e.className||e.tagName,font:parseFloat(getComputedStyle(e).fontSize)}));
 const tiny=[...root.querySelectorAll('*')].filter(e=>visible(e)&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&parseFloat(getComputedStyle(e).fontSize)<11.99).map(e=>({tag:e.tagName,id:e.id,cls:e.className,font:getComputedStyle(e).fontSize}));
 const title=root.querySelector('h1'),toolbar=document.querySelector('#hub-search-form');
 const sizes=toolbar?[...toolbar.querySelectorAll(':scope>.resource-search,:scope>.button,:scope>.select-picker')].filter(visible).map(e=>{const r=e.getBoundingClientRect();return {cls:e.className,h:r.height,y:r.y,w:r.width};}):[];
 const empty=document.querySelector('.run-list-panel>.empty');
 const dialog=root.matches('dialog')?root:null,dr=dialog?.getBoundingClientRect();
 return {route:state.view,dialog:dialog?.id,width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme,touch:matchMedia('(max-width:700px),(pointer:coarse)').matches,overflow:document.documentElement.scrollWidth>innerWidth||document.body.scrollWidth>innerWidth,title:title?parseFloat(getComputedStyle(title).fontSize):null,fields,prose,help,tiny,toolbar:sizes,emptyHeight:empty?.getBoundingClientRect().height,dialogBox:dr?{top:dr.top,bottom:dr.bottom,left:dr.left,right:dr.right}:null};
}
function inspect(record){
 const issues=[];if(record.overflow)issues.push('page overflow');
 if(record.title&&record.title!==(record.width<=700?24:28))issues.push('title scale '+record.title);
 for(const f of record.fields){
  if(f.font!==(record.touch?16:14))issues.push('field font '+f.id+' '+f.font);
  if(f.radius!=='8px')issues.push('field radius '+f.id+' '+f.radius);
  if(!f.multiline&&Math.abs(f.height-(record.touch?44:40))>1)issues.push('field height '+f.id+' '+f.height);
  if(!f.disabled&&!f.readonly&&f.boundary!==null&&f.boundary<3)issues.push('field boundary '+f.id+' '+f.boundary);
  if(!f.disabled&&!f.readonly&&f.text<4.5)issues.push('field text '+f.id+' '+f.text);
 }
 for(const p of record.prose)if(p.font<(record.touch?16:14)||p.line/p.font<1.5)issues.push('prose '+p.kind+' '+p.font+'/'+p.line);
 for(const h of record.help)if(h.font<(record.touch?14:13))issues.push('help '+h.kind+' '+h.font);
 if(record.tiny.length)issues.push('tiny text '+JSON.stringify(record.tiny));
 for(let i=0;i<record.toolbar.length;i++)for(let j=i+1;j<record.toolbar.length;j++){const a=record.toolbar[i],b=record.toolbar[j];if(Math.abs(a.y-b.y)<2&&Math.abs(a.h-b.h)>1)issues.push('toolbar height '+a.h+'/'+b.h);}
 const select=record.toolbar.find(e=>e.cls==='select-picker');if(record.width>700&&select&&(select.w<160||select.w>200))issues.push('short filter width '+select.w);
 if(record.emptyHeight&&record.emptyHeight>(record.width<=700?300:260))issues.push('empty height '+record.emptyHeight);
 const d=record.dialogBox;if(d&&(d.top<-.5||d.bottom>record.height+.5||d.left<-.5||d.right>record.width+.5))issues.push('dialog bounds');
 if(issues.length)report.violations.push({route:record.route,dialog:record.dialog,theme:record.theme,width:record.width,issues});
}
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.setDefaultTimeout(12000);page.on('pageerror',e=>report.errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'});
 const settled=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const nav=async v=>{await page.evaluate(v=>navigate(v),v);await page.waitForFunction(v=>state.connected&&!state.busy&&state.view===v,v);await settled();};
 const capture=async name=>{const record={context:name,...await page.evaluate(measure)};report.records.push(record);inspect(record);};
 const shot=async name=>{const file=name+'.png';await page.screenshot({path:path.join(out,file),animations:'disabled'});report.screenshots.push(file);};
 const close=()=>page.evaluate(()=>{closeFormPicker();document.querySelectorAll('dialog[open]').forEach(d=>d.close());state.agentDirty=false;if(typeof skillEditor!=='undefined'&&skillEditor)skillEditor.dirty=false;});
 try{
  await page.goto(base+'/#/workbench');await page.waitForFunction(()=>state.connected&&!state.busy);
  const workspace=await page.evaluate(()=>api('/api/workspaces',{name:'细节复评 '+Date.now(),business:'独立 UI 验证',scenario:'字号与展示框',description:'临时验收',revision:0}));
  await page.goto(base+'/?workspace_id='+workspace.id+'#/workbench');await page.waitForFunction(()=>state.connected&&!state.busy);
  for(const theme of ['light','dark'])for(const width of widths){
   await page.setViewportSize({width,height:width>700?1000:900});await page.selectOption('#appearance-select',theme);
   for(const route of routes){await nav(route);await capture('empty-'+route);if([375,1440].includes(width)&&['runs','library','agents','runtimes'].includes(route))await shot(route+'-'+theme+'-'+width);}
  }
  const agent=await page.evaluate(async()=>{const definition=(await api('/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;return api('/api/agents',{name:'客户服务资料查询与工单整理助手ABCDEFGHIJKLMNOPQRSTUVWXYZ',description:'用于验证长名称、说明与操作区域的比例。',runtime:'mock',model:'builtin',options:{},prompt:'先核对事实，再说明依据与缺失材料。',skills:[],mcp_servers:[],definition,revision:0});});
  const helpers=require('./ui95_helpers.cjs');await nav('workflows');const flow=await helpers.workflow(page,agent.id,'核对资料后整理说明');
  report.fixtures={workspace:workspace.id,agent:agent.id,flow:flow.id};
  const dialogs=[['workspace','workspaces','openWorkspace()'],['domain','domains','openDomainEditor()'],['agent','agents','openAgent()'],['skill','skills','openSkillEditor()'],['asset','library','openAsset()'],['schedule','daily','openScheduleSettings()'],['policy','evaluations','openEvaluationPolicy()'],['workflow','workflows','openFlowEditor()'],['task','agents','newTask({agentId:'+JSON.stringify(agent.id)+'})'],['workflow-start','workflows','openFlowStart('+JSON.stringify(flow.id)+')']];
  for(const theme of ['light','dark'])for(const width of widths){
   await page.setViewportSize({width,height:width>700?1000:900});await page.selectOption('#appearance-select',theme);
   for(const [name,route,code]of dialogs){await nav(route);await page.evaluate(code);await page.locator('dialog[open]').last().waitFor();await settled();await capture('dialog-'+name);if([375,1440].includes(width)&&['agent','asset','schedule'].includes(name))await shot(name+'-'+theme+'-'+width);await close();}
   await nav('agents');await capture('populated-agents');await page.evaluate(id=>navigate('agents',id),agent.id);await page.waitForFunction(id=>state.selected===id&&!state.busy,agent.id);await settled();await capture('agent-detail');if([375,1440].includes(width))await shot('agent-detail-'+theme+'-'+width);
  }
  // Text enlargement tests the same saved long name and actual editor, not a mock.
  for(const width of [320,375,768])for(const route of ['runs','library','agents']){
   await page.setViewportSize({width,height:1000});await nav(route);await page.evaluate(()=>{const sizes=[...document.querySelectorAll('#content *')].map(el=>[el,parseFloat(getComputedStyle(el).fontSize)]);for(const [el,size]of sizes)el.style.fontSize=size*2+'px';});await settled();
   const zoom=await page.evaluate(()=>({width:innerWidth,route:state.view,overflow:document.documentElement.scrollWidth>innerWidth,heading:document.querySelector('#content h1')?.getBoundingClientRect().toJSON()}));report.zoom.push(zoom);assert(!zoom.overflow,'200% text overflow '+route+' '+width);await shot('text-200-'+route+'-'+width);await page.reload();await page.waitForFunction(()=>state.connected&&!state.busy);
  }
  for(const width of [320,375,768])for(const [name,route,code]of dialogs.filter(d=>['agent','asset','skill','task'].includes(d[0]))){
   await page.setViewportSize({width,height:900});await nav(route);await page.evaluate(code);await page.locator('dialog[open]').last().waitFor();
   if(name==='agent'){await page.locator('#agent-name').fill('客户资料核对助手');await page.locator('[data-agent-config-direction="1"]').click();await page.locator('[data-agent-config-direction="1"]').click();}
   await page.evaluate(()=>{const sizes=[...document.querySelectorAll('dialog[open] *')].map(el=>[el,parseFloat(getComputedStyle(el).fontSize)]);for(const [el,size]of sizes)el.style.fontSize=size*2+'px';});await settled();
   const zoom=await page.evaluate(()=>{const d=document.querySelector('dialog[open]'),r=d.getBoundingClientRect();return {context:d.id,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth||d.scrollWidth>d.clientWidth+1,bounds:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},fields:[...d.querySelectorAll('input:not(.enhanced-select):not([type=hidden]):not([type=checkbox]),textarea,.select-trigger')].filter(e=>e.checkVisibility()).map(e=>({id:e.id,height:e.getBoundingClientRect().height,line:parseFloat(getComputedStyle(e).lineHeight),font:parseFloat(getComputedStyle(e).fontSize)}))};});
   report.zoom.push(zoom);assert(!zoom.overflow,'200% dialog text overflow '+name+' '+width);assert(zoom.fields.every(f=>f.height>=f.line-1),'Enlarged field text is clipped '+name);
   for(const button of await page.locator('dialog[open] .dialog-foot button').all()){if(!await button.isVisible()||!await button.isEnabled())continue;await button.scrollIntoViewIfNeeded();assert(await button.evaluate(e=>{const r=e.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!hit&&(hit===e||e.contains(hit));}),'Enlarged dialog action is obscured '+name);}
   await shot('text-200-'+name+'-'+width);await close();await page.reload();await page.waitForFunction(()=>state.connected&&!state.busy);
  }
  assert.equal(report.records.length,240,'All route, dialog and populated contexts must be recorded');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.violations,[],'UI detail violations remain; inspect results.json');
  report.checks.push('240 contexts: twelve routes, ten dialogs and saved long-name Agent directory/detail across two themes and five widths','Control geometry, field contrast, readable typography and bounded containers','200% text in three main directories and four editors across three widths, including field reading space and reachable footer actions');
  console.log(JSON.stringify({records:report.records.length,zoom:report.zoom.length,errors:report.errors,violations:report.violations.length,output:out}));
 }catch(error){report.failure=error.stack;await shot('failure').catch(()=>{});throw error;}finally{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
