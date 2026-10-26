'use strict';
// Real Chromium history and rendering against a running local Mock service.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('playwright'),H=require('./ui95_helpers.cjs');
const base=process.env.AGENT_UI_BASE_URL||'http://127.0.0.1:8800';
const out='docs/ui-review-20261025/history-fix';
async function ready(page,workspace,view){
 await page.waitForFunction(({workspace,view})=>typeof state!=='undefined'&&state.workspaceId===workspace&&state.view===view&&state.connected&&!state.busy&&!state.routePosition&&!document.querySelector('#content[aria-busy=true]'),{workspace,view});
 await H.settled(page);
}
async function snapshot(page){return page.evaluate(()=>({workspace:state.workspaceId,picker:document.querySelector('#workspace-picker').value,view:state.view,top:scrollY,max:Math.max(0,document.documentElement.scrollHeight-innerHeight),url:location.href,key:state.routeKey,tenant:state.meta.tenant,sessionWorkspace:state.meta.workspace.id,cards:document.querySelectorAll('.skill-card').length}));}
async function seed(page,count,prefix){await page.evaluate(async({count,prefix})=>{for(let i=0;i<count;i++){const name=prefix+'-'+String(i).padStart(2,'0');await api('/api/skills',{folder:name,revision:0,files:{'SKILL.md':{encoding:'utf-8',content:'---\nname: '+name+'\ndescription: "历史返回长列表验证资料 '+i+'"\n---\n\n# 步骤\n\n检查与回读。'}}});}},{count,prefix});}
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 const result={checks:[],errors:[],startedAt:new Date().toISOString(),base};
 context.on('page',p=>p.on('pageerror',error=>result.errors.push(error.message)));
 page.on('pageerror',error=>result.errors.push(error.message));
 const check=(id,actual,expected)=>{result.checks.push({id,actual,expected,passed:JSON.stringify(actual)===JSON.stringify(expected)});assert.deepEqual(actual,expected,id);};
 const at=(id,actual,expected)=>{result.checks.push({id,actual,expected,passed:Math.abs(actual-expected)<2});assert(Math.abs(actual-expected)<2,id+': '+actual+' vs '+expected);};
 try{
  process.env.AGENT_UI_BASE_URL=base;
  const a=await H.workspace(page,'历史位置修正 A');result.workspaceA=a;
  await seed(page,24,'history-a');await H.nav(page,'skills');await page.locator('.skill-card').last().scrollIntoViewIfNeeded();await H.settled(page);
  const first=await snapshot(page);result.original=first;assert(first.top>4000,'A must be a genuinely long list');
  await page.locator('[data-nav=registry]').click();await ready(page,a.id,'registry');await page.goBack();await ready(page,a.id,'skills');at('same-space-back', (await snapshot(page)).top,first.top);
  await page.goForward();await ready(page,a.id,'registry');await page.goBack();await ready(page,a.id,'skills');at('same-space-forward-and-back',(await snapshot(page)).top,first.top);
  const b=await page.evaluate(async()=>{const saved=await api('/api/workspaces',{name:'历史位置修正 B '+Date.now().toString(36),business:'界面验收',scenario:'空间隔离',description:'独立验证空间',revision:0});await loadWorkspaces();return saved;});result.workspaceB=b;
  await H.switchSpace(page,b.id);await ready(page,b.id,'workbench');at('first-space-entry-starts-at-top',(await snapshot(page)).top,0);
  await seed(page,12,'history-b');await H.nav(page,'skills');at('different-workspace-same-route-starts-at-top',(await snapshot(page)).top,0);
  await page.locator('.skill-card').last().scrollIntoViewIfNeeded();await H.settled(page);const second=await snapshot(page);result.second=second;assert(second.top>1000&&Math.abs(second.top-first.top)>100,'Each workspace must have a distinct scroll position');
  await page.locator('[data-nav=registry]').click();await ready(page,b.id,'registry');await page.goBack();await ready(page,b.id,'skills');at('second-space-local-back',(await snapshot(page)).top,second.top);
  await page.goBack();await ready(page,b.id,'workbench');await page.goBack();await ready(page,a.id,'skills');const back=await snapshot(page);result.crossSpaceBack=back;at('cross-space-back-restores-long-list',back.top,first.top);check('cross-space-back-keeps-scope',[back.workspace,back.picker,back.sessionWorkspace,new URL(back.url).searchParams.get('workspace_id')],[a.id,a.id,a.id,a.id]);
  await page.screenshot({path:out+'/cross-space-back-restored.png',animations:'disabled'});
  await page.goForward();await ready(page,b.id,'workbench');at('cross-space-forward-workbench',(await snapshot(page)).top,0);
  await page.goForward();await ready(page,b.id,'skills');at('cross-space-forward-restores-own-list',(await snapshot(page)).top,second.top);
  const opened=context.waitForEvent('page');await page.evaluate(url=>window.open(url,'_blank'),first.url);const deep=await opened;await ready(deep,a.id,'skills');const fresh=await snapshot(deep);result.newTab=fresh;at('new-tab-deep-link-starts-at-top',fresh.top,0);check('new-tab-deep-link-keeps-scope',[fresh.workspace,fresh.sessionWorkspace],[a.id,a.id]);
  await deep.screenshot({path:out+'/deep-link-starts-at-top.png',animations:'disabled'});
  await deep.reload();await ready(deep,a.id,'skills');const skipBefore=await deep.evaluate(()=>({url:location.href,length:history.length,version:state.routeVersion}));
  await deep.keyboard.press('Tab');check('skip-link-first-keyboard-target',await deep.locator(':focus').textContent(),'跳至主要内容');await deep.keyboard.press('Enter');await H.settled(deep);
  const skipAfter=await deep.evaluate(()=>({url:location.href,length:history.length,version:state.routeVersion,view:state.view,focus:document.activeElement.id}));result.skipLink=skipAfter;
  check('skip-link-keeps-route-and-history',[skipAfter.url,skipAfter.length,skipAfter.version,skipAfter.view,skipAfter.focus],[skipBefore.url,skipBefore.length,skipBefore.version,'skills','content']);await deep.screenshot({path:out+'/skip-link-keeps-current-page.png',animations:'disabled'});
  await deep.locator('.skill-card').last().scrollIntoViewIfNeeded();await H.settled(deep);const beforeReload=await snapshot(deep);await deep.reload();await ready(deep,a.id,'skills');at('reload-restores-position',(await snapshot(deep)).top,beforeReload.top);
  await H.switchSpace(deep,b.id);await ready(deep,b.id,'workbench');at('reenter-existing-space-starts-at-top',(await snapshot(deep)).top,0);await H.nav(deep,'skills');at('fresh-navigation-ignores-stored-list-position',(await snapshot(deep)).top,0);await deep.goBack();await ready(deep,b.id,'workbench');await deep.goBack();await ready(deep,a.id,'skills');at('earlier-entry-keeps-own-position-after-fresh-visit',(await snapshot(deep)).top,beforeReload.top);
  await deep.locator('[data-nav=registry]').click();await ready(deep,a.id,'registry');
  const skills=await deep.evaluate(async()=>(await api('/api/skills')).skills);
  await deep.route('**/api/skills',route=>route.fulfill({json:{skills:skills.slice(0,2)}}));
  await deep.goBack();await ready(deep,a.id,'skills');const shortened=await snapshot(deep);result.shortened=shortened;assert(shortened.top>=0&&shortened.top<=shortened.max,'A shortened list must clamp the old position');check('shortened-list-renders',shortened.cards,2);at('shortened-list-clamps-to-end',shortened.top,Math.min(beforeReload.top,shortened.max));await deep.screenshot({path:out+'/shortened-list-safe.png',animations:'disabled'});
  // Corrupt after pagehide has saved, but before the next app boot reads it.
  await deep.addInitScript(()=>{sessionStorage.setItem('agent-route-positions:v1:'+location.pathname,'{broken');const key=JSON.stringify([new URLSearchParams(location.search).get('workspace_id'),'skills','']);history.replaceState({...history.state,agentRoutePosition:{key,top:-1}},'');});await deep.reload();await ready(deep,a.id,'skills');const malformed=await snapshot(deep);assert(malformed.top>=0&&malformed.top<=malformed.max);check('invalid-storage-does-not-break-route',malformed.workspace,a.id);
  const invalid=await context.newPage();await invalid.goto(base+'/?workspace_id=workspace-history-nonexistent#/skills');await invalid.waitForFunction(()=>typeof state!=='undefined'&&state.connected&&!state.busy&&!state.routePosition);await H.settled(invalid);const fallback=await snapshot(invalid);result.invalidWorkspace=fallback;check('unavailable-workspace-falls-back-safely',[fallback.workspace,fallback.sessionWorkspace,fallback.view],[new URL(fallback.url).searchParams.get('workspace_id'),new URL(fallback.url).searchParams.get('workspace_id'),'workbench']);at('unavailable-workspace-starts-at-top',fallback.top,0);
  check('browser-errors',result.errors,[]);result.finishedAt=new Date().toISOString();
  fs.writeFileSync(out+'/results.json',JSON.stringify(result,null,2));console.log('PASS '+result.checks.length+' history, deep-link, workspace-scope and shortened-list checks');
 }catch(error){result.failure=error.stack;fs.writeFileSync(out+'/results.json',JSON.stringify(result,null,2));await page.screenshot({path:out+'/failure.png',animations:'disabled'}).catch(()=>{});throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
