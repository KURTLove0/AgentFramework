'use strict';
function initAgentExperience(){
 const note=document.createElement('p');note.id='agent-runtime-hint';note.className='field-help';$('#agent-runtime').closest('label').after(note);
}
function updateAgentExperience(){
 const mock=$('#agent-runtime')?.value==='mock',model=$('#agent-model');if(model){model.closest('label').hidden=mock;$('#agent-model-status').hidden=mock;$('#agent-runtime-tuning').hidden=mock;}
 const hint=$('#agent-runtime-hint');if(hint)hint.textContent=mock?'模拟试用无需连接模型，可先体验创建任务与查看结果。':'选择模型后可调整工作指令。账号权限由所选模型服务决定。';
 if(typeof refreshFormControls==='function')refreshFormControls();
}
function agentSavedNotice(){
 const notice=state.agentSavedNotice;if(!notice||notice.workspace!==state.workspaceId||(state.agents||[]).some(a=>a.id===notice.id&&a.archived))return '';
 if(state.selected===notice.id)return `<div class="notice agent-detail-saved" role="status">${icon('check')}<span>配置 v${notice.revision} 已保存。新任务将使用此版本。</span><button type="button" class="icon-button" data-agent-notice-close aria-label="收起智能体保存结果">${icon('close')}</button></div>`;
 const returning=typeof taskJourney!=='undefined'&&taskJourney.returnToTask&&taskJourney.workspace===state.workspaceId;
 return `<section class="agent-saved-notice" aria-labelledby="agent-saved-summary-${esc(notice.id)}"><span class="agent-saved-icon">${icon('check')}</span><div><h2 id="agent-saved-summary-${esc(notice.id)}">“${esc(notice.name)}”已就绪</h2><p>${returning?'任务目标已保留，返回即可开始执行。':'现在交给它一个任务，查看实际结果。'}</p></div><div class="toolbar"><button type="button" class="button primary" id="agent-saved-use-${esc(notice.id)}" aria-describedby="agent-saved-summary-${esc(notice.id)}" data-agent-saved-use="${esc(notice.id)}">${returning?'返回任务':'开始使用'}${icon('arrow')}</button><button type="button" class="text-button" data-edit-agent="${esc(notice.id)}">继续编辑</button><button type="button" class="icon-button" data-agent-notice-close aria-label="收起智能体创建结果">${icon('close')}</button></div></section>`;
}
function taskGoalExamples(){
 const agent=selectedTaskAgent(),qa=$('#task-domain').value==='knowledge-answer@1.0.0',domain=agent?.processing_domain?.name;
 return qa?[domain?'请依据'+domain+'的资料，回答关键问题并注明来源。':'总结已发布资料中的主要规则，并注明来源。',domain?'请梳理'+domain+'的处理流程，并列出资料依据。':'请解释资料中的关键规则，并列出依据。','请按步骤解释资料中的流程，并列出依据。']:['评估本次变更的主要风险，并生成评估草稿。','核对测试结果和依赖，列出风险及待确认事项。','检查回滚准备情况，并说明结论所依据的证据。'];
}
function updateTaskExperience(){
 if($('#create-form').dataset?.simple==='true')return updateCompactTask();
 const agent=selectedTaskAgent(),qa=$('#task-domain').value==='knowledge-answer@1.0.0',summary=$('#task-selected-agent');if(!summary)return;
 $('#task-domain').closest('label').hidden=!!agent;
 $('#task-agent').closest('label').hidden=!!agent&&!state.taskChoosingAgent;
 summary.hidden=!agent;$('#task-agent-info').hidden=!!agent;
 if(agent){const markup=`<div class="task-agent-avatar">${icon('agent')}</div><div><strong>${esc(agent.name)}</strong><p>${esc(agentDomainLabel(agent))} · ${agent.runtime==='mock'?'模拟试用':esc(runtimeLabel(agent.runtime))} · v${agent.revision}</p></div><button type="button" class="text-button" data-change-task-agent>更换</button>`;if(summary.innerHTML!==markup)summary.innerHTML=markup;}
 $('#planner-select').closest('label').hidden=!!agent;
 const execution=$('#task-agent-execution');execution.hidden=!agent;if(agent)execution.innerHTML=`<strong>由“${esc(agent.name)}”执行</strong><p>${agent.runtime==='mock'?'使用内置规划器模拟运行，无需连接模型。':esc(runtimeLabel(agent.runtime))+' · '+esc(agent.model)} 配置已随智能体固定。</p><button type="button" class="text-button" data-action="open-runtime-config">查看或调整智能体配置</button>`;
 const examples=$('#task-goal-examples'),markup=taskGoalExamples().map((text,i)=>`<button type="button" data-task-example="${i}">${esc(text)}</button>`).join('');if(examples.innerHTML!==markup)examples.innerHTML=markup;
 $('#task-goal').placeholder=qa?'例如：请根据资料解释这个流程，并注明来源。':'例如：评估此次变更的风险，说明依据并生成草稿。';
 $('#task-goal-help').textContent='写清要解决的问题、希望得到的结果；也可以选择下方示例后修改。';
 if(typeof refreshFormControls==='function')refreshFormControls();
}
document.addEventListener('click',event=>{
 const use=event.target.closest('[data-agent-saved-use]');if(use)void newTask({agentId:use.dataset.agentSavedUse},use);
 if(event.target.closest('[data-agent-notice-close]')){state.agentSavedNotice=null;state.fingerprint='';render();}
 if(event.target.closest('[data-change-task-agent]')){state.taskChoosingAgent=true;$('#task-agent').closest('label').hidden=false;focusFormControl($('#task-agent'));}
 const example=event.target.closest('[data-task-example]');if(example){const goal=$('#task-goal');goal.value=taskGoalExamples()[Number(example.dataset.taskExample)];goal.dispatchEvent(new Event('input',{bubbles:true}));goal.focus({preventScroll:true});}
});
document.addEventListener('change',event=>{if(['task-agent','task-domain'].includes(event.target.id)){const choosing=state.taskChoosingAgent;state.taskChoosingAgent=false;queueMicrotask(()=>{updateTaskExperience();if(choosing&&selectedTaskAgent())$('#task-goal').focus({preventScroll:true});});}if(event.target.id==='agent-runtime')updateAgentExperience();});

document.addEventListener('picker-selected',event=>{if(event.target.id==='task-agent'){state.taskChoosingAgent=false;updateTaskExperience();$('#task-goal').focus({preventScroll:true});}});
