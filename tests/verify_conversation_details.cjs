'use strict';
// Measures real controls in a disposable service; records defects before fixes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.PROJECT_REVIEW_URL;if(!base)throw Error('Use an isolated fixture.');
const output=process.env.PROJECT_REVIEW_OUTPUT||'/private/tmp/conversation-details';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
 const records=[],probes=[],issues=[],errors=[];page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const shot=name=>page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});
 const probe=async(surface,theme)=>{
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.waitForTimeout(180);
  const selector=surface==='task'?'#task-chat-input':'#flow-chat-message',field=page.locator(selector),original=await field.inputValue();
  await page.setViewportSize({width:1280,height:720});await field.fill(Array(30).fill('长输入应可滚动查看，发送操作保持可见。').join('\n'));
  const data=await field.evaluate(input=>{
   const form=input.closest('form'),button=form.querySelector('[type=submit]'),label=form.querySelector('label[for="'+input.id+'"]');
   const bounds=()=>{const r=input.getBoundingClientRect();return [r.x,r.y,r.width,r.height];};
   const before=bounds();input.focus();const focused=bounds();const invalid=input.getAttribute('aria-invalid');input.setAttribute('aria-invalid','true');const error=bounds();if(invalid===null)input.removeAttribute('aria-invalid');else input.setAttribute('aria-invalid',invalid);
   const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
   const rgba=value=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
   const luminance=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
   const contrast=e=>{const fg=rgba(getComputedStyle(e).color);let bg;for(let n=e;n;n=n.parentElement){const c=rgba(getComputedStyle(n).backgroundColor);if(c[3]>250){bg=c;break;}}if(!bg)return null;const a=luminance(fg),b=luminance(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
   const r=button.getBoundingClientRect();input.scrollTop=input.scrollHeight;
   const picker=document.querySelector('#flow-chat-agent-picker');
   return {before,focused,error,inputHeight:input.clientHeight,longInputReachable:input.scrollTop+input.clientHeight>=input.scrollHeight-2,sendVisible:r.bottom<=innerHeight&&button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),contrast:{input:contrast(input),label:contrast(label),send:contrast(button),...(picker?{currentAgent:contrast(picker)}:{})}};
  });
  probes.push({surface,theme,...data});
  if(JSON.stringify(data.before)!==JSON.stringify(data.focused)||JSON.stringify(data.before)!==JSON.stringify(data.error))issues.push({surface,issue:'focus-or-error-shift'});
  if(data.inputHeight>180||!data.longInputReachable||!data.sendVisible)issues.push({surface,issue:'long-input-access'});
  if(Object.values(data.contrast).some(value=>value===null||value<4.5))issues.push({surface,issue:'text-contrast',actual:data.contrast});
  await field.fill(original);
 };
 const measure=async(surface,theme,width,height)=>{
  await page.setViewportSize({width,height});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.waitForTimeout(180);
  const data=await page.evaluate(surface=>{
   const root=document.querySelector(surface==='task'?'.task-conversation-page':'#flow-chat-dialog'),input=root.querySelector('textarea'),form=input.closest('form'),label=root.querySelector('label[for="'+input.id+'"]'),button=form.querySelector('[type=submit]');
   const style=getComputedStyle(input),r=input.getBoundingClientRect(),br=button.getBoundingClientRect(),labelRect=label.getBoundingClientRect();
   const action=root.querySelector('[data-adopt-flow]'),ar=action?.getBoundingClientRect(),proposal=root.querySelector('#flow-chat-proposal');
   const visible=e=>{const b=e.getBoundingClientRect();return b.height>0&&b.bottom<=innerHeight+1&&b.top>=0&&e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));};
   const picker=root.querySelector('#flow-chat-agent')?.nextElementSibling?.querySelector('.select-trigger')||root.querySelector('.flow-chat-agent-bar .select-trigger');
   const selected=picker?.querySelector('span');
   return {input:{font:parseFloat(style.fontSize),line:parseFloat(style.lineHeight),padding:style.padding,border:style.borderWidth,height:r.height,width:r.width,alignment:Math.abs(labelRect.left-r.left-parseFloat(style.paddingLeft)-parseFloat(style.borderLeftWidth)),client:input.clientHeight,scroll:input.scrollHeight},button:{font:parseFloat(getComputedStyle(button).fontSize),height:br.height,visible:visible(button)},rootOverflow:root.scrollWidth>root.clientWidth+1,pageOverflow:document.documentElement.scrollWidth>innerWidth,proposalAction:action?{visible:visible(action),top:ar.top,bottom:ar.bottom}:null,proposal:proposal?{client:proposal.clientHeight,scroll:proposal.scrollHeight}:null,selection:selected?{text:selected.textContent,clipped:selected.scrollWidth>selected.clientWidth+1,title:picker.title}:null,bodyFonts:[...root.querySelectorAll('.task-chat-answer,.task-chat-answer p,.task-chat-answer pre code,.task-chat-answer h3,.task-chat-answer h4,.task-chat-answer h5,.chat-message p')].map(e=>({tag:e.tagName,font:parseFloat(getComputedStyle(e).fontSize),line:parseFloat(getComputedStyle(e).lineHeight)}))};
  },surface);
  const record={surface,theme,width,height,...data};records.push(record);
  if(data.input.alignment>2)issues.push({surface,theme,width,height,issue:'input-label-alignment',actual:data.input.alignment});
  if(Math.abs(data.input.height-64)>1)issues.push({surface,theme,width,height,issue:'default-input-height',actual:data.input.height});
  if(data.button.font!==14)issues.push({surface,theme,width,height,issue:'send-font',actual:data.button.font});
  if(Math.abs(data.button.height-40)>1)issues.push({surface,theme,width,height,issue:'send-height',actual:data.button.height});
  const headings=data.bodyFonts.filter(f=>['H3','H4','H5'].includes(f.tag));
  if(headings.some(f=>f.font!=={H3:18,H4:16,H5:14}[f.tag]))issues.push({surface,theme,width,height,issue:'heading-hierarchy',actual:headings});
  if(!data.button.visible||data.rootOverflow||data.pageOverflow)issues.push({surface,theme,width,height,issue:'composer-or-overflow'});
  if(data.selection?.clipped)issues.push({surface,theme,width,height,issue:'selected-agent-clipped',text:data.selection.text});
  if(data.proposalAction&&!data.proposalAction.visible)issues.push({surface,theme,width,height,issue:'proposal-action-below-fold'});
  if(width===1440||height===720)await shot(surface+'-'+theme+'-'+width+'x'+height);
 };
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected);
  const definition=(await call('/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;
  const agent=await call('/api/agents',{name:'研究与报告协作助手',description:'细节评审专用临时智能体',runtime:'codex',model:'review-model',options:{timeout:15,max_attempts:1,reasoning_effort:'low'},prompt:'依据任务目标交付可核验的结果。',skills:[],mcp_servers:[],definition,revision:0});
  await page.evaluate(id=>newTask({agentId:id}),agent.id);await page.locator('#task-goal').fill('细节排版验收：整理会议纪要，列出已确认事项和下一步行动。');await page.locator('#create-form [type=submit]').click();await page.waitForFunction(()=>state.detail?.conversation?.status==='SUCCEEDED');
  await page.locator('#task-chat-input').fill('请将行动清单按优先级整理。');
  for(const theme of ['light','dark'])for(const size of [{width:1024,height:1000},{width:1280,height:720},{width:1440,height:1000},{width:1920,height:1000}])await measure('task',theme,size.width,size.height);
  for(const theme of ['light','dark'])await probe('task',theme);
  await page.evaluate(()=>navigate('workflows'));await page.waitForFunction(()=>state.view==='workflows'&&!state.busy);await page.locator('[data-flow-chat]').first().click();await page.locator('#flow-chat-agent').selectOption(agent.id);await page.locator('#flow-chat-message').fill('创建分析与报告智能体，先分析再汇总。');await page.locator('#flow-chat-consent').check();await page.locator('#flow-chat-send').click();await page.locator('[data-adopt-flow]').waitFor();
  for(const theme of ['light','dark'])for(const size of [{width:1024,height:1000},{width:1280,height:720},{width:1440,height:1000},{width:1920,height:1000}])await measure('workflow',theme,size.width,size.height);
  for(const theme of ['light','dark'])await probe('workflow',theme);
  // A full 12-node proposal exercises the real renderer and both scroll regions.
  await page.evaluate(()=>{const p=structuredClone(state.flowChat);p.proposal.nodes=Array.from({length:12},(_,i)=>({...p.proposal.nodes[i%2],id:'node-'+i,name:'长流程节点 '+(i+1),depends_on:i?['node-'+(i-1)]:[]}));showFlowChat(p);});
  await measure('workflow-long','dark',1280,720).catch(error=>{throw error;});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({records,probes,issues,errors},null,2));
  console.log(JSON.stringify({contexts:records.length,issues:issues.length,kinds:[...new Set(issues.map(i=>i.issue))]}));
  if(issues.length)process.exitCode=1;
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error.message,records,issues,errors},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
