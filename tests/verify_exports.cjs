'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),{chromium}=require('playwright');
const base=process.env.EXPORT_URL;if(!base)throw Error('Set EXPORT_URL.');
const output=process.env.EXPORT_OUTPUT||'/private/tmp/run-exports';fs.mkdirSync(output,{recursive:true});
const verify=file=>{const result=spawnSync(process.env.AGENT_TEST_PYTHON||'python3',['-m','agent_framework','verify-export',file],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout).manifest;};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[];
 page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const shot=async name=>{await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);
  const agent=await call('/api/agents',{name:'导出验收助手',description:'验证结果与记录导出',runtime:'mock',model:'builtin',options:{},prompt:'直接按目标交付。',skills:[],mcp_servers:[],revision:0});
  const created=await call('/api/tasks',{goal:'整理可追溯的任务交付内容',agent_id:agent.id,agent_revision:1,request_id:'export-check'}),root=created.run.run_id;
  await page.goto(base+'#/workbench/'+root);await page.waitForFunction(()=>state.detail?.conversation?.status==='SUCCEEDED');await page.locator('#task-chat-input').fill('尚未发送的后续要求');
  await page.locator('.chat-answer-actions [data-chat-inspect-run]').click();const dialog=page.locator('#task-chat-run-dialog');await dialog.waitFor();
  let downloading=page.waitForEvent('download');await dialog.getByRole('link',{name:'下载本轮记录包',exact:true}).click();let download=await downloading;const first=path.join(output,'completed.zip');await download.saveAs(first);let manifest=verify(first);
  assert.equal(manifest.snapshot.run_id,root);assert.equal(manifest.snapshot.status,'SUCCEEDED');assert(manifest.files['report.md']);assert(manifest.files['evidence.json']);assert(manifest.files['context-manifests.json']);pass('本轮运行记录可下载经过校验的完整 ZIP，包含结果、事件、报告、证据与上下文清单');
  for(const [theme,width]of [['light',1440],['dark',1024]]){await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);assert(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)));await shot('export-inspector-'+theme);}
  await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();assert.equal(await page.locator('#task-chat-input').inputValue(),'尚未发送的后续要求');
  await page.locator('[data-chat-properties]').click();downloading=page.waitForEvent('download');await page.locator('#task-thread-properties').getByRole('link',{name:'导出完整对话',exact:true}).click();download=await downloading;const markdown=path.join(output,'conversation.md');await download.saveAs(markdown);const text=fs.readFileSync(markdown,'utf8');assert(text.includes('任务状态：SUCCEEDED'));assert(text.includes('本轮状态：SUCCEEDED'));assert(text.includes('整理可追溯的任务交付内容'));assert(text.includes('导出时间：'));pass('完整对话导出包含实际状态和快照时间，下载后继续保留输入草稿');
  const json=await call('/api/tasks/'+root+'/export?kind=json');assert.equal(json.export_snapshot.revision,json.revision);assert.equal(json.turns.length,1);

  const waiting=await call('/api/runs',{start:false,execution_mode:'direct',goal:'尚未执行的任务'});await call('/api/runs/'+waiting.run.run_id+'/cancel',{});
  await page.goto(base+'#/workbench/'+waiting.run.run_id);await page.waitForFunction(()=>state.detail?.conversation?.status==='CANCELLED');await page.locator('[data-chat-properties]').click();await page.locator('#task-thread-properties [data-chat-inspect-run]').click();await dialog.waitFor();
  downloading=page.waitForEvent('download');await dialog.getByRole('link',{name:'下载本轮记录包',exact:true}).click();download=await downloading;const stopped=path.join(output,'stopped.zip');await download.saveAs(stopped);manifest=verify(stopped);assert.equal(manifest.snapshot.status,'CANCELLED');assert(!manifest.files['report.md']);
  const stoppedText=await page.evaluate(async identity=>{const response=await fetch('/api/tasks/'+identity+'/export?kind=markdown&workspace_id='+encodeURIComponent(state.workspaceId));return response.text();},waiting.run.run_id);
  assert(stoppedText.includes('本轮未完成'));assert(stoppedText.includes('CANCELLED'));pass('停止任务的记录包保留真实终态且不混入旧报告，对话明确标注未完成');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,run:root},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
