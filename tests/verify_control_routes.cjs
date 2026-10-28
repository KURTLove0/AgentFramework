'use strict';
// Creates dedicated fixtures only on the explicitly supplied isolated preview service.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const out=process.env.CONTROL_ROUTES_OUTPUT||'/private/tmp/af-ui-unification/routes';
assert(process.env.AGENT_UI_BASE_URL,'AGENT_UI_BASE_URL must point to an isolated test service; this review creates test fixtures.');
const base=process.env.AGENT_UI_BASE_URL.replace(/\/$/,'');
const routes=['workbench','runs','daily','evaluations','workspaces','agents','workflows','skills','domains','library','registry','runtimes'];
const widths=[320,375,414,768,1440];
fs.mkdirSync(out,{recursive:true});
const report={records:[],focus:[],popovers:[],errors:[]};
function inspect(){
 const visible=e=>e.checkVisibility()&&!e.closest('[inert]')&&e.getClientRects().length;
 const root=document.querySelector('dialog[open]')||document.querySelector('#content');
 const fields=[...root.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea,select:not(.enhanced-select),.select-trigger')].filter(visible).map(e=>{
  const r=e.getBoundingClientRect(),s=getComputedStyle(e),shell=e.closest('.filter-input,.resource-search,.select-search,.command-input,.task-chat-composer');
  return {id:e.id,tag:e.tagName,type:e.type,classes:e.className,width:r.width,height:r.height,radius:s.borderRadius,font:s.fontSize,border:s.borderTopWidth,shell:shell?{classes:shell.className,radius:getComputedStyle(shell).borderRadius,height:shell.getBoundingClientRect().height}:null};
 });
 const d=document.querySelector('dialog[open]'),dr=d?.getBoundingClientRect();
 return {route:state.view,width:innerWidth,height:innerHeight,touch:matchMedia('(max-width:700px),(pointer:coarse)').matches,theme:document.documentElement.dataset.theme,rootWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,fields,dialog:d?{id:d.id,x:dr.x,y:dr.y,right:dr.right,bottom:dr.bottom,scrollWidth:d.scrollWidth,clientWidth:d.clientWidth}:null};
}
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.emulateMedia({reducedMotion:'reduce'});
 const settle=async()=>{await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
 const ready=async()=>{await page.waitForFunction(()=>typeof state!=='undefined'&&state.connected&&!state.busy);await settle();};
 const nav=async(route)=>{await page.evaluate(v=>navigate(v),route);await page.waitForFunction(v=>state.view===v&&!state.busy,route);await settle();};
 const screenshot=async(name)=>page.screenshot({path:path.join(out,name+'.png'),fullPage:true,animations:'disabled'});
 const focusReview=async(name)=>{
  const fields=page.locator((await page.locator('dialog[open]').count())?'dialog[open] input:not([type=hidden]):not(.enhanced-select),dialog[open] textarea,dialog[open] .select-trigger':'#content input:not([type=hidden]):not(.enhanced-select),#content textarea,#content .select-trigger');
  for(const e of await fields.all()){
   if(!await e.isVisible()||!await e.isEnabled())continue;
   await e.focus();await e.scrollIntoViewIfNeeded();await settle();
   report.focus.push({context:name,...await e.evaluate(el=>{
    const r=el.getBoundingClientRect(),shell=el.closest('.filter-input,.resource-search,.select-search,.command-input'),surface=shell||el,s=getComputedStyle(surface);
    const hitAt=y=>{const hit=document.elementFromPoint(r.x+r.width/2,y);return !!hit&&(hit===el||el.contains(hit));};
    return {id:el.id,width:innerWidth,theme:document.documentElement.dataset.theme,top:r.top,bottom:r.bottom,hit:hitAt(r.y+r.height/2),topHit:hitAt(r.top+Math.min(3,r.height/2)),bottomHit:hitAt(r.bottom-Math.min(3,r.height/2)),focusSurface:shell?.className||el.id,outline:s.outlineStyle,outlineWidth:s.outlineWidth,outlineOffset:s.outlineOffset,active:document.activeElement===el};
   })});
  }
 };
 try{
  await page.goto(base+'/#/workbench');await ready();
  const workspace=await page.evaluate(()=>api('/api/workspaces',{name:'控件统一独立验收 '+Date.now(),business:'UI 验收',scenario:'独立模拟',description:'临时验收数据',revision:0}));
  report.workspaceId=workspace.id;await page.goto(base+'/?workspace_id='+workspace.id+'#/workbench');await ready();
  const agent=await page.evaluate(async()=>{const definition=(await api('/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;return api('/api/agents',{name:'控件验收助手',description:'隔离 UI 验收',runtime:'mock',model:'builtin',options:{},prompt:'用于验证工作流表单布局',skills:[],mcp_servers:[],definition,revision:0});});report.agentId=agent.id;
  for(const theme of ['light','dark']){
   await page.evaluate(t=>{const appearance=document.getElementById('appearance-select');appearance.value=t;appearance.dispatchEvent(new Event('change',{bubbles:true}));},theme);
   for(const width of widths){
    await page.setViewportSize({width,height:width===1440?1000:900});
    for(const route of routes){await nav(route);report.records.push({context:'route',...await page.evaluate(inspect)});await focusReview('route-'+route);if([375,1440].includes(width)&&['agents','domains','runtimes','library'].includes(route))await screenshot(route+'-'+theme+'-'+width);}
   }
  }
  for(const theme of ['light','dark']){
   await page.evaluate(t=>{const appearance=document.getElementById('appearance-select');appearance.value=t;appearance.dispatchEvent(new Event('change',{bubbles:true}));},theme);
   for(const width of widths){
    await page.setViewportSize({width,height:width===1440?1000:900});
    for(const [name,route,fn]of [['workspace','workspaces','openWorkspace'],['domain','domains','openDomainEditor'],['agent','agents','openAgent'],['workflow','workflows','openFlowEditor']]){
     console.log('DIALOG',name,theme,width);await nav(route);await page.evaluate(async fn=>{await window[fn]();},fn);await page.locator('dialog[open]').waitFor();await settle();
     report.records.push({context:'dialog-'+name,...await page.evaluate(inspect)});await focusReview(name);
     if([375,1440].includes(width))await screenshot('dialog-'+name+'-'+theme+'-'+width);
     await page.evaluate(()=>{closeFormPicker();document.querySelectorAll('dialog[open]').forEach(d=>d.close());state.agentDirty=false;});
    }
    await nav('runtimes');await page.evaluate(()=>selectRuntimeProvider('codex'));await settle();report.records.push({context:'runtime-codex',...await page.evaluate(inspect)});await focusReview('runtime-codex');if([375,1440].includes(width))await screenshot('runtime-codex-'+theme+'-'+width);
    await nav('domains');await page.locator('#appearance-select-picker').click();await settle();
    report.popovers.push({context:'short-status',...await page.evaluate(()=>{const p=pickerOpen,r=p.popup.getBoundingClientRect(),s=getComputedStyle(p.popup);return {width:innerWidth,theme:document.documentElement.dataset.theme,radius:s.borderRadius,filter:s.backdropFilter,image:s.backgroundImage,x:r.x,right:r.right,y:r.y,bottom:r.bottom,scrollWidth:p.popup.scrollWidth,clientWidth:p.popup.clientWidth,searchable:p.searchable};})});
    if([375,1440].includes(width))await screenshot('short-dropdown-'+theme+'-'+width);await page.keyboard.press('Escape');
    await nav('agents');await page.evaluate(async()=>{await openAgent();const select=document.querySelector('#agent-domain');for(let i=0;i<12;i++){const o=new Option('长名称测试'+i+'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz智能体处理领域需要在窄屏正确换行'.repeat(2),'review-'+i);select.add(o);}refreshFormControls();});await settle();await page.locator('#agent-domain-picker').click();await settle();
    report.popovers.push({context:'long-domain',...await page.evaluate(()=>{const p=pickerOpen,r=p.popup.getBoundingClientRect(),s=getComputedStyle(p.popup);return {width:innerWidth,theme:document.documentElement.dataset.theme,radius:s.borderRadius,filter:s.backdropFilter,image:s.backgroundImage,x:r.x,right:r.right,y:r.y,bottom:r.bottom,scrollWidth:p.popup.scrollWidth,clientWidth:p.popup.clientWidth,listScrollWidth:p.list.scrollWidth,listClientWidth:p.list.clientWidth,searchable:p.searchable};})});
    if([375,1440].includes(width))await screenshot('long-dropdown-'+theme+'-'+width);await page.keyboard.press('Escape');await page.evaluate(()=>{document.querySelectorAll('dialog[open]').forEach(d=>d.close());state.agentDirty=false;});
   }
  }
  await page.setViewportSize({width:1440,height:1000});await nav('library');await page.locator('#hub-tab-memory').click();await page.locator('.resource-create-menu>summary').click();await settle();
  report.menu=await page.locator('.resource-create-menu').evaluate(e=>({role:e.querySelector('div').getAttribute('role'),items:[...e.querySelectorAll('div>button')].map(b=>({role:b.getAttribute('role'),align:getComputedStyle(b).textAlign,radius:getComputedStyle(b).borderRadius,height:b.getBoundingClientRect().height}))}));await screenshot('resource-menu-desktop');await page.keyboard.press('Escape');
  await page.evaluate(()=>openCommand());await page.locator('#command-dialog[open]').waitFor();await page.locator('#command-input').focus();await settle();report.commandFocus=await page.locator('#command-input').evaluate(el=>{const shell=el.closest('.command-input'),style=getComputedStyle(shell);return {active:document.activeElement===el,outline:style.outlineStyle,width:style.outlineWidth};});await page.keyboard.press('Escape');
  report.violations={overflow:report.records.filter(r=>r.rootWidth>r.width+1||r.bodyWidth>r.width+1||r.dialog&&(r.dialog.x<-.5||r.dialog.right>r.width+.5||r.dialog.y<-.5||r.dialog.bottom>r.height+.5||r.dialog.scrollWidth>r.dialog.clientWidth+1)),radius:report.records.flatMap(r=>r.fields.filter(f=>f.radius!=='8px'&&f.shell?.radius!=='8px').map(f=>({context:r.context,route:r.route,width:r.width,theme:r.theme,...f}))),size:report.records.flatMap(r=>r.fields.filter(f=>(f.shell?.height||f.height)<(r.touch?44:40)-.5||f.font!==(r.touch?'16px':'14px')).map(f=>({context:r.context,route:r.route,width:r.width,theme:r.theme,...f}))),focus:report.focus.filter(f=>!f.active||!f.hit||!f.topHit||!f.bottomHit||f.outline==='none'||f.outlineWidth==='0px'),popovers:report.popovers.filter(p=>p.radius!=='12px'||p.filter!=='none'||p.image!=='none'||p.x<-.5||p.right>p.width+.5||p.y<-.5||p.bottom>(p.width===1440?1000:900)+.5||p.scrollWidth>p.clientWidth+1||p.listScrollWidth>p.listClientWidth+1),menu:report.menu.items.filter(item=>item.align!=='left'||item.height<40||item.radius!=='8px'),commandFocus:report.commandFocus.active&&report.commandFocus.outline!=='none'&&report.commandFocus.width!=='0px'?[]:[report.commandFocus]};
  console.log(JSON.stringify({records:report.records.length,focus:report.focus.length,popovers:report.popovers.length,violations:Object.fromEntries(Object.entries(report.violations).map(([k,v])=>[k,v.length])),errors:report.errors}));
  assert.equal(report.records.length,170,'Complete route and dialog matrix must be reviewed.');
  assert.equal(report.popovers.length,20,'Both short and long lists must be reviewed at every size and theme.');
  assert.deepEqual(report.errors,[],'Browser errors must be resolved.');
  for(const [category,items]of Object.entries(report.violations))assert.equal(items.length,0,category+' violations remain; see results.json.');
 }catch(e){report.failure=e.stack;await screenshot('failure').catch(()=>{});console.error(e);process.exitCode=1;}finally{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
