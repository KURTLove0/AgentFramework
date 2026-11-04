'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.WORKSPACE_HISTORY_URL,output=process.env.WORKSPACE_HISTORY_OUTPUT;if(!base||!output)throw Error('Set isolated workspace history URL and output.');
const fixture=JSON.parse(fs.readFileSync(path.join(output,'fixture.json'),'utf8'));
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[];
 page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const call=url=>page.evaluate(url=>api(url),url);
 try{
  const a=fixture.spaces.find(w=>w.project_id==='project-history-a'),b=fixture.spaces.find(w=>w.project_id==='project-history-b');
  await page.goto(base+'#/workspaces');await page.waitForFunction(()=>state.connected&&!state.busy&&state.view==='workspaces');
  assert.equal(new URL(page.url()).searchParams.get('workspace_id'),a.id);assert.equal(await page.evaluate(()=>state.meta.workspace.name),'用户已命名的历史交易空间');assert.equal(await page.evaluate(()=>state.meta.workspace.revision),2);
  const directory=(await call('/api/workspaces')).workspaces;assert.equal(directory.length,3);assert(directory.find(w=>w.id==='workspace-default').deleted);assert(directory.find(w=>w.id===b.id).deleted);
  pass('历史 CLI 项目在启动时可达，重启保留用户名称与修订号，默认空间和另一个历史空间继续保持删除状态');

  await page.evaluate(()=>navigate('runs'));await page.waitForFunction(()=>state.connected&&!state.busy&&state.view==='runs');
  const expected=fixture.runs.filter(run=>run.project==='project-history-a'),history=await call('/api/runs');assert.deepEqual(history.runs.map(r=>r.run_id).sort(),expected.map(r=>r.id).sort());assert.equal(history.counts.total,2);
  await page.locator('[data-run="'+expected[0].id+'"]').first().click();await page.waitForFunction(id=>state.detail?.run?.run_id===id,expected[0].id);
  const detail=await call('/api/runs/'+expected[0].id);assert.equal(detail.run.snapshot.hash,expected[0].snapshot_hash);assert.equal(detail.run.task.goal,expected[0].goal);assert.equal(detail.run.status,'SUCCEEDED');
  pass('从实际历史列表打开原任务，项目隔离、已完成结果和冻结快照保持一致');

  await page.evaluate(()=>navigate('workspaces'));await page.waitForFunction(()=>state.connected&&!state.busy&&state.view==='workspaces');
  await page.locator('details.workspace-archive summary').click();await page.getByRole('button',{name:'恢复 '+b.name,exact:true}).click();await page.waitForFunction(id=>state.workspaces.some(w=>w.id===id&&!w.deleted),b.id);
  await page.locator('#workspace-card-'+b.id+' [data-switch-workspace]').click();await page.waitForURL(url=>url.searchParams.get('workspace_id')===b.id);await page.waitForFunction(()=>state.connected&&!state.busy);
  const other=(await call('/api/runs')).runs,expectedB=fixture.runs.filter(run=>run.project==='project-history-b');assert.deepEqual(other.map(r=>r.run_id),expectedB.map(r=>r.id));assert.equal(await page.evaluate(()=>state.meta.workspace.project_id),'project-history-b');
  const stored=await call('/api/runs/'+expectedB[0].id);assert.equal(stored.run.snapshot.hash,expectedB[0].snapshot_hash);assert.equal(stored.run.status,'SUCCEEDED');
  await page.evaluate(()=>navigate('runs'));await page.waitForFunction(()=>state.connected&&!state.busy&&state.view==='runs');await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await page.screenshot({path:path.join(output,'historical-project-runs.png'),fullPage:true,animations:'disabled'});
  pass('显式恢复历史空间并从卡片进入后，仅显示对应项目的原任务，冻结结果保持可读');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,projects:2,runs:fixture.runs.length},null,2));
 }catch(error){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
