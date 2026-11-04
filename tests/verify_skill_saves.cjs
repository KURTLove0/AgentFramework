'use strict';
// Real UI and server, synthetic files, two pages sharing one disposable service.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.SKILL_SAVE_URL;if(!base)throw Error('Set SKILL_SAVE_URL to the isolated fixture.');
const output=process.env.SKILL_SAVE_OUTPUT||'/private/tmp/skill-saves';fs.mkdirSync(output,{recursive:true});
const content=(body,name='save-recovery-method')=>'---\nname: '+name+'\ndescription: 保存恢复验收\n---\n\n'+body+'\n';
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),a=await context.newPage(),b=await context.newPage();
 const checks=[],errors=[],posts=[],layouts=[];
 for(const page of [a,b]){page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);}
 a.on('request',request=>{if(request.method()==='POST'&&/^\/api\/skills(?:\/skill-[^/]+)?$/.test(new URL(request.url()).pathname))posts.push(request.postDataJSON());});
 const call=(page,url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const shot=async name=>{await a.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await a.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});};
 const post=async(url,action)=>{const [response]=await Promise.all([a.waitForResponse(r=>new URL(r.url()).pathname===url&&r.request().method()==='POST'),action()]);return response;};
 const selectRoot=async()=>{await a.locator('[data-skill-file="SKILL.md"]').click();};
 async function lose(url){
  let accepted=null;
  const intercept=async route=>{if(route.request().method()==='POST'&&!accepted){const response=await route.fetch();assert(response.ok(),await response.text());accepted=await response.json();await route.abort('connectionreset');}else await route.continue();};
  await a.route('**'+url,intercept);await a.locator('#skill-save').click();await a.locator('#skill-editor-error').waitFor();await a.waitForFunction(()=>!skillEditor.saving);await a.unroute('**'+url,intercept);assert(accepted);return accepted;
 }
 async function editElsewhere(id,body){const latest=await call(b,'/api/skills/'+id),files=Object.fromEntries(Object.entries(latest.package.files).map(([p,v])=>[p,{encoding:v.encoding,content:v.content}]));files['SKILL.md'].content=content(body);return call(b,'/api/skills/'+id,{folder:latest.name,revision:latest.revision,files});}
 const review=async()=>{await a.getByRole('button',{name:'核对保存结果或当前版本',exact:true}).focus();await a.keyboard.press('Enter');await a.waitForFunction(()=>!skillEditor.reviewing);};
 try{
  await a.evaluate(()=>navigate('skills'));await a.waitForFunction(()=>state.view==='skills'&&!state.busy);await a.locator('[data-skill-new]').click();
  await a.locator('#skill-folder').fill('save-recovery-method');await a.locator('#skill-file-content').fill(content('第一次提交的原方法'));
  const files=[{name:'sample.bin',mimeType:'application/octet-stream',buffer:Buffer.from([0,255,128])},...Array.from({length:6},(_,i)=>({name:'source-'+i+'-'+('a'.repeat(90))+'.txt',mimeType:'text/plain',buffer:Buffer.from('合成资料 '+i)}))];
  await a.locator('#skill-resource-upload').setInputFiles(files);await a.waitForFunction(()=>Object.keys(skillEditor.files).length===8);await selectRoot();assert((await a.locator('#skill-file-content').inputValue()).includes('第一次提交的原方法'));
  const first=await lose('/api/skills');assert(first.package.files['SKILL.md'].content.includes('第一次提交的原方法'));assert.equal((await call(b,'/api/skills')).skills.filter(s=>!s.builtin).length,1);
  const response=await post('/api/skills',()=>a.locator('#skill-save').click()),replayed=await response.json();assert(response.ok());
  await a.waitForFunction(()=>!skillEditor.saving&&!skillEditor.dirty);assert.equal(replayed.id,first.id);assert(replayed.save_receipt.replayed);assert.deepEqual(posts[0],posts[1]);
  assert.equal((await call(b,'/api/skills/'+first.id)).versions.length,1);assert.equal(replayed.package.files['assets/sample.bin'].content,'AP+A');
  pass('创建已接受但响应丢失后，同一编号重试返回原技能与版本，二进制和文本资源完整保留');

  const id=first.id;await a.locator('#skill-file-content').fill(content('第二次提交，随后回执丢失'));const second=await lose('/api/skills/'+id);assert.equal(second.version,2);
  await a.locator('#skill-file-content').fill(content('本页继续编辑、需要保留的内容'));const before=posts.length;await a.locator('#skill-save').click();assert.equal(posts.length,before);
  let release,entered;const waiting=new Promise(resolve=>entered=resolve);
  const intercept=async route=>{entered();await new Promise(resolve=>release=resolve);await route.continue();};await a.route('**/api/skill-saves/*',intercept);
  await a.getByRole('button',{name:'核对保存结果或当前版本',exact:true}).focus();await a.keyboard.press('Enter');await waiting;
  assert.equal(await a.evaluate(()=>document.activeElement.id),'skill-save-recovery');
  await a.locator('#skill-file-content').fill(content('核对期间继续编辑的内容'));const local=await a.locator('#skill-file-content').inputValue();assert(local.includes('核对期间继续编辑'));
  release();await a.waitForFunction(()=>!skillEditor.reviewing);await a.unroute('**/api/skill-saves/*',intercept);
  await a.locator('#skill-save-recovery').getByText('已找到保存回执 · v2',{exact:true}).waitFor();assert.equal(await a.locator('#skill-file-content').inputValue(),local);
  assert.equal(await a.evaluate(()=>document.activeElement.id),'skill-file-content');assert(await a.locator('#skill-save').isDisabled());
  pass('回执未知后继续编辑不自动提交新版本，核对期间可输入，结果返回保留本页文本和焦点');

  const space=await call(b,'/api/workspaces',{name:'保存恢复其他空间',business:'测试',scenario:'空间保护',description:'',revision:0});
  const oldSpace=await a.evaluate(()=>state.workspaceId);await a.evaluate(async id=>{await loadWorkspaces();await switchWorkspace(id);},space.id);assert.equal(await a.evaluate(()=>state.workspaceId),oldSpace);assert.equal(await a.locator('#skill-file-content').inputValue(),local);
  const notice=a.locator('#skill-editor-dialog .toast-dismiss');if(await notice.isVisible())await notice.click();
  await editElsewhere(id,'另一页面在核对后保存的第三版');
  let result=await post('/api/skills/'+id,()=>a.getByRole('button',{name:'按所示版本保存本页文件',exact:true}).click());assert.equal(result.status(),409);
  assert.equal(await a.locator('#skill-file-content').inputValue(),local);assert.equal((await call(b,'/api/skills/'+id)).version,3);
  await review();await a.locator('#skill-save-recovery').getByText('当前技能包 · v3 · 草稿',{exact:true}).waitFor();
  assert(await a.getByRole('button',{name:'核对保存结果或当前版本',exact:true}).evaluate(e=>e===document.activeElement));
  await a.locator('#skill-save-recovery details summary').first().click();const list=a.locator('#skill-save-recovery [aria-label="文件差异"]').first();assert(await list.evaluate(e=>e.scrollHeight>e.clientHeight));await list.focus();await a.keyboard.press('End');await a.waitForFunction(()=>document.activeElement.matches('#skill-save-recovery ul')&&document.activeElement.scrollTop>0);
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const zoom of [1,2]){
   await a.setViewportSize({width,height:1000});await a.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   if(zoom===2)await a.evaluate(()=>{window.__skillZoom=[...document.querySelectorAll('#skill-editor-dialog,#skill-editor-dialog *')].map(e=>[e,e.style.getPropertyValue('font-size'),e.style.getPropertyPriority('font-size'),parseFloat(getComputedStyle(e).fontSize)]);for(const[e,,,size]of window.__skillZoom)e.style.setProperty('font-size',size*2+'px','important');});
   await a.locator('#skill-save-recovery').scrollIntoViewIfNeeded();const dialog=await a.locator('#skill-editor-dialog').boundingBox(),button=await a.locator('#skill-save').boundingBox();
   assert(button&&button.y>=0&&button.y+button.height<=1001);assert(button.y+button.height<=dialog.y+dialog.height+1);
   assert(await a.locator('#skill-editor-dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1));assert(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   layouts.push({theme,width,textScale:zoom});if(width===1440&&zoom===1)await shot('recovery-'+theme);
   if(zoom===2)await a.evaluate(()=>{for(const[e,size,priority]of window.__skillZoom){if(size)e.style.setProperty('font-size',size,priority);else e.style.removeProperty('font-size');}});
  }
  result=await post('/api/skills/'+id,()=>a.getByRole('button',{name:'按所示版本保存本页文件',exact:true}).click());assert.equal(result.status(),200);await a.waitForFunction(()=>!skillEditor.saving&&!skillEditor.dirty);
  let saved=await call(b,'/api/skills/'+id);assert.equal(saved.version,4);assert.equal(saved.package.files['SKILL.md'].content,local);assert.equal(saved.package.files['assets/sample.bin'].content,'AP+A');
  assert.notEqual(posts.at(-1).request_id,posts.at(-2).request_id);
  pass('核对后其他页面再修改仍返回冲突；重新核对并明确保存后生成新版本，空间切换和桌面文字放大不丢文件');

  await a.locator('#skill-file-content').fill(content('归档前已经接受的一版'));const fifth=await lose('/api/skills/'+id);
  await call(b,'/api/skills/'+id+'/archive',{revision:fifth.revision,version:fifth.version});await a.locator('#skill-file-content').fill(content('归档后仍需保留的本页方法'));
  await review();await a.locator('#skill-save-recovery').getByText(/当前技能包.*已归档/).waitFor();assert.equal(await a.locator('[data-skill-save-keep]').count(),0);assert(await a.locator('#skill-save').isDisabled());
  await a.getByRole('button',{name:'将本页文件另存为新包',exact:true}).click();assert.equal(await a.locator('#skill-folder').inputValue(),'save-recovery-method-copy');
  result=await post('/api/skills',()=>a.locator('#skill-save').click());const copy=await result.json();assert(result.ok());await a.waitForFunction(()=>!skillEditor.saving&&!skillEditor.dirty);
  assert.notEqual(copy.id,id);assert(copy.package.files['SKILL.md'].content.includes('归档后仍需保留'));assert.equal(copy.package.files['assets/sample.bin'].content,'AP+A');assert((await call(b,'/api/skills/'+id)).archived);
  pass('归档后的原技能保持归档，当前文件可明确另存新包，未丢失二进制资源或后续修改');

  await a.locator('#skill-editor-dialog [data-close]').first().click();await a.locator('[data-skill-new]').click();await a.locator('#skill-folder').fill('unaccepted-recovery-method');await a.locator('#skill-file-content').fill(content('服务未接受的原内容','unaccepted-recovery-method'));
  const unavailable=async route=>route.request().method()==='POST'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试服务未接受此次保存'})}):route.continue();
  await a.route('**/api/skills',unavailable);await a.locator('#skill-save').click();await a.locator('#skill-editor-error').waitFor();await a.waitForFunction(()=>!skillEditor.saving);await a.unroute('**/api/skills',unavailable);
  await a.locator('#skill-file-content').fill(content('未接受后本页继续编辑的新内容','unaccepted-recovery-method'));const updated=await a.locator('#skill-file-content').inputValue();
  result=await post('/api/skills',()=>a.getByRole('button',{name:'重试原保存，保留本页文件',exact:true}).click());const original=await result.json();assert(original.package.files['SKILL.md'].content.includes('服务未接受的原内容'));assert.equal(await a.locator('#skill-file-content').inputValue(),updated);
  await a.locator('#skill-save-recovery').getByText('已找到保存回执 · v1',{exact:true}).waitFor();
  result=await post('/api/skills/'+original.id,()=>a.getByRole('button',{name:'按所示版本保存本页文件',exact:true}).click());saved=await result.json();assert.equal(saved.version,2);assert.equal(saved.package.files['SKILL.md'].content,updated);
  assert.equal((await call(b,'/api/skills/'+original.id)).versions.length,2);
  pass('原保存实际未接受时，可用原编号确认原内容，再明确保存保留的新内容，没有静默重复版本');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts,originalSkill:id,copySkill:copy.id},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await a.locator('body').innerText()},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
