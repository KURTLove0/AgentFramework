'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs');
const base=process.env.RUN_HISTORY_URL,out=process.env.RUN_HISTORY_OUTPUT;if(!base||!out)throw Error('Use the isolated history fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),checks=[],errors=[],writes=[],reads=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());if(r.method()==='GET'&&new URL(r.url()).pathname==='/api/runs')reads.push(r.url());});
 const config=JSON.parse(fs.readFileSync(path.join(out,'fixture.json'),'utf8')),pass=text=>{checks.push(text);console.log('PASS '+text);};
 const ready=async()=>{await page.waitForFunction(()=>state.view==='runs'&&!state.selected&&!state.busy&&state.runHistory?.data&&!state.runHistory.pending&&!state.runHistory.error&&state.runHistory.dataPath===runsRequest());await H.settled(page);};
 const ids=()=>page.locator('.run-list-panel tbody tr').evaluateAll(rows=>rows.map(row=>row.dataset.run));
 const query=()=>page.evaluate(()=>runHistoryQuery()),search=async text=>{await page.locator('#run-search').fill(text);await page.waitForFunction(text=>state.search===text&&!state.runHistory.pending&&!state.runHistory.error&&state.runHistory.dataPath===runsRequest(),text);};
 const detailReady=()=>page.waitForFunction(()=>state.selected&&state.detail&&!state.busy);
 try{
  process.env.AGENT_UI_BASE_URL=base;await page.goto(base+'?workspace_id='+config.workspace+'#/runs');await ready();
  const root=await page.evaluate(id=>api('/api/runs/'+id),config.roots[0]),agent=root.run.snapshot.agent_profile.id;
  await search('历史目标');await page.locator('#status-filter').selectOption('SUCCEEDED');await ready();await page.locator('#run-sort').selectOption('created_asc');await ready();await page.locator('#run-filters-toggle').click();
  await page.locator('#run-agent-filter').selectOption(agent);await ready();await page.locator('#run-domain-filter').selectOption('none');await ready();
  const dates=await page.evaluate(created=>{const format=d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');return {after:format(new Date((created-86400)*1000)),before:format(new Date((created+86400)*1000))};},root.run.created_at);
  await page.locator('#run-after').fill(dates.after);await page.locator('#run-after').dispatchEvent('change');await ready();await page.locator('#run-before').fill(dates.before);await page.locator('#run-before').dispatchEvent('change');await ready();
  for(let n=0;n<2;n++){await page.locator('[data-run-page=next]').click();await ready();}
  const original=await query(),third=await ids(),entry=await page.evaluate(()=>history.state.agentRunHistory),url=page.url(),beforeReads=reads.length;assert.equal(third.length,37);assert.equal(original.runCursorStack.length,2);
  await page.reload();await ready();assert.deepEqual(await query(),original);assert.deepEqual(await ids(),third);assert(await page.locator('#run-filter-panel').isVisible());assert(reads.length>beforeReads);assert.equal(page.url(),url);assert(!JSON.stringify(entry).includes('保留完整正文'));
  await page.screenshot({path:path.join(out,'restored-third-page.png'),animations:'disabled'});
  pass('刷新第三页恢复搜索、状态、智能体、领域、日期、排序和分页栈，并重新读取服务端结果');

  const pattern=base+'/api/runs?**';await page.route(pattern,route=>new URL(route.request().url()).searchParams.has('cursor')?route.fulfill({status:503,json:{error:'isolated restored page failure'}}):route.continue());
  await page.reload();await page.locator('.run-history-error').waitFor();assert.deepEqual(await query(),original);assert.equal((await ids()).length,0);await page.unroute(pattern);await page.locator('.run-history-error [data-run-history=retry]').click();await ready();assert.deepEqual(await ids(),third);
  pass('恢复后的分页读取失败保留原条件和页码，显式重试返回原页');

  await page.locator('.run-list-panel tbody tr').first().locator('.task-link').click();await detailReady();await page.reload();await detailReady();await page.goBack();await ready();assert.deepEqual(await query(),original);assert.deepEqual(await ids(),third);
  await page.locator('.run-list-panel tbody tr').first().locator('.task-link').click();await detailReady();await page.locator('#run-detail .agent-back-link').click();await ready();await search('历史目标-0012');const later=await query();assert.deepEqual(await ids(),['history-0012']);
  await page.goBack();await detailReady();await page.goBack();await ready();assert.deepEqual(await query(),original);assert.deepEqual(await ids(),third);
  await page.goForward();await detailReady();await page.goForward();await ready();assert.deepEqual(await query(),later);assert.deepEqual(await ids(),['history-0012']);
  pass('详情刷新后返回仍是原页，浏览器前进后退分别恢复各自列表条目的条件');

  await page.evaluate(()=>{window.historyReplaceOriginal=history.replaceState.bind(history);history.replaceState=(value,...args)=>{if(value?.agentRunHistory?.query?.search==='无法保留的条件')throw Error('isolated quota');return window.historyReplaceOriginal(value,...args);};});
  await search('无法保留的条件');assert((await page.locator('.run-history-status').innerText()).includes('未能保留列表条件'));assert.equal(await page.locator('#run-search').inputValue(),'无法保留的条件');
  await page.evaluate(()=>history.replaceState=window.historyReplaceOriginal);await page.locator('.run-list-heading [data-run-history=retry]').click();await ready();const persisted=await query();await page.reload();await ready();assert.deepEqual(await query(),persisted);
  pass('浏览器拒绝保存时明确提示，当前查询仍可用，恢复保存后刷新采用最新条件');

  await H.switchSpace(page,config.other_workspace);await H.nav(page,'runs');await ready();assert.equal(await page.locator('#run-search').inputValue(),'');assert.equal((await ids()).length,0);
  await page.goBack();await page.waitForFunction(()=>state.view==='workbench'&&!state.busy);await page.goBack();await ready();assert.equal(await page.evaluate(()=>state.workspaceId),config.workspace);assert.deepEqual(await query(),persisted);
  pass('切换空间从空条件开始，返回原空间恢复原历史条目，查询未写入 URL');

  await page.evaluate(()=>{const value=structuredClone(history.state);value.agentRunHistory.query.runAfter='2026-02-30';history.replaceState(value,'');});await page.reload();await ready();assert.equal(await page.locator('#run-search').inputValue(),'');assert.equal(await page.evaluate(()=>state.runCursor),null);assert((await page.locator('.run-history-status').innerText()).includes('上次列表条件无法恢复'));assert.equal((await ids()).length,50);
  await search('历史目标-0008');assert.deepEqual(await ids(),['history-0008']);assert(!(await page.locator('.run-history-status').innerText()).includes('无法恢复'));
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);pass('损坏的保存条件不会发起无效查询，新选条件会清除恢复提示；所有操作均为只读');
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,writes,read_count:reads.length,restored_query:original,original_ids:third,later_query:later,entry_format:entry.version,url_unchanged:true},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
