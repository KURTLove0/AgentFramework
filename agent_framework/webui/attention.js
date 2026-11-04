'use strict';

const attentionKinds={auth:'审查授权',input:'补充信息',review:'核对证据',start:'启动任务',resume:'恢复运行',cancel:'重试停止',failed:'失败诊断',expired:'过期诊断'};
function attentionScope(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal]);}
function attentionState(){
 const scope=attentionScope(),prior=state.attentionInbox;
 if(!prior||prior.scope!==scope){const data=prior?null:state.attention;state.attentionInbox={scope,data,search:'',type:'all',kind:'all',offset:0,pending:false,error:'',request:0,promise:null};if(prior)state.attention=null;}
 return state.attentionInbox;
}
function attentionAction(kind){return ({cancel:'重试停止',auth:'审查授权',input:'查看材料缺口',review:'核对证据',failed:'查看诊断',expired:'查看诊断',start:'启动任务',resume:'恢复运行'})[kind]||'查看详情';}
function attentionDeadline(item){
 if(!['auth','input','start','resume'].includes(item.attention_kind)||!item.deadline)return '';
 const seconds=Math.ceil(item.deadline-Date.now()/1000);
 return `<span class="attention-deadline ${seconds<0?'is-overdue':''}">${seconds<0?'已超出执行期限':seconds<60?'剩余不足 1 分钟':'剩余约 '+Math.ceil(seconds/60)+' 分钟'}</span>`;
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
 const h=attentionState(),scope=h.scope,route=state.routeVersion,workspace=state.workspaceId;
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
  finally{if(request===h.request)h.pending=false;}
 })();return h.promise;
}
function changeAttentionFilter(key,value){const h=attentionState();if(!['search','type','kind'].includes(key))return;h[key]=value;h.offset=0;renderAttention();}
function pageAttention(direction){
 const h=attentionState(),total=filteredAttention(h).length;
 if(direction==='next'&&h.offset+8<total)h.offset+=8;
 else if(direction==='prev'&&h.offset>0)h.offset=Math.max(0,h.offset-8);
 else if(direction==='first')h.offset=0;else return;
 renderAttention();$('#attention-heading')?.focus({preventScroll:true});
}
function attentionPanel(){
 const h=attentionState(),all=attentionItems(h.data),items=filteredAttention(h,all),total=all.length,filtered=h.search||h.type!=='all'||h.kind!=='all';
 if(h.data&&!total&&!h.error&&!h.pending&&!filtered)return (state.counts.total??0)?`<div class="attention-empty attention-empty-inline" role="status">${icon('check')}<span>当前没有需要处理的执行阻塞。</span></div>`:'';
 const status=h.pending?(h.data?'正在更新，以下为上次读取的事项。':'正在读取待处理事项…'):h.error?(h.data?'读取失败，以下为上次成功读取的事项。':'待处理事项读取失败，尚不能确认是否有待办。'):'';
 const types=[['all','全部类型'],['tasks','任务'],['workflows','工作流'],['daily','每日计划']];
 return `<section class="panel attention-panel" aria-labelledby="attention-heading"><div class="panel-heading"><div><h2 id="attention-heading" tabindex="-1">需要处理 <small>${h.data?total:'—'}</small></h2><p>有执行期限的授权、补充信息和启动/恢复事项优先，其余按产生时间排序。</p></div><button type="button" id="attention-refresh" class="button secondary" data-attention-refresh ${h.pending?'disabled aria-busy="true"':''}>刷新待办</button></div><div class="attention-filters"><label for="attention-search">搜索待处理事项<input type="search" id="attention-search" maxlength="2000" value="${esc(h.search)}" placeholder="目标、岗位、计划日期或标识"></label><label for="attention-type">事项类型<select id="attention-type">${types.map(([value,label])=>`<option value="${value}" ${h.type===value?'selected':''}>${label}${h.data?' · '+(value==='all'?total:all.filter(item=>item.category===value).length):''}</option>`).join('')}</select></label><label for="attention-kind">需要的操作<select id="attention-kind"><option value="all">全部操作</option>${Object.entries(attentionKinds).map(([value,label])=>`<option value="${value}" ${h.kind===value?'selected':''}>${label}</option>`).join('')}</select></label>${filtered?'<button type="button" class="text-button" data-attention-clear>清除筛选</button>':''}</div>${status?`<p class="attention-status" role="status">${status}</p>`:''}${h.error?`<p class="inline-error attention-error" role="alert">${esc(h.error)}。可使用“刷新待办”重试读取。</p>`:''}${h.data?items.length?`<div class="attention-list">${items.slice(h.offset,h.offset+8).map(item=>`<article class="attention-item" data-attention-key="${esc(item.key)}"><span class="attention-icon" aria-hidden="true">${icon(item.attention_kind==='auth'?'shield':item.attention_kind==='resume'?'clock':item.attention_kind==='failed'||item.attention_kind==='expired'?'alert':'file')}</span><div class="attention-copy"><div class="attention-title"><strong>${esc(item.title)}</strong>${item.category==='workflows'?flowPill(item.status):statusPill(item.status)}</div><p>${esc(item.type)} · ${esc(item.identity)} · ${time(item.updated_at||item.created_at)}</p>${attentionDeadline(item)}</div><a id="attention-link-${esc(item.category)}-${esc(item.run_id)}" class="button secondary" href="${item.href}">${attentionAction(item.attention_kind)}${icon('arrow')}</a></article>`).join('')}</div>`:'<div class="attention-empty">没有符合当前筛选的事项，可清除筛选查看全部。</div>':''}<div class="table-bottom attention-pagination"><span>${h.data?'显示 '+(items.length?h.offset+1:0)+'–'+Math.min(h.offset+8,items.length)+' / '+items.length+' 项匹配；共 '+total+' 项待处理':'尚未读取成功'}</span><div class="toolbar">${h.offset?'<button type="button" class="text-button" data-attention-page="first">返回开头</button>':''}<button type="button" class="button secondary" id="attention-prev" data-attention-page="prev" ${h.offset?'':'disabled'}>上一页</button><button type="button" class="button secondary" id="attention-next" data-attention-page="next" ${h.offset+8<items.length?'':'disabled'}>下一页</button></div></div></section>`;
}
document.addEventListener('input',event=>{if(event.target.id==='attention-search'&&!event.isComposing)changeAttentionFilter('search',event.target.value);});
document.addEventListener('compositionend',event=>{if(event.target.id==='attention-search')changeAttentionFilter('search',event.target.value);});
document.addEventListener('change',event=>{if(event.target.id==='attention-type')changeAttentionFilter('type',event.target.value);if(event.target.id==='attention-kind')changeAttentionFilter('kind',event.target.value);});
document.addEventListener('click',event=>{
 const page=event.target.closest('[data-attention-page]');if(page)pageAttention(page.dataset.attentionPage);
 if(event.target.closest('[data-attention-refresh]')&&!attentionState().pending)loadAttention();
 if(event.target.closest('[data-attention-clear]')){Object.assign(attentionState(),{search:'',type:'all',kind:'all',offset:0});renderAttention();$('#attention-search')?.focus({preventScroll:true});}
});
