'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs');
const base=process.env.TASK_TEXT_SEARCH_URL,out=process.env.TASK_TEXT_SEARCH_OUTPUT;if(!base||!out)throw Error('Use isolated search fixture');fs.mkdirSync(out,{recursive:true});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),page=await context.newPage(),checks=[],errors=[],posts=[],layouts=[];
 const config=JSON.parse(fs.readFileSync(path.join(out,'fixture.json'),'utf8')),roots=config.roots,pass=text=>{checks.push(text);console.log('PASS '+text);};let release;
 page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});
 const ready=async()=>{await page.waitForFunction(()=>state.view==='runs'&&!state.selected&&state.runHistory&&!state.runHistory.pending&&!state.runHistory.error&&state.runHistory.dataPath===runsRequest());await H.settled(page);};
 const search=async text=>{await page.locator('#run-search').fill(text);await page.waitForFunction(text=>state.search===text&&!state.runHistory.pending&&!state.runHistory.timer&&!state.runHistory.error&&state.runHistory.dataPath===runsRequest(),text);await H.settled(page);};
 const detail=async(id,turn,role)=>{await page.waitForFunction(({id,turn,role})=>state.detail?.conversation?.id===id&&location.hash.endsWith('/turn/'+turn+'/'+role)&&document.activeElement?.id==='chat-turn-'+turn,{id,turn,role});await H.settled(page);};
 const openCommand=async query=>{await page.locator('[data-action="command"]').first().click();await page.locator('#command-input').fill(query);await page.waitForFunction(query=>state.commandSession?.query===query&&Object.values(state.commandSession.sources).every(s=>!s.pending&&!s.error),query);await H.settled(page);};
 try{
  await page.goto(base+'/?workspace='+config.workspace+'#/runs');await ready();await search('青禾项目');assert.equal(await page.evaluate(()=>state.runPage.filtered_total),104);assert.equal(await page.locator('tr[data-run]').count(),50);assert.equal(await page.locator('[data-run-text-match]').count(),50);
  const target=roots.at(-1);await H.nav(page,'runs',target);await page.waitForFunction(id=>state.detail?.conversation?.id===id,target);await page.locator('#task-chat-input').fill('返回搜索后仍保留的草稿');await H.nav(page,'runs');await ready();
  const match=page.locator('[data-run-text-match="'+target+'"]');assert.match(await match.innerText(),/第 3 轮 · 智能体回复/);assert(!(await page.locator('tr[data-run="'+target+'"] .task-link').innerText()).includes('青禾项目'));await match.focus();await page.keyboard.press('Enter');await detail(target,3,'assistant');
  assert.equal(await page.locator('#task-chat-input').inputValue(),'返回搜索后仍保留的草稿');assert.match(await page.locator('#task-search-status').innerText(),/第 3 轮 · 智能体回复/);assert.equal(await page.locator('#task-search-input').inputValue(),'青禾项目');
  await page.reload();await detail(target,3,'assistant');assert.equal(await page.locator('#task-chat-input').inputValue(),'返回搜索后仍保留的草稿');assert.equal(await page.locator('#task-search-panel').isVisible(),false);await page.goBack();await ready();assert.equal(await page.locator('#run-search').inputValue(),'青禾项目');
  pass('标题未命中时仍找到后续回复；键盘打开精确轮次并高亮，刷新保留轮次定位，返回恢复搜索条件与草稿');
  const found=[];for(let n=0;n<3;n++){found.push(...await page.locator('tr[data-run]').evaluateAll(rows=>rows.map(row=>row.dataset.run)));if(n<2){await page.locator('[data-run-page="next"]').click();await ready();}}
  assert.deepEqual(found,[...roots.slice(1)].reverse());assert(await page.locator('[data-run-page="next"]').isDisabled());
  await page.locator('#run-favorites-filter').click();await ready();assert.deepEqual(await page.locator('tr[data-run]').evaluateAll(rows=>rows.map(row=>row.dataset.run)),[roots[1]]);
  await openCommand('青禾项目');const all=page.getByRole('option',{name:/查看全部 105 条匹配运行/});for(let n=0;n<8&&!await all.isVisible();n++)await page.locator('#command-next').click();await all.click();await ready();assert.equal(await page.evaluate(()=>state.runFavorites),'all');assert.equal(await page.evaluate(()=>state.runVisibility),'all');assert.equal(await page.evaluate(()=>state.runPage.filtered_total),105);
  pass('104 条正文匹配可完整翻过三页；收藏和归档筛选有效，全局查看全部清除旧收藏条件并纳入归档匹配');

  await openCommand('只在追加要求');assert.match(await page.locator('#command-results').innerText(),/第 4 轮 · 你的要求/);await page.locator('#command-results [data-command]').first().click();await detail(roots[2],4,'user');assert.match(await page.locator('#task-search-status').innerText(),/第 4 轮 · 你的要求/);
  await page.evaluate(async id=>api('/api/tasks/'+id+'/messages/4/edit',{content:'修改后仅此页 ALBATROSS，保留蓝色封面','revision':0,'request_id':'search-edit'}),roots[2]);await H.nav(page,'runs');await ready();await search('只在追加要求');assert.equal(await page.locator('tr[data-run]').count(),0);await search('修改后仅此页');assert.deepEqual(await page.locator('tr[data-run]').evaluateAll(rows=>rows.map(row=>row.dataset.run)),[roots[2]]);
  pass('全局搜索可直接定位排队要求；消息修改后旧词不再匹配，新词立即可检索');

  await search('TOPAZ-[a+b]%_');assert.equal(await page.evaluate(()=>state.runPage.filtered_total),105);assert.equal(await page.locator('.run-text-match img').count(),0);
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.textSearchScale=scale;if(!window.textSearchFontRule){document.styleSheets[0].insertRule('html[data-text-search-scale="2"] :is(.run-text-match,.run-text-match span,#run-search){font-size:28px!important}',0);window.textSearchFontRule=true;}},{theme,scale});
   const bounds=await page.locator('.run-text-match').first().evaluate(el=>{el.scrollIntoView({block:'center'});el.focus();const r=el.getBoundingClientRect(),text=el.querySelector('.run-text-excerpt');return {root:document.documentElement.scrollWidth,width:innerWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,font:parseFloat(getComputedStyle(text).fontSize),focused:document.activeElement===el,textWidth:text.clientWidth,textScroll:text.scrollWidth,mark:(()=>{const m=el.querySelector('mark').getBoundingClientRect();return {top:m.top,bottom:m.bottom,left:m.left,right:m.right};})()};});assert(bounds.focused&&bounds.root<=width+1&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1100,JSON.stringify(bounds));assert(bounds.textScroll<=bounds.textWidth+1,JSON.stringify(bounds));assert(bounds.mark.top>=bounds.top&&bounds.mark.bottom<=bounds.bottom&&bounds.mark.top>=0&&bounds.mark.bottom<=1100,JSON.stringify(bounds));if(scale===2)assert.equal(bounds.font,28);layouts.push({theme,width,scale,bounds});
   if(width===1440&&scale===1)await page.screenshot({path:path.join(out,'task-text-search-'+theme+'.png'),animations:'disabled'});
  }
  pass('符号按字面查找、命中片段按纯文本显示；八种主题、窗口和字号布局通过焦点、控件边界与正文溢出检查');

  await page.setViewportSize({width:1440,height:1100});await page.evaluate(()=>document.documentElement.dataset.textSearchScale=1);const entered=deferred(),go=deferred(),done=deferred();release=go.resolve;const pattern=base+'/api/runs?**';let held=false;
  await page.route(pattern,async route=>{if(!held&&new URL(route.request().url()).searchParams.get('search')==='青禾项目'){held=true;const response=await route.fetch();entered.resolve();await go.promise;await route.fulfill({response});done.resolve();return;}return route.continue();});
  await page.locator('#run-search').fill('青禾项目');await entered.promise;await search('修改后仅此页');go.resolve();await done.promise;await page.unroute(pattern);release=null;await H.settled(page);assert.deepEqual(await page.locator('tr[data-run]').evaluateAll(rows=>rows.map(row=>row.dataset.run)),[roots[2]]);
  await H.switchSpace(page,config.other_workspace);await H.nav(page,'runs');await ready();assert.equal(await page.locator('#run-search').inputValue(),'');await search('青禾项目');assert.equal(await page.locator('tr[data-run]').count(),0);
  assert.deepEqual(posts,['/api/tasks/'+roots[2]+'/messages/4/edit']);assert.deepEqual(errors,[]);pass('迟到的旧正文搜索不覆盖新查询；切换空间清空私有查询，搜索和定位本身没有写请求');
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,posts,layouts},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{release?.();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
