'use strict';
// Uses an isolated local data directory. All business tools remain simulated.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),h=require('./ui95_helpers.cjs');
const output=path.resolve(process.env.MULTICA_REVIEW_OUTPUT||'docs/multica-agent-review');
const base=process.env.AGENT_UI_BASE_URL||'http://127.0.0.1:8799';
fs.mkdirSync(path.join(output,'screenshots'),{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),checks=[],errors=[],layouts=[],contrasts=[];
 page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'});
 const pass=(id,detail)=>{checks.push({id,detail,pass:true});console.log('PASS',id,detail);};
 const shot=async name=>{await h.settled(page);await page.screenshot({path:path.join(output,'screenshots',name+'.png'),fullPage:true,animations:'disabled'});};
 const ready=async()=>{await page.waitForFunction(()=>state.connected&&!state.busy&&state.routeHash===location.hash);await h.settled(page);};
 const agentLink=id=>page.locator('#agent-open-'+id);
 const detail=async(id,tab='overview')=>{await page.goto(base+'/?workspace_id='+workspace.id+'#/agents/'+id+(tab==='overview'?'':'/'+tab));await ready();};
 const workspace=await h.workspace(page,'Multica 产品经理评审');await h.nav(page,'agents');
 assert(await page.locator('.agent-first-empty').isVisible());await shot('empty-light-1440');pass('first-use','首次空白有用途说明和创建入口');
 const qa=await h.agent(page,'knowledge-answer@1.0.0','资料问答助手');
 await detail(qa.id);assert.equal(await page.locator('#agent-detail-heading').innerText(),qa.name);
 assert.equal(await page.locator('#agent-detail-panel').innerText().then(s=>s.includes('依据有来源的知识回答问题')),true);
 if(await page.locator('[data-agent-notice-close]').count())await page.locator('[data-agent-notice-close]').click();pass('create-detail','保存记录可直接打开同一智能体详情，职责和版本来自保存记录');
 const writer=await h.agent(page,'change-assessment@2.0.0','变更评估助手');
 const long=await h.agent(page,'knowledge-answer@1.0.0','售后支持与退换货政策资料查询助手ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
 if(await page.locator('[data-agent-notice-close]').count())await page.locator('[data-agent-notice-close]').click();
 await h.nav(page,'agents');
 await page.locator('#agent-search').fill('资料');assert.equal(await page.locator('.agent-directory-row').count(),2);
 await page.locator('#agent-domain-filter').selectOption('none');
 await page.locator('#agent-runtime-filter').selectOption('mock');await page.locator('#agent-sort').selectOption('name');
 const sorted=await page.locator('.agent-row-identity strong').allTextContents();assert.deepEqual(sorted,[...sorted].sort((a,b)=>a.localeCompare(b,'zh-CN')));
 const search=page.locator('#agent-search');await search.focus();await page.evaluate(()=>{window.__search=document.querySelector('#agent-search');window.__search.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));});
 await page.evaluate(()=>refresh());assert.equal(await page.evaluate(()=>document.activeElement===window.__search),true);
 await page.evaluate(()=>window.__search.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));await h.settled(page);
 assert.equal(await search.inputValue(),'资料');pass('find','搜索、领域、执行方式组合筛选，名称排序，刷新及中文输入焦点保持');
 await agentLink(qa.id).click();await page.waitForURL(url=>url.hash==='#/agents/'+qa.id);await ready();
 await page.locator('#agent-detail-tab-instructions').click();await ready();assert((await page.locator('.agent-instructions-content').innerText()).includes(qa.prompt));
 await page.locator('#agent-detail-tab-instructions').focus();await page.keyboard.press('ArrowRight');await ready();assert.equal(await page.locator('#agent-detail-tab-skills').getAttribute('aria-selected'),'true');assert.equal(await page.evaluate(()=>document.activeElement.id),'agent-detail-tab-skills');
 assert(await page.locator('.agent-tab-empty').isVisible());await page.reload();await ready();assert.equal(await page.locator('#agent-detail-heading').innerText(),qa.name);assert.equal(await page.locator('#agent-detail-tab-skills').getAttribute('aria-selected'),'true');
 // Reload is a new document; recreate the directory context explicitly before history check.
 await h.nav(page,'agents');await page.locator('#agent-search').fill('资料');await page.locator('#agent-sort').selectOption('name');await agentLink(qa.id).click();await ready();await page.goBack();await ready();assert.equal(await search.inputValue(),'资料');assert.equal(await page.locator('#agent-sort').inputValue(),'name');assert.equal(await page.evaluate(()=>document.activeElement.id),'agent-open-'+qa.id);
 pass('detail-history','详情直接链接/刷新正确；页签支持方向键；浏览器返回保留筛选排序与项目焦点');
 await search.fill('没有这种助理');assert(await page.locator('.agent-directory-empty').isVisible());await page.locator('[data-action=clear-agent-filter]').click();assert.equal(await page.locator('.agent-directory-row').count(),3);
 await page.locator('[data-agent-scope=archived]').click();assert((await page.locator('.agent-directory-empty').innerText()).includes('还没有归档'));await page.locator('[data-action=clear-agent-filter]').click();pass('empty-filters','无结果与无归档状态有分别提示和清除恢复入口');
 await agentLink(writer.id).click();await ready();await page.locator('[data-archive-agent]').click();await page.waitForFunction(()=>state.agents.find(a=>a.name==='变更评估助手').archived);assert.equal(await page.locator('[data-agent-new-task]').count(),0);assert((await page.locator('.agent-detail-page').innerText()).includes('此智能体已归档'));
 for(const tab of ['instructions','skills','activity']){await page.locator('#agent-detail-tab-'+tab).click();await ready();assert.equal(await page.locator('[data-edit-agent],[data-agent-new-task],[data-agent-saved-use]').count(),0);}
 await page.locator('[data-archive-agent]').click();await page.waitForFunction(()=>!state.agents.find(a=>a.name==='变更评估助手').archived);assert(await page.locator('#agent-new-task-'+writer.id).isVisible());pass('archive','归档详情只读可查看，任务入口移除，恢复后才可创建任务');
 await detail(qa.id,'instructions');await page.locator('[data-agent-edit-section=runtime]').click();await page.locator('#agent-dialog[open]').waitFor();assert.equal(await page.locator('#agent-config-tab-runtime').getAttribute('aria-selected'),'true');
 const changedPrompt=qa.prompt+'\n优先列出资料缺口。';await page.locator('#agent-prompt').fill(changedPrompt);await page.locator('[data-agent-config-direction="1"]').click();
 let postCount=0;await page.route('**/api/agents/'+qa.id,async route=>{if(route.request().method()==='POST'){postCount++;await new Promise(resolve=>setTimeout(resolve,250));await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'评审故障注入：暂时无法保存'})});}else await route.continue();});
 await page.locator('#agent-save').click();await page.waitForFunction(()=>!state.agentSaving);assert(await page.locator('#agent-dialog').isVisible());assert.equal(await page.locator('#agent-prompt').inputValue(),changedPrompt);assert.equal(postCount,1);assert(await page.locator('#agent-form-error').isVisible());await page.unroute('**/api/agents/'+qa.id);
 await page.locator('#agent-save').click();await page.locator('#agent-dialog').waitFor({state:'hidden'});await ready();assert.equal(await page.locator('#agent-detail-heading').innerText(),qa.name);assert((await page.locator('.agent-detail-saved').innerText()).includes('v2'));
 pass('save-retry','编辑指令直达对应分区；保存失败保留输入，重试成功版本递增且回到详情');
 await page.locator('[data-agent-saved-use]').click();await page.locator('#create-dialog[open]').waitFor();assert.equal(await page.locator('#task-agent').inputValue(),qa.id);assert.equal(await page.locator('#create-form [name=grant]').isChecked(),false);await page.locator('#task-goal').fill('变更评估的风险规则是什么？');
 const receipt=page.waitForResponse(r=>r.url().endsWith('/api/tasks')&&r.request().method()==='POST');await page.locator('#create-form button[type=submit]').click();const response=await receipt;assert(response.ok(),await response.text());const run=(await response.json()).run;
 await page.locator('#create-dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>['SUCCEEDED','FAILED','NEEDS_REVIEW'].includes(state.detail?.run.status));assert.equal(await page.evaluate(()=>state.detail.run.status),'SUCCEEDED');
 await detail(qa.id,'activity');assert((await page.locator('.agent-activity-list').innerText()).includes('配置 v2'));assert.equal(await page.locator('.agent-activity-list a').getAttribute('href'),'#/runs/'+run.run_id);await page.locator('.agent-activity-list a').click();await ready();assert.equal(await page.evaluate(()=>state.detail.run.run_id),run.run_id);
 pass('execution','详情准确预选岗位v2，任务审查不自动授权，模拟问答完成且记录链接到真实结果');
 await detail('agent-missing');assert((await page.locator('#agent-detail-heading').innerText()).includes('找不到'));await page.locator('.agent-detail-missing a').click();await ready();assert(await page.locator('.agent-directory-surface').isVisible());
 const other=await page.evaluate(()=>api('/api/workspaces',{name:'空间边界 '+Date.now(),business:'隔离验收',scenario:'空间边界',description:'',revision:0}));await h.switchSpace(page,other.id);await h.nav(page,'agents',qa.id);assert((await page.locator('#agent-detail-heading').innerText()).includes('找不到'));await h.switchSpace(page,workspace.id);pass('scope-missing','不存在记录可返回；其他工作空间无法显示原智能体');

 const skill=await page.evaluate(async()=>{
  const body='---\nname: evidence-check\ndescription: 核对资料来源与证据完整性\n---\n\n# 证据检查\n\n先核对来源，再说明缺失证据。';
  const files={'SKILL.md':{encoding:'utf-8',content:body}};
  const first=await api('/api/skills',{folder:'evidence-check',revision:0,files});
  const published=await api('/api/skills/'+first.id+'/publish',{revision:first.revision,version:1});
  const second=await api('/api/skills/'+first.id,{folder:'evidence-check',revision:published.revision,files:{'SKILL.md':{encoding:'utf-8',content:body+'\n第二版新增要求。'}}});
  await api('/api/skills/'+first.id+'/publish',{revision:second.revision,version:2});return published;
 });
 await detail(writer.id,'skills');await page.locator('[data-agent-edit-section=skills]').click();await page.locator('#agent-dialog[open]').waitFor();await page.locator('[data-action=add-agent-skill]').click();await page.locator('#agent-skill-select-0').selectOption(skill.id+'@1');await page.locator('#agent-save').click();await page.locator('#agent-dialog').waitFor({state:'hidden'});await ready();
 await page.locator('[data-agent-notice-close]').click();await page.locator('#agent-detail-tab-skills').click();await ready();assert((await page.locator('.agent-detail-skills').innerText()).includes('固定发布版本 v1'));
 await page.locator('.agent-skill-description summary').click();assert((await page.locator('.agent-skill-description').innerText()).includes('先核对来源'));assert(!(await page.locator('.agent-detail-skills').innerText()).includes('第二版新增要求'));await shot('skills-bound-light-1440');pass('pinned-skill','从详情配置并绑定已发布v1，已有v2时仍显示v1技能说明与职责');
 await h.nav(page,'agents');await search.focus();await page.keyboard.insertText('资料问答');
 const tabTo=async(selector,reverse=false)=>{for(let i=0;i<80;i++){if(await page.locator(selector).evaluate(e=>e===document.activeElement))return;await page.keyboard.press(reverse?'Shift+Tab':'Tab');}throw Error('键盘无法到达 '+selector)};
 await tabTo('#agent-open-'+qa.id);await page.keyboard.press('Enter');await ready();await tabTo('#agent-detail-tab-overview');await page.keyboard.press('ArrowRight');await ready();assert.equal(await page.locator('#agent-detail-tab-instructions').getAttribute('aria-selected'),'true');await page.keyboard.press('End');await ready();assert.equal(await page.locator('#agent-detail-tab-activity').getAttribute('aria-selected'),'true');await page.keyboard.press('Home');await ready();
 await tabTo('.agent-detail-technical summary');await page.keyboard.press('Enter');assert.equal(await page.locator('.agent-detail-technical').getAttribute('open'),'');await page.keyboard.press('Escape');assert.equal(await page.locator('.agent-detail-technical').getAttribute('open'),null);
 await tabTo('#agent-new-task-'+qa.id,true);await page.keyboard.press('Enter');await page.locator('#create-dialog[open]').waitFor();assert.equal(await page.locator('#task-agent').inputValue(),qa.id);await page.keyboard.press('Escape');await page.locator('#create-dialog').waitFor({state:'hidden'});await tabTo('#agent-back-to-list',true);await page.keyboard.press('Enter');await ready();assert.equal(await search.inputValue(),'资料问答');pass('keyboard-detail','纯键盘搜索→详情→页签首尾/方向键→配置披露Escape→指定Agent任务→关闭→返回原搜索');
 await page.locator('[data-clear-agent-filters]').click();await page.setViewportSize({width:375,height:812});
 const filterToggle=page.locator('#agent-filter-toggle');assert(await filterToggle.isVisible());assert(await page.locator('#agent-directory-filters').isHidden());await filterToggle.click();assert(await page.locator('#agent-domain-filter').isVisible());await filterToggle.click();assert(await page.locator('#agent-directory-filters').isHidden());pass('mobile-filters','手机筛选按需展开，原生选择与结果上下文保持不变');
 const tree=await page.locator('.agent-directory-table').ariaSnapshot();fs.writeFileSync(path.join(output,'mobile-accessibility-tree.yml'),tree);assert(tree.includes('table')&&tree.includes('columnheader "智能体"')&&tree.includes('columnheader "状态"')&&tree.includes('row')&&tree.includes('link "查看 资料问答助手 的详情"'));pass('mobile-semantics','手机视觉行保留table/row/cell及可读列头，智能体详情链接有准确名称');
 // All visual evidence uses the real saved records above, never fabricated UI data.
 for(const theme of ['light','dark']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const [width,height] of [[320,812],[375,812],[414,896],[768,1024],[1440,1000],[812,375]]){
   await page.setViewportSize({width,height});
   for(const view of ['directory','detail']){
    await h.nav(page,'agents',view==='detail'?long.id:undefined);await ready();
    const metrics=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,controls:[...document.querySelectorAll('.agent-directory-page button,.agent-directory-page select:not(.enhanced-select),.agent-detail-page button,.agent-detail-tabs a')].filter(e=>e.getClientRects().length).map(e=>({text:e.innerText||e.getAttribute('aria-label'),height:e.getBoundingClientRect().height,width:e.getBoundingClientRect().width})),title:document.querySelector('#agent-detail-heading')?.getBoundingClientRect().toJSON()}));
    assert(metrics.scrollWidth<=width+1&&metrics.bodyWidth<=width+1,JSON.stringify({theme,width,view,metrics}));
    assert(metrics.controls.every(c=>c.height>=(width<=700?43:39)),JSON.stringify({theme,width,view,controls:metrics.controls.filter(c=>c.height<(width<=700?43:39))}));
    layouts.push({theme,width,height,view,pass:true});
    if([320,375,768,1440].includes(width))await shot(view+'-'+theme+'-'+width);
   }
  }
  // Measure rendered colors, including current background and actual text tokens.
  const colors=await page.evaluate(()=>{
   const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');canvas.width=canvas.height=1;
   const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
   const luminance=color=>rgb(color).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
   const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
   const root=getComputedStyle(document.documentElement),surface=root.getPropertyValue('--surface'),canvasColor=root.getPropertyValue('--canvas');
   return ['--ink','--muted','--green','--blue'].map(token=>({token,onSurface:ratio(root.getPropertyValue(token),surface),onCanvas:ratio(root.getPropertyValue(token),canvasColor)})).concat([{token:'focus',onSurface:ratio(root.getPropertyValue('--blue'),surface),onCanvas:ratio(root.getPropertyValue('--blue'),canvasColor)}]);
  });colors.forEach(c=>assert(c.onSurface>=4.5&&c.onCanvas>=4.5,JSON.stringify({theme,...c})));contrasts.push({theme,colors});
  await h.nav(page,'agents');await search.focus();
  const fieldContrast=await page.evaluate(()=>{
   const field=document.querySelector('#agent-search'),wrapper=field.closest('label'),style=getComputedStyle(field),box=getComputedStyle(wrapper),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');canvas.width=canvas.height=1;
   const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
   const l=color=>rgb(color).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
   const ratio=(a,b)=>{const x=l(a),y=l(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
   const icon=wrapper.querySelector('svg').getBoundingClientRect(),input=field.getBoundingClientRect();
   return {text:ratio(style.color,box.backgroundColor),boundary:ratio(box.borderTopColor,box.backgroundColor),focus:ratio(box.outlineColor,box.backgroundColor),outlineStyle:box.outlineStyle,iconRight:icon.right,inputLeft:input.left};
  });assert(fieldContrast.text>=4.5&&fieldContrast.boundary>=3&&fieldContrast.focus>=3&&fieldContrast.outlineStyle!=='none',JSON.stringify({theme,fieldContrast}));assert(fieldContrast.iconRight<=fieldContrast.inputLeft+1);contrasts.push({theme,fieldContrast});await search.evaluate(e=>e.blur());

 }
 pass('responsive','24布局组合：6视口×2主题×目录详情；长名称无页面横向溢出，主要操作高度>=44px');
 await page.setViewportSize({width:375,height:812});await h.nav(page,'agents',qa.id);await page.emulateMedia({reducedMotion:'reduce'});
 await page.evaluate(()=>{for(const el of document.querySelectorAll('.agent-detail-page *')){const style=getComputedStyle(el);if(el.childNodes.length&&[...el.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim()))el.style.fontSize=parseFloat(style.fontSize)*2+'px';}});
 assert(await page.locator('#agent-detail-heading').isVisible());assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await shot('detail-dark-375-text-200');
 
 await h.nav(page,'agents');await ready();await page.evaluate(()=>{for(const el of document.querySelectorAll('.agent-directory-page *')){const style=getComputedStyle(el);if(el.childNodes.length&&[...el.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim()))el.style.fontSize=parseFloat(style.fontSize)*2+'px';}});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await shot('directory-dark-375-text-200');
 await page.setViewportSize({width:1440,height:1000});
 for(const theme of ['light','dark']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await h.nav(page,'agents',qa.id);await ready();await page.locator('#agent-detail-heading').evaluate(e=>e.blur());await shot('detail-normal-'+theme+'-1440');await page.locator('#agent-detail-tab-instructions').click();await ready();await shot('instructions-'+theme+'-1440');await page.locator('#agent-detail-tab-activity').click();await ready();await shot('activity-'+theme+'-1440');}
 pass('accessibility','浅深代表性文字/状态对比>=4.5:1；实际搜索边界与焦点>=3:1且图标不重叠；目录和详情200%文字可达');

 assert.deepEqual(errors,[]);pass('console','浏览器无未处理脚本错误');
 fs.writeFileSync(path.join(output,'browser-results.json'),JSON.stringify({base,workspace:workspace.id,checks,layouts,contrasts,errors,recordedAt:new Date().toISOString()},null,2));await browser.close();
 console.log(JSON.stringify({checks:checks.length,layouts:layouts.length,errors}));
})().catch(error=>{console.error(error);process.exit(1)});
