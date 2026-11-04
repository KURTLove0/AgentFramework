'use strict';
function taskReuseActions(detail){
 const c=detail?.conversation,run=detail?.run;if(!c||!run||run.run_id!==c.id)return '';
 const source=run.task?.source_run_id;
 return `<button type="button" class="text-button" data-action="copy-run" data-source-run="${esc(run.run_id)}">${icon('copy')}基于此任务新建</button><button type="button" class="text-button" data-task-relations="${esc(c.id)}">查看关联任务</button>${source?`<p class="field-help task-source-link">来源任务：<a href="#/runs/${encodeURIComponent(source)}">${esc(source)}</a></p>`:''}`;
}
function renderTaskSource(){
 const node=document.getElementById('task-source-note');if(!node)return;
 const source=taskJourney.sourceRun;node.hidden=!source;if(!source){node.innerHTML='';return;}
 const agent=selectedTaskAgent(),original=source.agent_name||source.agent_id||'原智能体';let version;
 if(!agent)version='原智能体当前不可用或尚未选择，请选择可用的智能体。';
 else if(source.agent_id&&source.agent_id!==agent.id)version='本次改用 '+agent.name+' · v'+agent.revision+'。';
 else if(source.agent_revision)version=original+'：原任务 v'+source.agent_revision+' → 新任务 v'+agent.revision+'。';
 else version='本次使用 '+agent.name+' · v'+agent.revision+'；原配置版本可在来源任务中查看。';
 node.innerHTML=`<h3>基于已有任务新建</h3><p>带入初始目标，可继续修改。后续对话和执行结果不带入，新任务使用本次选择的智能体配置。</p><p id="task-source-version">${esc(version)}</p><p class="field-help">来源任务：<span>${esc(source.run_id)}</span></p>`;
}
