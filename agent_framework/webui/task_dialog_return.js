'use strict';
const taskDialogReturnControls=['data-chat-inspect-run','data-task-export','data-task-conversation-export','data-task-name-open','data-task-relations','data-message-history','data-queue-edit','data-retrospective','data-action'];
function taskDialogReturnScope(){return JSON.stringify([state.meta?.tenant,state.workspaceId,state.meta?.principal,state.view,state.selected,state.routeVersion,state.detail?.conversation?.id||state.detail?.run?.run_id]);}
function taskDialogControlRegion(element){
 for(const [selector,name] of [['.chat-answer-actions','answer'],['.chat-process-body','process'],['.chat-turn-error','error'],['.task-thread-properties','properties'],['.task-mobile-panel','information']])if(element.closest(selector))return name;
 return 'task';
}
function captureTaskDialogReturn(trigger=document.activeElement){
 const root=document.getElementById('run-detail'),control=trigger?.closest?.(taskDialogReturnControls.map(name=>'['+name+']').join(','));
 if(!root||!control||!root.contains(control)||control.hasAttribute('data-action')&&!['grant','cancel','revoke'].includes(control.getAttribute('data-action')))return null;
 const attribute=taskDialogReturnControls.find(name=>control.hasAttribute(name)),container=control.closest('#task-message-list,#task-thread-properties'),details=[];
 for(let parent=control.closest('details');parent;parent=parent.parentElement?.closest('details'))if(parent.open&&parent.dataset.key)details.push(parent.dataset.key);
 return {scope:taskDialogReturnScope(),attribute,value:control.getAttribute(attribute),region:taskDialogControlRegion(control),turn:control.closest('[data-chat-turn]')?.dataset.chatTurn||'',node:control,details,rootTop:window.scrollY,container:container?.id,offset:container?control.getBoundingClientRect().top-container.getBoundingClientRect().top:0,used:false};
}
function restoreTaskDialogReturn(saved,dialog){
 if(!saved||saved.used)return;saved.used=true;
 if(saved.scope!==taskDialogReturnScope()||dialog.open||document.querySelector('dialog[open]'))return;
 const root=document.getElementById('run-detail');if(!root)return;
 const matches=element=>element.getAttribute(saved.attribute)===saved.value&&taskDialogControlRegion(element)===saved.region&&(element.closest('[data-chat-turn]')?.dataset.chatTurn||'')===saved.turn;
 const controls=[...root.querySelectorAll('['+saved.attribute+']')],exact=controls.find(matches),active=document.activeElement;
 if(active!==document.body&&active!==saved.node&&active!==exact&&!dialog.contains(active))return;
 if(exact)for(let parent=exact.closest('details');parent;parent=parent.parentElement?.closest('details'))if(saved.details.includes(parent.dataset.key))parent.open=true;
 const visible=element=>{
  if(!element?.isConnected||element.disabled||element.closest('[hidden],[inert]')||!element.getClientRects().length)return false;
  for(let parent=element.closest('details');parent;parent=parent.parentElement?.closest('details'))if(!parent.open&&!parent.querySelector(':scope > summary')?.contains(element))return false;
  return typeof element.checkVisibility!=='function'||element.checkVisibility({checkVisibilityCSS:true});
 };
 let target=visible(exact)?exact:null;
 if(!target&&['data-chat-inspect-run','data-queue-edit'].includes(saved.attribute))target=controls.find(element=>element.getAttribute(saved.attribute)===saved.value&&visible(element));
 target||=root.querySelector('#task-message-list')||root.querySelector('[data-chat-properties]')||root;
 if(!visible(target))return;if(target===root)target.tabIndex=-1;
 target.focus({preventScroll:true});
 const container=target.closest('#task-message-list,#task-thread-properties');
 if(target===exact&&container&&container.id===saved.container)container.scrollTop+=target.getBoundingClientRect().top-container.getBoundingClientRect().top-saved.offset;
 window.scrollTo({top:saved.rootTop,behavior:'instant'});target.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
}
