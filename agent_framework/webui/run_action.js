'use strict';
let runActionContext=null;
function runActionDetail(detail=state.detail){return detail?.conversation?.current||detail;}
function runActionCurrent(record){return record===runActionContext&&$('#confirm-dialog').open&&$('#confirm-submit').onclick===record.handler&&record.workspace===state.workspaceId&&record.tenant===state.meta?.tenant&&record.principal===state.meta?.principal&&record.route===state.routeVersion&&record.selected===state.selected;}
function runActionReady(action,detail){
 const run=detail?.run;if(!run||terminal.has(run.status))return false;
 if(action==='cancel')return !run.cancellation?.pending||Boolean(run.cancellation?.error);
 if(action==='revoke')return Boolean(detail.grant?.valid&&detail.permissions?.revoke_token);
 return run.status==='WAITING_AUTH'&&!run.cancellation?.pending&&!detail.permissions?.request&&Boolean(detail.permissions?.grant_token);
}
function runActionOrder(incoming,previous=state.detail){
 if(!previous||!incoming)return 0;
 const before=previous.conversation,after=incoming.conversation;
 if(before&&after&&before.id===after.id){
  if(before.snapshot_format===1&&after.snapshot_format===1&&typeof taskChatOrder==='function')return taskChatOrder(before,after);
  if(before.revision!==after.revision)return Math.sign(after.revision-before.revision);
  const a=before.active_run_id||runActionDetail(previous)?.run?.run_id,b=after.active_run_id||runActionDetail(incoming)?.run?.run_id;
  if(a!==b){const oldTurn=before.turns?.find(t=>t.run_id===a),newTurn=after.turns?.find(t=>t.run_id===b);if(oldTurn&&newTurn)return Math.sign(newTurn.number-oldTurn.number);}
 }
 const a=runActionDetail(previous),b=runActionDetail(incoming);if(!a?.run||a.run.run_id!==b?.run?.run_id)return 0;
 // Checkpoints and event sequences advance even when the wall clock moves back.
 const version=(b.run.version||0)-(a.run.version||0),events=(b.events?.at(-1)?.seq||0)-(a.events?.at(-1)?.seq||0);
 if(version||events)return Math.sign(version||events);
 const ac=a.run.cancellation,bc=b.run.cancellation,generation=(bc?.generation||0)-(ac?.generation||0);
 if(generation)return Math.sign(generation);
 if(Boolean(ac)!==Boolean(bc))return bc?1:-1;
 if(ac&&bc){if(ac.pending!==bc.pending)return bc.pending?-1:1;if(Boolean(ac.error)!==Boolean(bc.error))return bc.error?1:-1;}
 return Number(terminal.has(b.run.status))-Number(terminal.has(a.run.status));
}
function runActionOlder(incoming){return runActionOrder(incoming)<0;}
function selectRunDetail(incoming,previous=state.detail,streaming=false){
 const withArchive=chosen=>{const other=chosen===incoming?previous:incoming;let merged=typeof mergeTaskArchive==='function'?mergeTaskArchive(chosen,other):chosen;merged=typeof mergeTaskName==='function'?mergeTaskName(merged,other):merged;return typeof mergeTaskFavorite==='function'?mergeTaskFavorite(merged,other):merged;};
 const order=runActionOrder(incoming,previous);if(order<0)return withArchive(previous);if(order>0)return withArchive(incoming);
 if(previous?.conversation&&incoming?.conversation?.id===previous.conversation.id){
  const before=previous.conversation,after=incoming.conversation;
  if(typeof taskChatShouldPreserve==='function'?taskChatShouldPreserve(before,after,streaming):before.updated_at>after.updated_at)return withArchive(previous);
 }
 return withArchive(incoming);
}
function applyRunActionDetail(record,detail){
 if(!runActionCurrent(record))return false;
 if(detail?.run?.run_id!==record.selected&&detail?.conversation?.id!==record.selected)throw Error('返回的任务记录不匹配');
 if(runActionOlder(detail))return false;
 state.runMutationRevision=(state.runMutationRevision||0)+1;state.detail=selectRunDetail(detail);state.fingerprint='';render();return true;
}
function renderRunAction(record){
 if(!runActionCurrent(record))return;
 const d=record.detail,r=d.run,pending=r.actions.find(a=>a.tool_ref==='report.draft.create@1.0.0'&&a.status==='PREPARED'),direct=r.task.execution_mode==='direct';
 const copy={grant:['授权并继续运行','请审查以下具体提案。确认只适用于显示的任务、参数与授权状态；内容变化后需要重新核对。','授权并继续'],cancel:['取消当前运行',direct?'停止当前模型调用，保留已收到的输出和运行记录。':'当前动作返回后会先核对结果再停止。已经创建的草稿与执行记录会保留。','确认取消'],revoke:['撤销写入授权','后续写入会重新检查授权。已经开始的动作可能完成，其结果仍会被核对。','撤销授权']}[record.action];
 $('#confirm-title').textContent=copy[0];$('#confirm-submit').className='button '+(record.action==='cancel'?'danger':'primary');
 const finished=record.review&&terminal.has(runActionDetail(record.review)?.run?.status);
 $('#confirm-submit').disabled=record.busy||record.blocked||!runActionReady(record.action,d);$('#confirm-submit').textContent=record.busy?'正在处理…':finished?'本次运行已结束':record.blocked?'请先核对状态':copy[2];
 $('#confirm-submit').toggleAttribute('aria-busy',record.busy);
 $('#confirm-body').innerHTML=`<p class="confirm-copy">${copy[1]}</p><div class="confirm-scope"><dl class="facts">${fact('运行',r.run_id,true)}${fact('任务',r.task.goal)}${direct?fact('执行智能体',r.snapshot.agent_profile?.name||r.snapshot.agent.identity.name):fact('变更',r.task.change_id,true)+fact('项目',r.task.project_id,true)+fact('环境',r.task.environment,true)}${record.action==='grant'?fact('参数摘要',pending?.args_hash,true):''}</dl>${record.action==='grant'?`<details><summary>审查工具参数</summary><pre>${json(pending?.args)}</pre></details>`:''}</div>${record.issue?`<section class="run-action-recovery" aria-label="核对运行操作"><p role="status">${esc(record.issue)}</p><div class="toolbar"><button type="button" class="button secondary" data-run-action-review ${record.busy?'disabled':''}>${record.busy?'正在核对…':'核对当前状态'}</button>${record.review&&runActionReady(record.action,runActionDetail(record.review))?`<button type="button" class="button secondary" data-run-action-prepare ${record.busy?'disabled':''}>重新审查当前内容</button>`:''}</div></section>`:''}`;
 $('#confirm-error').hidden=true;
}
function openRunAction(action,packet=state.detail){
 if(!['grant','cancel','revoke'].includes(action)||!packet)return;
 const detail=runActionDetail(packet);if(!detail?.run)return;
 const record=runActionContext={action,detail:structuredClone(detail),workspace:state.workspaceId,tenant:state.meta?.tenant,principal:state.meta?.principal,selected:state.selected,route:state.routeVersion,busy:false,blocked:false,review:null,issue:null};
 record.payload=action==='cancel'?{}:{proof:detail.permissions?.[action+'_token']};record.handler=()=>submitRunAction(record);
 $('#confirm-submit').onclick=record.handler;$('#confirm-dialog').showModal();
 if(!runActionReady(action,detail)){record.blocked=true;record.issue='当前状态尚不能执行此操作，请先核对；没有提交请求。';}
 renderRunAction(record);
}
async function submitRunAction(record=runActionContext){
 if(!record||!runActionCurrent(record)||record.busy||record.blocked||!runActionReady(record.action,record.detail))return;
 record.busy=true;renderRunAction(record);
 try{
  const detail=await api('/api/runs/'+encodeURIComponent(record.detail.run.run_id)+'/'+record.action,record.payload,15000,true,{workspace:record.workspace,payload:JSON.stringify(record.payload)});
  if(!runActionCurrent(record))return;
  applyRunActionDetail(record,detail);record.busy=false;$('#confirm-submit').disabled=false;$('#confirm-submit').removeAttribute('aria-busy');$('#confirm-dialog').close();
  toast(record.action==='grant'?'授权请求已保存，可查看实际执行进度':record.action==='cancel'?'停止请求已保存，已有结果保留':'撤销请求已保存，已在途的操作仍会被核对');await refresh();
 }catch(error){
  if(!runActionCurrent(record))return;
  record.blocked=true;record.issue=(['TypeError','TimeoutError','SyntaxError'].includes(error.name)?'暂时无法确认操作结果。':error.message+'。')+'请先核对当前状态，核对不会重复提交。';
 }finally{record.busy=false;if(runActionCurrent(record))renderRunAction(record);}
}
async function reviewRunAction(){
 const record=runActionContext;if(!record||!runActionCurrent(record)||record.busy)return;
 record.busy=true;renderRunAction(record);
 try{
  const detail=await api('/api/runs/'+encodeURIComponent(record.selected),undefined,15000,true,{workspace:record.workspace,payload:undefined});if(!runActionCurrent(record))return;
  if(detail?.run?.run_id!==record.selected&&detail?.conversation?.id!==record.selected)throw Error('返回的任务记录不匹配');
  applyRunActionDetail(record,detail);record.review=runActionOlder(detail)?state.detail:detail;record.blocked=true;
  const latest=runActionDetail(record.review),request=latest.permissions?.request;
  record.issue=request?(request.error||(request.state==='RUNNING'?'授权已经保存，正在执行；无需再次授权。':'授权已经保存，正在等待执行；无需再次授权。')):latest.run.cancellation?.pending?'停止请求已保存，正在处理。':terminal.has(latest.run.status)?'本次运行已结束，可关闭窗口查看结果。':record.action==='revoke'&&!latest.grant?.valid?'当前授权已失效或已撤销，无需重复提交。':'已读取当前状态。如仍需操作，请先选择“重新审查当前内容”，确认后再提交。';
 }catch(error){if(runActionCurrent(record)){record.blocked=true;record.issue='核对暂未完成：'+error.message+'。原审查内容保留，可稍后重试核对。';}}
 finally{record.busy=false;if(runActionCurrent(record)){renderRunAction(record);$('.run-action-recovery')?.scrollIntoView({block:'nearest'});}}
}
function runPermissionNotice(detail){
 const run=detail?.run,request=detail?.permissions?.request;if(!run||terminal.has(run.status)||run.cancellation?.pending)return '';
 const revoke=detail.grant?.valid&&detail.permissions?.revoke_token?'<button type="button" class="text-button" data-action="revoke">撤销写入授权</button>':'';
 if(request)return `<section class="run-permission-notice notice" role="status"><div><strong>${request.error?'授权已保存，继续执行受阻':request.state==='RUNNING'?'授权已保存，正在执行':'授权已保存，等待执行'}</strong><p>${esc(request.error||(request.state==='RUNNING'?'正在处理原任务，可查看实际进度；无需再次授权。':'执行请求已保留，队列可用后会继续原任务；无需再次授权。'))}</p></div><div class="toolbar">${request.error?`<button type="button" class="button secondary" data-retry-permission="${esc(run.run_id)}">重试继续执行</button>`:''}${revoke}</div></section>`;
 if(run.status==='WAITING_AUTH'&&!detail.job?.active)return `<section class="run-permission-notice notice" role="status"><p>本轮有具体写入提案需要确认。审查后才会执行该操作。</p><div class="toolbar"><button type="button" class="button primary" data-action="grant">确认具体操作</button>${revoke}</div></section>`;
 return revoke?`<section class="run-permission-notice notice"><p>本次写入授权有效，后续写入仍需通过运行时检查。</p>${revoke}</section>`:'';
}
document.addEventListener('click',async event=>{
 if(event.target.closest('[data-run-action-review]')){event.preventDefault();return reviewRunAction();}
 if(event.target.closest('[data-run-action-prepare]')){event.preventDefault();const r=runActionContext;if(r?.review&&!r.busy&&runActionCurrent(r))openRunAction(r.action,r.review);}
 const retry=event.target.closest('[data-retry-permission]');if(retry&&!retry.disabled){retry.disabled=true;const workspace=state.workspaceId,route=state.routeVersion;try{const updated=await api('/api/runs/'+encodeURIComponent(retry.dataset.retryPermission)+'/resume',{},15000,true,{workspace,payload:'{}'});if(workspace===state.workspaceId&&route===state.routeVersion){toast(updated.permissions?.request?'继续执行请求已保留，可查看排队状态':updated.job?.active?'任务已进入执行':'已核对当前状态，请查看任务详情');await refresh();}}catch(error){if(workspace===state.workspaceId&&route===state.routeVersion)toast(error.message);}finally{retry.disabled=false;}}
});
