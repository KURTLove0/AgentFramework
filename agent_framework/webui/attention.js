'use strict';

const attentionKinds={auth:'审查授权',input:'补充信息',review:'核对证据',start:'启动任务',resume:'恢复运行',cancel:'重试停止',failed:'失败诊断',expired:'过期诊断'};
function attentionScope(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal]);}
let attentionNavigationObserver=null,attentionNavigationNode=null;
function attentionLinkId(item){return 'attention-link-'+item.category+'-'+item.run_id;}
function attentionDetailId(key){return 'attention-detail-'+Array.from(String(key),character=>character.codePointAt(0).toString(16)).join('-');}
function attentionTitle(item){
 const full=String(item.title||''),normalized=full.replace(/\s+/g,' ').trim(),characters=Array.from(normalized),preview=characters.length>160?characters.slice(0,160).join('')+'…':normalized,goal=String(item.goal||'');
 return {full,preview,goal,shortened:preview!==full,showGoal:!!goal&&(goal!==full||preview!==full)};
}
function captureAttentionReading(){
 const h=attentionState(),root=$('#attention-panel');if(root?.dataset?.scope!==h.scope)return;
 $$('[data-attention-detail]',root).forEach(detail=>{const key=detail.dataset.attentionDetail;if(detail.open)h.expanded.add(key);else h.expanded.delete(key);});
}
function syncAttentionNavigation(lostFocusId){
 if(state.view==='workbench'&&!state.selected&&String(lostFocusId||'').startsWith('attention-')&&!document.getElementById(lostFocusId)&&document.activeElement===document.body){const target=$('#attention-heading')||$('#attention-empty')||$('#content');target?.focus({preventScroll:true});target?.scrollIntoView?.({block:'start',behavior:'instant'});}
 const navigation=$('#attention-navigation');if(navigation===attentionNavigationNode)return;
 attentionNavigationObserver?.disconnect();attentionNavigationObserver=null;attentionNavigationNode=navigation;
 if(!navigation||typeof ResizeObserver==='undefined')return;
 const measure=()=>{if(navigation.isConnected)navigation.closest('.attention-panel').style.setProperty('--attention-navigation-height',(getComputedStyle(navigation).position==='sticky'?navigation.getBoundingClientRect().height:0)+'px');};
 measure();attentionNavigationObserver=new ResizeObserver(measure);attentionNavigationObserver.observe(navigation);
}
function attentionReturnFocus(view,id){
 const h=state.attentionInbox,back=h?.returnFocus;
 if(!back||h.scope!==attentionScope())return null;
 h.returnFocus=null;if(back.view!==view||back.id!==id||back.route!==location.hash)return null;
 state.routePosition={top:back.top};return back.control;
}
function attentionCard(item,h){
 const title=attentionTitle(item),detail=title.shortened||title.showGoal,control=attentionLinkId(item),label=attentionDetailId(item.key),action=attentionAction(item.attention_kind),deadline=attentionDeadline(item,label+'-deadline');
 return `<article class="attention-item" data-attention-key="${esc(item.key)}"><span class="attention-icon" aria-hidden="true">${icon(item.attention_kind==='auth'?'shield':item.attention_kind==='resume'?'clock':item.attention_kind==='failed'||item.attention_kind==='expired'?'alert':'file')}</span><a id="${esc(control)}" class="attention-open" data-attention-open="${esc(item.key)}" href="${item.href}" aria-labelledby="${label}-title ${label}-action" aria-describedby="${label}-meta${deadline?' '+label+'-deadline':''}"><div class="attention-copy"><div class="attention-title"><strong id="${label}-title" class="${title.shortened?'attention-title-preview':''}">${esc(title.preview)}</strong>${item.category==='workflows'?flowPill(item.status):statusPill(item.status)}</div><p id="${label}-meta">${esc(item.type)} · ${esc(item.identity)} · ${time(item.updated_at||item.created_at)}</p>${deadline}</div><span id="${label}-action" class="button secondary attention-action">${action}${icon('arrow')}</span></a>${detail?`<details class="attention-full-goal" data-attention-detail="${esc(item.key)}" data-key="${esc('attention:'+h.scope+':'+item.key)}" ${h.expanded.has(item.key)?'open':''}><summary id="${label}">${title.showGoal?'查看完整目标':'查看完整名称'}<span class="sr-only">：${esc(title.preview)}</span></summary>${title.shortened&&title.full!==title.goal?`<p class="attention-full-text">${esc(title.full)}</p>`:''}${title.showGoal?`<p class="attention-full-text">${esc(title.goal)}</p>`:''}</details>`:''}</article>`;
}

function attentionState(){
 const scope=attentionScope(),prior=state.attentionInbox;
 if(!prior||prior.scope!==scope){const data=prior?null:state.attention;state.attentionInbox={scope,data,search:'',type:'all',kind:'all',offset:0,pending:false,error:'',request:0,promise:null,expanded:new Set(),returnFocus:null};if(prior)state.attention=null;}
 return state.attentionInbox;
}
function attentionAction(kind){return ({cancel:'重试停止',auth:'审查授权',input:'查看材料缺口',review:'核对证据',failed:'查看诊断',expired:'查看诊断',start:'启动任务',resume:'恢复运行'})[kind]||'查看详情';}
function attentionDeadlineText(deadline,now=Date.now()/1000){
 if(!Number.isFinite(deadline)||deadline<=0||!Number.isFinite(new Date(deadline*1000).getTime()))return '';
 const seconds=deadline-now;if(seconds<=0)return '已到执行期限';if(seconds<60)return '剩余不足 1 分钟';
 const minutes=Math.ceil(seconds/60);if(minutes<60)return '剩余约 '+minutes+' 分钟';
 const hours=Math.floor(minutes/60),remaining=minutes%60;if(hours<24)return '剩余约 '+hours+' 小时'+(remaining?' '+remaining+' 分钟':'');
 const days=Math.floor(hours/24),extra=hours%24;return '剩余约 '+days+' 天'+(extra?' '+extra+' 小时':'');
}
function attentionDeadline(item,id=''){
 if(!['auth','input','start','resume'].includes(item.attention_kind))return '';
 const text=attentionDeadlineText(item.deadline);if(!text)return '';
 const absolute='执行期限：'+time(item.deadline,true)+'（本机时间）';
 return `<time ${id?`id="${esc(id)}"`:''} class="attention-deadline ${item.deadline<=Date.now()/1000?'is-overdue':''}" datetime="${new Date(item.deadline*1000).toISOString()}" data-attention-deadline="${item.deadline}" title="${esc(absolute)}" aria-live="off"><span data-attention-remaining>${text}</span><span class="sr-only">；${esc(absolute)}</span></time>`;
}
function updateAttentionDeadlines(){
 if(document.hidden||state.view!=='workbench'||state.selected)return;
 const now=Date.now()/1000;
 $$('[data-attention-deadline]').forEach(element=>{const deadline=Number(element.dataset.attentionDeadline),text=attentionDeadlineText(deadline,now),label=$('[data-attention-remaining]',element);if(!text||!label)return;if(label.textContent!==text)label.textContent=text;const overdue=deadline<=now;if(element.classList.contains('is-overdue')!==overdue)element.classList.toggle('is-overdue',overdue);});
}
function attentionItems(data=attentionState().data){
 if(!data)return [];
 const tasks=(data.tasks||[]).map(item=>({...item,key:'task:'+item.run_id,category:'tasks',type:'任务',title:item.title||item.goal,searchText:item.goal,identity:item.agent_name||'内置 Agent',href:'#/runs/'+encodeURIComponent(item.run_id)}));
 const flows=(data.workflow_runs||[]).map(item=>({...item,key:'flow:'+item.id,category:'workflows',run_id:item.id,type:'工作流',title:item.name,status:item.display_status||item.status,identity:(item.node_count??item.snapshot?.definition?.nodes?.length??0)+' 个节点',href:'#/workflows/'+encodeURIComponent(item.id),updated_at:item.created_at}));
 const daily=(data.daily_plans||[]).map(plan=>{
  const blocked=plan.items.filter(item=>item.status==='BLOCKED').length,failed=plan.dispatch?.state==='FAILED';
  return {key:'daily:'+plan.id,category:'daily',run_id:plan.id,attention_kind:failed?'failed':'review',status:failed?'FAILED':'NEEDS_REVIEW',type:'每日计划',title:failed?'每日计划派发中断，等待重试':'今日计划有 '+blocked+' 项任务受阻',identity:plan.day+' · '+plan.timezone,href:'#/daily/'+encodeURIComponent(plan.id),created_at:plan.created_at,updated_at:plan.dispatch?.failed_at||plan.created_at,searchText:plan.items.map(item=>[item.task?.goal,item.agent_name,item.reason].join(' ')).join(' ')};
 });
 const deadline=item=>['auth','input','start','resume'].includes(item.attention_kind)&&Number.isFinite(item.deadline)&&item.deadline>0?item.deadline:Infinity;
 return [...tasks,...flows,...daily].sort((a,b)=>deadline(a)-deadline(b)||(a.created_at||0)-(b.created_at||0)||a.key.localeCompare(b.key));
}
function filteredAttention(h=attentionState(),items=attentionItems(h.data)){
 const query=h.search.trim().toLocaleLowerCase();
 return items.filter(item=>(h.type==='all'||item.category===h.type)&&(h.kind==='all'||item.attention_kind===h.kind)&&(!query||[item.title,item.identity,item.run_id,item.change_id,item.type,attentionKinds[item.attention_kind],item.searchText].join(' ').toLocaleLowerCase().includes(query)));
}
function renderAttention(){if(state.view==='workbench'&&!state.selected){state.fingerprint='';render();}}
function loadAttention({background=false}={}){
 const h=attentionState(),scope=h.scope,route=state.routeVersion,workspace=state.workspaceId,restoreFocus=document.activeElement?.id==='attention-refresh';
 if(background&&h.pending&&h.route===route&&h.promise)return h.promise;
 if(background&&h.error)return Promise.resolve(false);
 const request=++h.request,current=()=>scope===attentionScope()&&state.attentionInbox===h&&request===h.request&&state.view==='workbench'&&route===state.routeVersion;
 h.pending=true;h.error='';h.route=route;if(!background)renderAttention();
 h.promise=(async()=>{
  try{
   const data=await api('/api/attention',undefined,15000,true,{workspace,payload:undefined});if(!current())return false;
   const visible=filteredAttention(h).slice(h.offset,h.offset+8),wasLater=h.offset>0;h.data=data;state.attention=data;
   const items=filteredAttention(h);let anchor=-1;
   if(wasLater)for(const item of visible){anchor=items.findIndex(next=>next.key===item.key);if(anchor>=0)break;}
   h.offset=wasLater&&items.length>8?(anchor>=0?anchor:Math.min(h.offset,Math.max(0,Math.floor((items.length-1)/8)*8))):0;
   h.pending=false;if(!background)renderAttention();return true;
  }catch(error){if(!current())return false;h.pending=false;h.error=error.message||'读取未完成';if(!background)renderAttention();return false;}
  finally{if(request===h.request)h.pending=false;if(!background&&current()&&restoreFocus&&document.activeElement===document.body)($('#attention-refresh')||$('#attention-empty')||$('#content'))?.focus({preventScroll:true});}
 })();return h.promise;
}
function changeAttentionFilter(key,value){const h=attentionState();if(!['search','type','kind'].includes(key))return;h[key]=value;h.offset=0;renderAttention();}
function pageAttention(direction){
 const h=attentionState(),total=filteredAttention(h).length;
 if(direction==='next'&&h.offset+8<total)h.offset+=8;
 else if(direction==='prev'&&h.offset>0)h.offset=Math.max(0,h.offset-8);
 else if(direction==='first')h.offset=0;else return;
 renderAttention();const target=$('.attention-list [data-attention-open]')||$('#attention-heading');target?.focus({preventScroll:true});target?.scrollIntoView?.({block:'start',behavior:'instant'});
}
function attentionPanel(){
 captureAttentionReading();
 const h=attentionState(),all=attentionItems(h.data),items=filteredAttention(h,all),total=all.length,filtered=h.search||h.type!=='all'||h.kind!=='all';
 if(h.data&&!total&&!h.error&&!h.pending&&!filtered)return (state.counts.total??0)?`<div class="attention-empty attention-empty-inline" id="attention-empty" tabindex="-1" role="status">${icon('check')}<span>当前没有需要处理的执行阻塞。</span></div>`:'';
 const status=h.pending?(h.data?'正在更新，以下为上次读取的事项。':'正在读取待处理事项…'):h.error?(h.data?'读取失败，以下为上次成功读取的事项。':'待处理事项读取失败，尚不能确认是否有待办。'):'';
 const types=[['all','全部类型'],['tasks','任务'],['workflows','工作流'],['daily','每日计划']];
 return `<section class="panel attention-panel" id="attention-panel" data-scope="${esc(h.scope)}" aria-labelledby="attention-heading"><div class="panel-heading"><div><h2 id="attention-heading" tabindex="-1">需要处理 <small>${h.data?total:'—'}</small></h2><p>有执行期限的授权、补充信息和启动/恢复事项优先，其余按产生时间排序。</p></div><button type="button" id="attention-refresh" class="button secondary" data-attention-refresh ${h.pending?'aria-disabled="true" aria-busy="true"':''}>${h.pending?'正在读取…':'刷新待办'}</button></div><div class="attention-filters"><label for="attention-search">搜索待处理事项<input type="search" id="attention-search" maxlength="2000" value="${esc(h.search)}" placeholder="目标、岗位、计划日期或标识"></label><label for="attention-type">事项类型<select id="attention-type">${types.map(([value,label])=>`<option value="${value}" ${h.type===value?'selected':''}>${label}${h.data?' · '+(value==='all'?total:all.filter(item=>item.category===value).length):''}</option>`).join('')}</select></label><label for="attention-kind">需要的操作<select id="attention-kind"><option value="all">全部操作</option>${Object.entries(attentionKinds).map(([value,label])=>`<option value="${value}" ${h.kind===value?'selected':''}>${label}</option>`).join('')}</select></label>${filtered?'<button type="button" id="attention-clear" class="text-button" data-attention-clear>清除筛选</button>':''}</div>${status?`<p class="attention-status" role="status">${status}</p>`:''}${h.error?`<p class="inline-error attention-error" role="alert">${esc(h.error)}。可使用“刷新待办”重试读取。</p>`:''}<nav class="table-bottom attention-pagination" id="attention-navigation" aria-label="待处理事项分页"><span role="status" aria-live="polite" aria-atomic="true">${h.data?'显示 '+(items.length?h.offset+1:0)+'–'+Math.min(h.offset+8,items.length)+' / '+items.length+' 项匹配；共 '+total+' 项待处理':'尚未读取成功'}</span><div class="toolbar"><button type="button" class="text-button" id="attention-first" data-attention-page="first" ${h.offset?'':'disabled'}>返回开头</button><button type="button" class="button secondary" id="attention-prev" data-attention-page="prev" ${h.offset?'':'disabled'}>上一页</button><button type="button" class="button secondary" id="attention-next" data-attention-page="next" ${h.offset+8<items.length?'':'disabled'}>下一页</button></div></nav>${h.data?items.length?`<div class="attention-list">${items.slice(h.offset,h.offset+8).map(item=>attentionCard(item,h)).join('')}</div>`:'<div class="attention-empty">没有符合当前筛选的事项，可清除筛选查看全部。</div>':''}</section>`;
}
document.addEventListener('input',event=>{if(event.target.id==='attention-search'&&!event.isComposing)changeAttentionFilter('search',event.target.value);});
document.addEventListener('compositionend',event=>{if(event.target.id==='attention-search')changeAttentionFilter('search',event.target.value);});
document.addEventListener('change',event=>{if(event.target.id==='attention-type')changeAttentionFilter('type',event.target.value);if(event.target.id==='attention-kind')changeAttentionFilter('kind',event.target.value);});
document.addEventListener('click',event=>{
 const link=event.target.closest('[data-attention-open]');if(link&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey&&state.view==='workbench'&&!state.selected){captureAttentionReading();const parts=link.hash.slice(2).split('/');attentionState().returnFocus={view:parts[0],id:parts[1],route:location.hash,control:link.id,top:window.scrollY};}
 const page=event.target.closest('[data-attention-page]');if(page)pageAttention(page.dataset.attentionPage);
 const refresh=event.target.closest('[data-attention-refresh]');if(refresh){if(!attentionState().pending)loadAttention();else if(refresh.getAttribute('aria-busy')!=='true')renderAttention();}
 if(event.target.closest('[data-attention-clear]')){Object.assign(attentionState(),{search:'',type:'all',kind:'all',offset:0});renderAttention();$('#attention-search')?.focus({preventScroll:true});}
});
document.addEventListener('toggle',event=>{const detail=event.target;if(!detail.matches?.('[data-attention-detail]')||!detail.isConnected)return;const h=attentionState();if(detail.closest('#attention-panel')?.dataset.scope!==h.scope)return;const key=detail.dataset.attentionDetail;if(detail.open)h.expanded.add(key);else h.expanded.delete(key);},true);
if(typeof setInterval==='function')setInterval(updateAttentionDeadlines,1000);
document.addEventListener('visibilitychange',updateAttentionDeadlines);
