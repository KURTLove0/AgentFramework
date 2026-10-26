'use strict';
// The inspector and canvas edit one local draft. Saved definitions remain versioned.
let flowDesign={nodes:[],selected:null,connecting:null,seedOnly:false,fit:false,zoom:1,positions:{},undo:null};
let flowPointer=null;
const flowCanvasLimits={minZoom:.35,maxZoom:1.75,coordinate:8192};
let flowEditorBaseline=null,flowEditorSaving=false,lastFlowEditorFocus=null;
let flowEditorDisabledControls=[];
const flowFieldNames={risk_level:'风险等级',citations_count:'引用数量',answer:'回答正文'};
const flowOperators={eq:'等于',ne:'不等于',gte:'大于等于',lte:'小于等于',contains:'包含'};
const flowRiskLabels={HIGH:'高风险',MEDIUM:'中风险',LOW:'低风险'};
function flowConditionText(n,nodes=flowDesign.nodes){const c=n.condition;if(!c)return '上游验收成功后继续';const source=nodes.find(v=>v.id===c.source)?.name||c.source,value=c.field==='risk_level'?(flowRiskLabels[c.value]||c.value):c.value;return `当「${source}」的${flowFieldNames[c.field]||c.field} ${flowOperators[c.operator]||c.operator} ${value}`;}
function flowAgent(id){return (state.agents||[]).find(a=>a.id===id);}
function flowNewNode(agent,depends=[]){return {id:'node-'+crypto.randomUUID().slice(0,8),name:agent.name,agent_id:agent.id,agent_revision:agent.revision,goal:agent.definition?.domain_pack_ref==='knowledge-answer@1.0.0'?'检索当前空间已发布的风险与草稿验收规范，提供原文引用。':'结合上游知识与可信工具证据评估模拟变更，按岗位标准创建评估草稿。',depends_on:depends};}
function flowDesignMessage(text){
  const box=$('#flow-designer-status');box.innerHTML=`<span>${esc(text)}</span>${flowDesign.connecting?' <button type="button" class="text-button flow-connection-cancel" data-flow-cancel-connect>取消连线</button>':''}${flowDesign.undo?' <button type="button" class="text-button" data-flow-undo>撤销删除</button>':''}`;
}
function flowEditorSnapshot(){
  // Include the complete editable draft, including layout data when available.
  // Selection, connection previews, viewport zoom and undo history are UI state.
  const rendered=Object.fromEntries($$('.flow-canvas-node',$('#flow-canvas')).map(card=>[card.dataset.flowPosition,{left:card.style.left,top:card.style.top}]));
  return JSON.stringify({name:$('#flow-name').value,description:$('#flow-description').value,nodes:flowDesign.nodes,positions:flowDesign.positions||null,rendered});
}
function flowEditorIsDirty(){return flowEditorBaseline!==null&&flowEditorSnapshot()!==flowEditorBaseline;}
function flowEditorMarkSaved(){flowEditorBaseline=flowEditorSnapshot();}
function flowEditorSetSaving(saving){
  flowEditorSaving=saving;const form=$('#flow-editor-form');
  if(saving){form.setAttribute('aria-busy','true');flowEditorDisabledControls=$$('input,select,textarea,button',form).filter(field=>!field.hasAttribute('data-close')).map(field=>({field,disabled:field.disabled}));for(const {field} of flowEditorDisabledControls)field.disabled=true;}
  else{form.removeAttribute('aria-busy');for(const {field,disabled} of flowEditorDisabledControls)field.disabled=disabled;flowEditorDisabledControls=[];}
}
function restoreFlowEditorFocus(){
  const saved=lastFlowEditorFocus;let field=saved?.id?$('#'+saved.id):null;
  if(!field&&saved?.key){const attr=saved.key.replace(/[A-Z]/g,m=>'-'+m.toLowerCase());field=$(`[data-${attr}="${CSS.escape(saved.value)}"]`,$('#flow-inspector'));}
  field=field||$('[data-design-field="name"]',$('#flow-inspector'))||$('#flow-name');field.focus({preventScroll:true});
  if(saved?.selection&&field.setSelectionRange)try{field.setSelectionRange(...saved.selection);}catch(_){}
}
function requestFlowEditorClose(){
  const editor=$('#flow-editor-dialog');if(flowEditorSaving){toast('正在保存工作流，请稍候。');return;}
  if(!flowEditorIsDirty()){editor.close();return;}
  const dialog=$('#confirm-dialog');if(dialog.open)return;
  $('#confirm-title').textContent='放弃工作流的未保存更改？';$('#confirm-body').innerHTML='<p>节点、分支或基本信息的更改尚未保存。返回可继续编辑；放弃后保留上一次保存的版本。</p>';$('#confirm-error').hidden=true;$('#confirm-error').textContent='';
  const submit=$('#confirm-submit'),back=$('.dialog-foot [data-close]',dialog);submit.disabled=false;submit.removeAttribute('aria-busy');submit.textContent='放弃并关闭';submit.className='button danger';submit.onclick=null;
  for(const button of $$('[data-close]',dialog)){button.disabled=false;button.removeAttribute('aria-busy');}
  if(back){back.textContent='返回编辑';back.className='button secondary';back.onclick=null;}
  let discarded=false;
  dialog.addEventListener('close',()=>{submit.onclick=null;submit.disabled=false;submit.removeAttribute('aria-busy');submit.textContent='确认';submit.className='button primary';if(back){back.textContent='返回';back.className='button secondary';back.disabled=false;back.removeAttribute('aria-busy');}if(!discarded&&editor.open)restoreFlowEditorFocus();},{once:true});
  submit.onclick=()=>{discarded=true;dialog.close();editor.close();};dialog.showModal();(back||dialog.querySelector('[data-close]'))?.focus();
}
function openVisualFlowEditor(w=null){
  const active=(state.agents||[]).filter(a=>!a.archived);if(!active.length){toast('请先在 Agent 模块配置一个可用 Agent');return;}
  const f=$('#flow-editor-form');f.dataset.id=w?.id||'';f.dataset.revision=w?.revision||0;$('#flow-editor-title').textContent=w?.id?'编辑工作流':w?'审查工作流提案':'创建工作流';$('#flow-name').value=w?.name||'';$('#flow-description').value=w?.description||'';$('#flow-metadata').open=!w?.id;$('#flow-metadata summary').textContent=w?.name?'基本信息 · '+w.name:'1. 命名工作流';
  flowDesign={nodes:structuredClone(w?.nodes?.length?w.nodes:[flowNewNode(active[0])]),selected:null,connecting:null,seedOnly:!w,fit:false,zoom:1,positions:{},mobilePane:'canvas',invalidNode:null,undo:null};flowDesign.positions=flowLoadLayout(w?.id);flowPointer=null;flowDesign.selected=flowDesign.nodes[0].id;
  flowEditorSaving=false;lastFlowEditorFocus=null;flowEnsureCanvasControls();flowSetMobilePane('canvas');$('#flow-editor-error').hidden=true;renderFlowDesign();flowEditorMarkSaved();flowDesignMessage('2. 选择节点编辑属性；拖动节点右上角手柄调整布局，空白处拖动平移。保存后可创建运行。');$('#flow-editor-dialog').showModal();
  if(flowIsMobile())$('.flow-canvas-viewport').focus({preventScroll:true});else if(!w?.id)$('#flow-name').focus();else $('[data-design-field="name"]')?.focus();
}
function flowLayoutKey(identity){return identity?'agent-framework:flow-layout:'+JSON.stringify([state.meta?.tenant||'local',state.workspaceId||'workspace-default',identity]):null;}
function flowCleanPositions(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  const clean={};for(const node of flowDesign.nodes){const p=value[node.id];if(p&&Number.isFinite(p.x)&&Number.isFinite(p.y))clean[node.id]={x:Math.min(flowCanvasLimits.coordinate,Math.max(24,p.x)),y:Math.min(flowCanvasLimits.coordinate,Math.max(64,p.y))};}return clean;
}
function flowLoadLayout(identity){try{const key=flowLayoutKey(identity),raw=key?window.localStorage.getItem(key):null;return raw&&raw.length<8192?flowCleanPositions(JSON.parse(raw)):{};}catch(_){return {};}}
function flowSaveLayout(workflow){try{const key=flowLayoutKey(workflow?.id);if(!key)return false;window.localStorage.setItem(key,JSON.stringify(flowCleanPositions(flowDesign.positions)));return true;}catch(_){return false;}}
function flowEnsureCanvasControls(){
  if($('#flow-canvas-controls'))return;
  $('.flow-designer-toolbar').insertAdjacentHTML('afterend',`<div id="flow-canvas-controls" class="flow-canvas-controls" role="toolbar" aria-label="画布导航"><div class="toolbar"><button type="button" class="button secondary" data-flow-zoom="out" aria-label="缩小画布">−</button><button type="button" class="button secondary" data-flow-zoom="reset" aria-label="恢复到 100%" id="flow-zoom-label">100%</button><button type="button" class="button secondary" data-flow-zoom="in" aria-label="放大画布">＋</button><button type="button" class="button secondary" data-flow-locate aria-label="定位选中节点">定位</button><button type="button" class="button secondary" data-flow-arrange aria-label="自动整理">整理</button></div><small class="field-help flow-node-layout-help">拖动手柄移动节点 · 空白处拖动平移 · 布局仅保存在此浏览器</small></div>`);
  const viewport=$('.flow-canvas-viewport');viewport.id='flow-canvas-region';viewport.tabIndex=0;viewport.setAttribute('role','region');viewport.setAttribute('aria-label','工作流画布。可滚动，使用加减键缩放，按 0 恢复大小。');
  $('#flow-canvas-controls').insertAdjacentHTML('afterend','<div class="flow-mobile-panes" role="tablist" aria-label="工作流编辑区域"><button type="button" class="button secondary" role="tab" id="flow-pane-canvas" data-flow-pane="canvas" aria-controls="flow-canvas-region">画布</button><button type="button" class="button secondary" role="tab" id="flow-pane-inspector" data-flow-pane="inspector" aria-controls="flow-inspector">节点配置</button></div>');
}
function flowIsMobile(){return Boolean(window.matchMedia?.('(max-width:959px)').matches);}
function flowSetMobilePane(pane,reveal=false){
  pane=pane==='inspector'?'inspector':'canvas';const previous=flowDesign.mobilePane;flowDesign.mobilePane=pane;const mobile=flowIsMobile(),viewport=$('.flow-canvas-viewport'),inspector=$('#flow-inspector'),designer=$('.flow-designer');if(designer)designer.dataset.mobilePane=pane;
  viewport.hidden=mobile&&pane!=='canvas';inspector.hidden=mobile&&pane!=='inspector';
  for(const button of $$('[data-flow-pane]')){button.setAttribute('aria-selected',String(button.dataset.flowPane===pane));button.tabIndex=button.dataset.flowPane===pane?0:-1;}
  const active=document.activeElement;if(mobile&&((viewport.hidden&&active?.closest('.flow-canvas-viewport'))||(inspector.hidden&&active?.closest('#flow-inspector'))))$('[data-flow-pane="'+pane+'"]')?.focus({preventScroll:true});
  if(!viewport.hidden){flowPlaceCanvas();if(mobile&&previous!==pane)flowRevealNode();}if(mobile&&reveal)(pane==='canvas'?viewport:inspector).scrollIntoView({block:'nearest',behavior:'instant'});
}
function flowPositions(){
  const depths={},positions={},counts={},saved=flowCleanPositions(flowDesign.positions);for(let i=0;i<flowDesign.nodes.length;i++)for(const n of flowDesign.nodes){if(n.id in depths)continue;if(n.depends_on.every(d=>d in depths))depths[n.id]=n.depends_on.length?Math.max(...n.depends_on.map(d=>depths[d]))+1:0;}
  Object.assign(positions,saved);
  for(const n of flowDesign.nodes){const level=depths[n.id]??0,row=counts[level]||0;counts[level]=row+1;if(positions[n.id])continue;const p={x:36+level*320,y:72+row*260};while(Object.values(positions).some(q=>Math.abs(q.x-p.x)<280&&Math.abs(q.y-p.y)<224))p.y+=260;positions[n.id]=p;}return positions;
}
function flowCanvasZoom(){const canvas=$('#flow-canvas');return Number(canvas.dataset.zoom)||1;}
function flowRelations(identity){
  const upstream=new Set(),downstream=new Set();function walk(id,forward,seen){for(const n of flowDesign.nodes){const next=forward?n.depends_on.includes(id):n.id===id;if(!next)continue;for(const key of forward?[n.id]:n.depends_on)if(!seen.has(key)&&key!==identity){seen.add(key);walk(key,forward,seen);}}}walk(identity,false,upstream);walk(identity,true,downstream);return {upstream,downstream};
}
function flowPlaceCanvas(){
  const canvas=$('#flow-canvas'),positions=flowPositions(),nodes=flowDesign.nodes,viewport=$('.flow-canvas-viewport');
  const dimensions={};for(const card of $$('.flow-canvas-node',canvas)){const p=positions[card.dataset.flowPosition];if(!p)continue;card.style.left=p.x+'px';card.style.top=p.y+'px';card.classList.toggle('dragging',flowPointer?.kind==='node'&&flowPointer.node===card.dataset.flowPosition&&flowPointer.moved);dimensions[card.dataset.flowPosition]={width:card.offsetWidth||248,height:card.offsetHeight||190};}
  const contentWidth=Math.max(1,...nodes.map(n=>positions[n.id].x+(dimensions[n.id]?.width||248)+36)),contentHeight=Math.max(1,...nodes.map(n=>positions[n.id].y+(dimensions[n.id]?.height||190)+48));
  const width=Math.max(630,contentWidth),height=Math.max(420,contentHeight);
  const zoom=flowDesign.fit?Math.min(1,Math.max(flowCanvasLimits.minZoom,Math.min((viewport.clientWidth-24)/contentWidth,(viewport.clientHeight-24)/contentHeight))):Math.min(flowCanvasLimits.maxZoom,Math.max(flowCanvasLimits.minZoom,flowDesign.zoom||1));canvas.style.width=width+'px';canvas.style.height=height+'px';canvas.style.zoom=String(zoom);canvas.dataset.zoom=String(zoom);
  const label=$('#flow-zoom-label');if(label)label.textContent=Math.round(zoom*100)+'%';
  const coordinates=$('[data-flow-coordinates]',$('#flow-inspector')),selected=positions[flowDesign.selected];if(coordinates&&selected)coordinates.textContent=`横向 ${Math.round(selected.x)} · 纵向 ${Math.round(selected.y)}`;
  const fit=$('[data-flow-fit]');fit.setAttribute('aria-pressed',String(flowDesign.fit));fit.textContent=flowDesign.fit?'原始大小':'适应画布';
  for(const button of $$('[data-flow-zoom]')){const action=button.dataset.flowZoom;button.disabled=flowEditorSaving||(action==='in'&&zoom>=flowCanvasLimits.maxZoom)||(action==='out'&&zoom<=flowCanvasLimits.minZoom);}
  let edges='';for(const n of nodes)for(const parent of n.depends_on){const a=positions[parent],b=positions[n.id];if(!a||!b)continue;const x=a.x+(dimensions[parent]?.width||248),y=a.y+(dimensions[parent]?.height||190)/2,tx=b.x,ty=b.y+(dimensions[n.id]?.height||190)/2,mid=(x+tx)/2,related=n.id===flowDesign.selected||parent===flowDesign.selected;edges+=`<path class="${n.condition?'conditional ':''}${related?'related':''}" d="M${x},${y} C${mid},${y} ${mid},${ty} ${tx},${ty}" marker-end="url(#flow-arrow)"/><text x="${mid}" y="${(y+ty)/2-8}" text-anchor="middle">${n.condition?.source===parent?esc(flowOperators[n.condition.operator]+' '+(flowRiskLabels[n.condition.value]||n.condition.value)):'验收后'}</text>`;}
  const svg=$('.flow-edges',canvas);if(svg){svg.setAttribute('width',width);svg.setAttribute('height',height);svg.innerHTML='<defs><marker id="flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8"/></marker></defs>'+edges;}
}
function drawFlowCanvas(){
  const nodes=flowDesign.nodes,canvas=$('#flow-canvas'),active=document.activeElement,relations=flowRelations(flowDesign.selected),ancestors=flowDesign.connecting?flowRelations(flowDesign.connecting).upstream:new Set();
  const focus=active?.closest('#flow-canvas')?['flowSelect','flowInput','flowOutput','flowDrag'].find(key=>active.dataset[key]):null,focusId=focus?active.dataset[focus]:null;
  canvas.setAttribute('role','group');canvas.setAttribute('aria-label',`工作流画布，${nodes.length} 个节点。方向键选择节点，Tab 进入配置或移动手柄。`);
  const add=$('[data-add-flow-node]');add.disabled=flowEditorSaving||nodes.length>=12;add.title=add.disabled?'最多支持 12 个 Agent 节点':'添加一个 Agent 节点';$('[data-flow-branch]').disabled=flowEditorSaving||nodes.length>10;
  canvas.innerHTML=`<div class="flow-canvas-caption">${nodes.length} 个节点 · 检索知识 → Agent 执行 → 独立验收</div><svg class="flow-edges" aria-hidden="true"></svg>${nodes.map((n,i)=>{const a=flowAgent(n.agent_id),selected=flowDesign.selected===n.id,stage=n.retrieval?'知识检索':n.condition?'条件分支':n.join==='any'?'分支汇合':'Agent 执行',blocked=flowDesign.connecting&&(n.id===flowDesign.connecting||ancestors.has(n.id));return `<article class="flow-canvas-node ${selected?'selected ':''}${flowDesign.connecting===n.id?'connecting ':''}${relations.upstream.has(n.id)?'upstream ':''}${relations.downstream.has(n.id)?'downstream ':''}${flowDesign.invalidNode===n.id?'invalid ':''}${flowPointer?.node===n.id&&flowPointer.moved?'dragging ':''}${flowDesign.connecting&&!blocked?'connect-target':''}" data-flow-position="${esc(n.id)}"><button type="button" class="flow-port input" data-flow-input="${esc(n.id)}" tabindex="${selected?0:-1}" ${blocked?'disabled':''} aria-label="连接到 ${esc(n.name)}${blocked?'，此连接会形成循环':''}" title="${blocked?'不能连接到起点或其上游':'连接到此节点'}">＋</button><button type="button" class="flow-node-drag" data-flow-drag="${esc(n.id)}" tabindex="${selected?0:-1}" aria-label="移动 ${esc(n.name)}。拖动或使用方向键，Shift 加速" title="拖动移动 · 方向键微调 · Shift 加速"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${[6,12,18].map(y=>`<circle cx="9" cy="${y}" r="1.5"/><circle cx="15" cy="${y}" r="1.5"/>`).join('')}</svg></button><button type="button" class="flow-node-select" data-flow-select="${esc(n.id)}" aria-pressed="${selected}" aria-controls="flow-inspector" tabindex="${selected?0:-1}"><span class="flow-node-stage">${String(i+1).padStart(2,'0')} / ${stage}</span><strong>${esc(n.name||'未命名节点')}</strong><small>${esc(a?.name||'Agent 不可用')} · v${n.agent_revision}</small><span class="flow-node-summary">${n.retrieval?`最多 ${n.retrieval.top_k} 条知识 · ${esc(n.retrieval.query)}`:n.condition?esc(flowConditionText(n)):n.depends_on.length?`${n.depends_on.length} 条输入 · ${n.join==='any'?'任一成功后汇合':'全部成功后继续'}`:'接收流程输入'}</span></button><button type="button" class="flow-port output" data-flow-output="${esc(n.id)}" tabindex="${selected?0:-1}" aria-label="${flowDesign.connecting===n.id?'取消从':'从'} ${esc(n.name)} 连线" aria-pressed="${flowDesign.connecting===n.id}" title="${flowDesign.connecting===n.id?'取消连线':'从此节点开始连线'}">→</button></article>`;}).join('')}`;
  flowPlaceCanvas();
  if(focus){const attr=focus.replace(/[A-Z]/g,m=>'-'+m.toLowerCase());$(`[data-${attr}="${CSS.escape(focusId)}"]`,canvas)?.focus({preventScroll:true});}
}
function flowRevealNode(identity=flowDesign.selected){
  const p=flowPositions()[identity],viewport=$('.flow-canvas-viewport');if(!p||!viewport)return;const card=$(`[data-flow-position="${CSS.escape(identity)}"]`,$('#flow-canvas')),zoom=flowCanvasZoom();viewport.scrollLeft=Math.max(0,(p.x+(card?.offsetWidth||248)/2)*zoom-viewport.clientWidth/2);viewport.scrollTop=Math.max(0,(p.y+(card?.offsetHeight||190)/2)*zoom-viewport.clientHeight/2);
}
function flowSetZoom(value,anchor=null){
  if(flowEditorSaving)return;flowSetMobilePane('canvas',true);const viewport=$('.flow-canvas-viewport'),old=flowCanvasZoom(),point=anchor||{x:viewport.clientWidth/2,y:viewport.clientHeight/2},logical={x:(viewport.scrollLeft+point.x)/old,y:(viewport.scrollTop+point.y)/old};flowDesign.fit=false;flowDesign.zoom=Math.min(flowCanvasLimits.maxZoom,Math.max(flowCanvasLimits.minZoom,value));flowPlaceCanvas();viewport.scrollLeft=Math.max(0,logical.x*flowCanvasZoom()-point.x);viewport.scrollTop=Math.max(0,logical.y*flowCanvasZoom()-point.y);
}
function flowMoveNode(identity,x,y,snap=true){
  if(flowEditorSaving||!flowDesign.nodes.some(n=>n.id===identity))return false;
  const prior=flowPositions(),next={x:Math.min(flowCanvasLimits.coordinate,Math.max(24,snap?Math.round(x/8)*8:x)),y:Math.min(flowCanvasLimits.coordinate,Math.max(64,snap?Math.round(y/8)*8:y))};if(prior[identity].x===next.x&&prior[identity].y===next.y)return false;
  flowDesign.positions={...prior,[identity]:next};flowDesign.seedOnly=false;flowInvalidateUndo();flowPlaceCanvas();return true;
}
function flowFinishPointer(cancel=false){
  const pointer=flowPointer;if(!pointer)return;flowPointer=null;const canvas=$('#flow-canvas'),viewport=$('.flow-canvas-viewport');
  if(cancel&&pointer.kind==='node'){flowDesign.positions=pointer.positions;flowDesign.seedOnly=pointer.seedOnly;flowDesign.undo=pointer.undo;flowDesign.fit=pointer.fit;flowDesign.zoom=pointer.zoom;}
  if(viewport.hasPointerCapture?.(pointer.id))viewport.releasePointerCapture(pointer.id);viewport.classList.remove('panning');
  if(pointer.kind==='node'){drawFlowCanvas();if(pointer.moved)flowDesignMessage(cancel?'已取消移动，节点恢复原位置。':'节点位置已更新。可继续编辑属性，或保存工作流保留此浏览器的布局。');}
}

function renderFlowInspector(){
  const n=flowDesign.nodes.find(n=>n.id===flowDesign.selected);if(!n){$('#flow-inspector').innerHTML='<p class="field-help">选择画布中的节点，配置执行 Agent 和结果要求。</p>';return;}
  const active=(state.agents||[]).filter(a=>!a.archived),others=flowDesign.nodes.filter(v=>v.id!==n.id),c=n.condition;
  $('#flow-inspector').innerHTML=`<div class="mini-heading"><div><p class="eyebrow">节点 ${flowDesign.nodes.indexOf(n)+1} / ${flowDesign.nodes.length}</p><h3>节点配置</h3></div><span class="pill">${n.retrieval?'知识检索':c?'条件分支':'Agent 执行'}</span></div><p class="field-help flow-designer-context">${n.depends_on.length?'此节点接收上游已验收的结果。':'起始节点，接收本次运行的输入。'}</p><label>节点名称<input data-design-field="name" value="${esc(n.name)}" required maxlength="100" autocomplete="off"></label><label>执行 Agent<select data-design-field="agent_id" required>${!active.some(a=>a.id===n.agent_id&&a.revision===n.agent_revision)?`<option value="" selected disabled>原固定版本 v${esc(n.agent_revision)} 已更新或不可用，请重新选择</option>`:''}${active.map(a=>`<option value="${esc(a.id)}" ${n.agent_id===a.id&&n.agent_revision===a.revision?'selected':''}>${esc(a.name)} · v${a.revision}</option>`).join('')}</select></label>${!active.some(a=>a.id===n.agent_id&&a.revision===n.agent_revision)?'<p class="inline-error" role="alert">原固定版本已更新或停用。请选择当前可用智能体，核对职责与目标后再保存。</p>':''}<label>节点目标<textarea data-design-field="goal" required maxlength="2000" rows="3">${esc(n.goal)}</textarea></label><fieldset class="flow-dependencies"><legend>从哪些上游接收结果</legend>${others.map(d=>`<label class="check-label"><input type="checkbox" data-flow-dependency="${esc(d.id)}" ${n.depends_on.includes(d.id)?'checked':''}><span>${esc(d.name||'未命名节点')}</span></label>`).join('')||'<small>添加另一个节点后，可在这里建立连接。</small>'}</fieldset><label>上游完成时如何继续<select data-design-field="join" ${n.depends_on.length?'':'disabled'}><option value="all" ${n.join!=='any'?'selected':''}>全部上游成功</option><option value="any" ${n.join==='any'?'selected':''}>任一上游成功</option></select></label><p class="field-help">等待所有上游结束后汇合；“任一成功”适合合并互斥分支，被跳过的分支不创建任务。</p><section class="flow-config-section"><label class="check-label"><input type="checkbox" data-design-toggle="retrieval" ${n.retrieval?'checked':''}><span>先检索知识（RAG）</span></label>${n.retrieval?`<label>要检索什么<textarea data-retrieval-field="query" rows="2" required maxlength="2000">${esc(n.retrieval.query)}</textarea></label><label>最多引用条数（Top K）<input type="number" data-retrieval-field="top_k" min="1" max="8" value="${n.retrieval.top_k}" required inputmode="numeric"></label><p class="field-help">只检索当前空间中你可见、已发布的知识。知识问答 Agent 无命中时等待补充材料；引用验收后再传给下游。其他 Agent 将检索结果用作模型参考，必选标准仍保留。</p>`:'<p class="field-help">将当前空间的知识作为节点参考，可配置查询词与引用数量。</p>'}</section><section class="flow-config-section"><label class="check-label"><input type="checkbox" data-design-toggle="condition" ${c?'checked':''} ${n.depends_on.length?'':'disabled'}><span>仅在满足条件时执行</span></label>${c?`<label>依据哪个上游<select data-condition-field="source">${n.depends_on.map(id=>`<option value="${esc(id)}" ${c.source===id?'selected':''}>${esc(flowDesign.nodes.find(v=>v.id===id)?.name||id)}</option>`).join('')}</select></label><label>检查结果字段<select data-condition-field="field">${Object.entries(flowFieldNames).map(([v,label])=>`<option value="${v}" ${c.field===v?'selected':''}>${label}</option>`).join('')}</select></label><div class="form-grid"><label>比较方式<select data-condition-field="operator">${Object.entries(flowOperators).filter(([v])=>c.field==='risk_level'?['eq','ne'].includes(v):c.field==='answer'?['eq','ne','contains'].includes(v):['eq','ne','gte','lte'].includes(v)).map(([v,label])=>`<option value="${v}" ${c.operator===v?'selected':''}>${label}</option>`).join('')}</select></label><label>比较值${c.field==='risk_level'?`<select data-condition-field="value">${Object.entries(flowRiskLabels).map(([v,label])=>`<option value="${v}" ${c.value===v?'selected':''}>${label} · ${v}</option>`).join('')}</select>`:`<input data-condition-field="value" ${c.field==='citations_count'?'type="number" min="0" max="8" inputmode="numeric"':'maxlength="1000"'} value="${esc(c.value)}" required>`}</label></div><p class="flow-config-summary">${esc(flowConditionText(n))}</p><p class="field-help">只使用上游已验收的结果。字段缺失或条件不匹配时，跳过此节点。</p>`:`<p class="field-help">${n.depends_on.length?'可根据上游风险等级、引用数量或回答正文决定是否执行。':'先选择上游节点，再设置进入此节点的条件。'}</p>`}</section><details class="flow-config-section flow-node-position"><summary>调整节点位置</summary><p class="field-help">点击方向按钮每次移动 8 像素；移动手柄仍支持方向键与 Shift 加速。</p><output class="field-help" data-flow-coordinates>横向 ${Math.round(flowPositions()[n.id].x)} · 纵向 ${Math.round(flowPositions()[n.id].y)}</output><div class="flow-position-controls">${[['up','上移'],['left','左移'],['down','下移'],['right','右移']].map(([direction,label])=>`<button type="button" class="button secondary" data-flow-nudge="${direction}" aria-label="${label}节点 8 像素">${label}</button>`).join('')}</div></details><button type="button" class="text-button" data-flow-delete ${flowDesign.nodes.length===1?'disabled':''}>删除此节点</button>${flowDesign.nodes.length===1?'<p class="field-help">工作流至少需要一个 Agent 节点。</p>':''}`;
}
function flowCaptureInspectorFocus(){const a=document.activeElement;if(!a?.closest('#flow-inspector'))return null;const key=['designField','retrievalField','conditionField','flowDependency','designToggle'].find(k=>a.dataset[k]);return key?{key,value:a.dataset[key],start:a.selectionStart,end:a.selectionEnd,scroll:$('#flow-inspector').scrollTop}:null;}
function renderFlowDesign(){
  const focus=flowCaptureInspectorFocus();drawFlowCanvas();renderFlowInspector();
  if(focus){const attr=focus.key.replace(/[A-Z]/g,m=>'-'+m.toLowerCase()),target=$(`[data-${attr}="${CSS.escape(focus.value)}"]`,$('#flow-inspector'));if(target){target.focus({preventScroll:true});if(typeof target.setSelectionRange==='function'&&focus.start!==null)try{target.setSelectionRange(focus.start,focus.end);}catch(_){}$('#flow-inspector').scrollTop=focus.scroll;}}
}
function flowValidateGraph(){
  const ids=new Set(flowDesign.nodes.map(n=>n.id));
  for(const n of flowDesign.nodes){if(n.depends_on.some(id=>!ids.has(id)||id===n.id))throw Error('上游必须是当前流程中的其他节点。');if(new Set(n.depends_on).size!==n.depends_on.length)throw Error('同一上游只需连接一次。');}
  const done=new Set();for(let i=0;i<flowDesign.nodes.length;i++)for(const n of flowDesign.nodes)if(n.depends_on.every(d=>done.has(d)))done.add(n.id);
  if(done.size!==flowDesign.nodes.length)throw Error('这条连接会形成循环。请从前序节点连接到后续节点。');
}
function flowDesignInvalid(n,message,selector){flowDesign.selected=n.id;flowDesign.invalidNode=n.id;flowSetMobilePane('inspector',true);renderFlowDesign();flowRevealNode(n.id);const control=selector?$(selector,$('#flow-inspector')):null;if(control){control.setAttribute('aria-invalid','true');control.setAttribute('aria-describedby','flow-editor-error');}flowDesignMessage(`「${n.name||'未命名节点'}」：${message}`);return Error(`「${n.name||'未命名节点'}」：${message}`);}
function serializeFlowDesign(){
  if(!flowDesign.nodes.length)throw Error('至少保留一个 Agent 节点。');
  flowValidateGraph();
  for(const n of flowDesign.nodes){
    const a=flowAgent(n.agent_id);if(!a||a.archived)throw flowDesignInvalid(n,'请选择一个可用 Agent。','[data-design-field="agent_id"]');n.agent_revision=a.revision;
    if(!n.name.trim())throw flowDesignInvalid(n,'请填写节点名称。','[data-design-field="name"]');if(!n.goal.trim())throw flowDesignInvalid(n,'请说明此节点要完成的目标。','[data-design-field="goal"]');
    if(n.retrieval&&(!n.retrieval.query.trim()||!Number.isInteger(n.retrieval.top_k)||n.retrieval.top_k<1||n.retrieval.top_k>8))throw flowDesignInvalid(n,'请填写检索查询，并将最多引用条数设为 1–8 的整数。','[data-retrieval-field="query"]');
    if(n.condition){const c=n.condition;if(!n.depends_on.includes(c.source))throw flowDesignInvalid(n,'条件来源需要选择直接相连的上游。','[data-condition-field="source"]');if(c.field==='citations_count'&&(!Number.isInteger(c.value)||c.value<0||c.value>8))throw flowDesignInvalid(n,'引用数量需要是 0–8 的整数。','[data-condition-field="value"]');}
  }
  return structuredClone(flowDesign.nodes);
}
function flowDefaultCondition(source){const qa=flowAgent(source.agent_id)?.definition?.domain_pack_ref==='knowledge-answer@1.0.0';return {source:source.id,field:qa?'citations_count':'risk_level',operator:qa?'gte':'eq',value:qa?1:'HIGH'};}
function flowInvalidateUndo(){flowDesign.undo=null;$('[data-flow-undo]',$('#flow-editor-dialog'))?.remove();}
function flowCancelConnection(){flowDesign.connecting=null;drawFlowCanvas();flowDesignMessage('已取消连线，现有连接保持不变。');}
function flowSelectNode(id,focusName=false,reveal=true,showInspector=focusName){const changed=flowDesign.selected!==id;flowDesign.selected=id;renderFlowDesign();if(changed)$('#flow-inspector').scrollTop=0;if(reveal)flowRevealNode(id);if(showInspector)flowSetMobilePane('inspector',true);if(focusName)$('[data-design-field="name"]',$('#flow-inspector'))?.focus();}
function flowConnect(from,to){
  if(!from||!to||from===to.id){flowDesignMessage('先选择一个上游的输出端口，再选择其他节点的输入端口。');return;}
  const prior=[...to.depends_on];if(!to.depends_on.includes(from))to.depends_on.push(from);
  try{flowValidateGraph();flowInvalidateUndo();flowDesign.seedOnly=false;flowDesign.selected=to.id;flowDesign.connecting=null;renderFlowDesign();flowDesignMessage(`已连接到「${to.name}」。可在节点配置中设置分支条件。`);}catch(error){to.depends_on=prior;flowDesignMessage(error.message);}
}
document.addEventListener('click',e=>{
  if(!e.target.closest('#flow-editor-dialog'))return;
  const find=attr=>e.target.closest('[data-'+attr+']');
  if(flowEditorSaving&&!find('close'))return;
  if(find('flow-fit')){flowSetMobilePane('canvas',true);flowDesign.fit=!flowDesign.fit;if(!flowDesign.fit)flowDesign.zoom=1;flowPlaceCanvas();const viewport=$('.flow-canvas-viewport');if(flowDesign.fit){viewport.scrollLeft=0;viewport.scrollTop=0;}else flowRevealNode();flowDesignMessage(flowDesign.fit?'已适应画布。使用加减按钮可继续缩放。':'已恢复原始大小，并定位到选中节点。');}
  const zoom=find('flow-zoom');if(zoom)flowSetZoom(zoom.dataset.flowZoom==='reset'?1:flowCanvasZoom()*(zoom.dataset.flowZoom==='in'?1.2:1/1.2));
  if(find('flow-locate')){flowSetMobilePane('canvas',true);flowRevealNode();flowDesignMessage('已将选中节点移到画布视野中央。');}
  if(find('flow-arrange')){flowSetMobilePane('canvas',true);flowDesign.positions={};flowInvalidateUndo();drawFlowCanvas();flowRevealNode();flowDesignMessage('已按执行依赖自动整理。连线与分支规则保持不变，保存后保留此布局。');}
  const pane=find('flow-pane');if(pane)flowSetMobilePane(pane.dataset.flowPane,true);
  const nudge=find('flow-nudge');if(nudge){const p=flowPositions()[flowDesign.selected],direction=nudge.dataset.flowNudge;flowMoveNode(flowDesign.selected,p.x+(direction==='right'?8:direction==='left'?-8:0),p.y+(direction==='down'?8:direction==='up'?-8:0),false);flowDesignMessage('节点位置已调整，可切换到画布查看。');}
  if(find('flow-cancel-connect'))flowCancelConnection();
  if(find('flow-focus-invalid')){const control=$('[aria-invalid="true"]',$('#flow-inspector'));control?.focus({preventScroll:true});control?.scrollIntoView({block:'nearest'});}
  const select=find('flow-select'),output=find('flow-output'),input=find('flow-input');
  if(select)flowSelectNode(select.dataset.flowSelect,false,true,true);
  if(output){if(flowDesign.connecting===output.dataset.flowOutput)flowCancelConnection();else{flowDesign.connecting=output.dataset.flowOutput;drawFlowCanvas();flowDesignMessage('已选择连线起点。点击目标的 ＋ 完成连接；按 Esc 可取消。也可在节点配置中勾选上游。');}}
  if(input)flowConnect(flowDesign.connecting,flowDesign.nodes.find(n=>n.id===input.dataset.flowInput));
  if(find('add-flow-node')){if(flowDesign.nodes.length>=12){toast('最多支持 12 个 Agent 节点');return;}flowInvalidateUndo();flowDesign.seedOnly=false;const a=(state.agents||[]).find(a=>!a.archived);if(!a){toast('请先配置一个可用 Agent');return;}const n=flowNewNode(a);flowDesign.nodes.push(n);flowSelectNode(n.id,true);flowDesignMessage('已添加节点。先选择执行 Agent，再设置目标和上游连接。');}
  if(find('flow-delete')){if(flowDesign.nodes.length===1)return;flowDesign.undo={nodes:structuredClone(flowDesign.nodes),positions:structuredClone(flowDesign.positions||{}),selected:flowDesign.selected};const id=flowDesign.selected,name=flowDesign.nodes.find(n=>n.id===id)?.name;flowDesign.nodes=flowDesign.nodes.filter(n=>n.id!==id);delete flowDesign.positions[id];for(const n of flowDesign.nodes){n.depends_on=n.depends_on.filter(d=>d!==id);if(n.condition?.source===id)delete n.condition;}flowDesign.selected=flowDesign.nodes[0].id;flowDesign.connecting=null;flowDesign.seedOnly=false;renderFlowDesign();flowDesignMessage(`已删除「${name}」及其连线。依赖它的条件已清除，保存前请检查下游配置。`);}
  if(find('flow-undo')&&flowDesign.undo){const prior=flowDesign.undo;flowDesign.nodes=prior.nodes;flowDesign.positions=prior.positions||{};flowDesign.selected=prior.selected;flowDesign.undo=null;flowDesign.connecting=null;renderFlowDesign();flowDesignMessage('节点与原有连接已恢复。');}
  if(find('flow-rag-template')){const qa=(state.agents||[]).find(a=>!a.archived&&a.definition?.domain_pack_ref==='knowledge-answer@1.0.0'),writer=(state.agents||[]).find(a=>!a.archived&&a.definition?.domain_pack_ref==='change-assessment@2.0.0');if(!qa||!writer){toast('请先配置知识问答 Agent 和变更评估 Agent，再使用此模板');return;}if((flowDesign.seedOnly?0:flowDesign.nodes.length)+2>12){toast('此模板需要两个可用节点位置（最多 12 个）');return;}if(flowDesign.seedOnly)flowDesign.nodes=[];flowInvalidateUndo();flowDesign.seedOnly=false;flowDesign.connecting=null;const a=flowNewNode(qa);a.name='知识检索与引用';a.retrieval={query:'变更风险 草稿验收标准',top_k:3};const b=flowNewNode(writer,[a.id]);b.name='基于知识生成评估';flowDesign.nodes.push(a,b);flowSelectNode(a.id,true);flowDesignMessage('已添加“知识检索 → 生成评估”。调整查询词后，可继续添加风险分支。');}
  if(find('flow-branch')){if(flowDesign.nodes.length>10){toast('添加分支需要两个可用节点位置（最多 12 个）');return;}const source=flowDesign.nodes.find(n=>n.id===flowDesign.selected),a=flowAgent(source?.agent_id);if(!a||a.archived){toast('请为起点选择一个可用 Agent');return;}flowInvalidateUndo();flowDesign.seedOnly=false;flowDesign.connecting=null;const yes=flowNewNode(a,[source.id]),no=flowNewNode(a,[source.id]);yes.name='条件满足 · '+a.name;no.name='其他情况 · '+a.name;yes.condition=flowDefaultCondition(source);no.condition={...yes.condition,operator:yes.condition.operator==='gte'?'lte':'ne',value:yes.condition.operator==='gte'?0:yes.condition.value};flowDesign.nodes.push(yes,no);flowSelectNode(yes.id,true);flowDesignMessage('已添加两个互斥分支。分别选择执行 Agent 与目标；新增汇合节点并选择“任一上游成功”可重新合并。');}
});
$('#flow-editor-dialog').addEventListener('keydown',e=>{
  if(e.isComposing||state.composing||e.keyCode===229)return;
  if(flowEditorSaving&&e.key!=='Escape')return;
  if(e.key==='Escape'&&flowPointer){e.preventDefault();flowFinishPointer(true);return;}
  if(e.key==='Escape'&&flowDesign.connecting){e.preventDefault();flowCancelConnection();return;}
  const pane=e.target.closest('[data-flow-pane]');if(pane&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?'canvas':e.key==='End'?'inspector':pane.dataset.flowPane==='canvas'?'inspector':'canvas';flowSetMobilePane(next,true);$('[data-flow-pane="'+next+'"]')?.focus({preventScroll:true});return;}
  const handle=e.target.closest('[data-flow-drag]');if(handle&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)&&!e.metaKey&&!e.ctrlKey&&!e.altKey){e.preventDefault();if(flowEditorSaving)return;const identity=handle.dataset.flowDrag,p=flowPositions()[identity],step=e.shiftKey?32:8;flowMoveNode(identity,p.x+(e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0),p.y+(e.key==='ArrowDown'?step:e.key==='ArrowUp'?-step:0),false);flowRevealNode(identity);flowDesignMessage('节点位置已微调。按 Tab 继续配置，或使用方向键继续移动。');return;}
  if(e.target.closest('.flow-canvas-viewport')&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)&&['+','=','-','0'].includes(e.key)){e.preventDefault();flowSetZoom(e.key==='0'?1:flowCanvasZoom()*(['+','='].includes(e.key)?1.2:1/1.2));return;}
  const node=e.target.closest('[data-flow-select]');if(!node||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
  e.preventDefault();const index=flowDesign.nodes.findIndex(n=>n.id===node.dataset.flowSelect),offset=['ArrowLeft','ArrowUp'].includes(e.key)?-1:1,next=e.key==='Home'?0:e.key==='End'?flowDesign.nodes.length-1:(index+offset+flowDesign.nodes.length)%flowDesign.nodes.length;flowSelectNode(flowDesign.nodes[next].id);const target=$(`[data-flow-select="${CSS.escape(flowDesign.selected)}"]`);target?.focus({preventScroll:true});target?.scrollIntoView({block:'nearest',inline:'nearest'});
});
$('#flow-editor-dialog').addEventListener('focusin',e=>{
  const field=e.target;if(!['INPUT','TEXTAREA','SELECT'].includes(field.tagName))return;
  const key=['designField','retrievalField','conditionField','flowDependency','designToggle'].find(k=>field.dataset[k]);lastFlowEditorFocus={id:field.id||null,key,value:key?field.dataset[key]:null,selection:field.setSelectionRange?[field.selectionStart,field.selectionEnd]:null};
});
$('#flow-editor-dialog').addEventListener('focusout',e=>{
  const field=e.target;if(!lastFlowEditorFocus||!field.setSelectionRange)return;const saved=lastFlowEditorFocus;
  if((saved.id&&saved.id===field.id)||(saved.key&&field.dataset[saved.key]===saved.value))saved.selection=[field.selectionStart,field.selectionEnd];
});
$('#flow-editor-dialog').addEventListener('cancel',e=>{
  if(flowPointer){e.preventDefault();flowFinishPointer(true);return;}
  if(flowDesign.connecting){e.preventDefault();flowCancelConnection();return;}
  if(flowEditorSaving||flowEditorIsDirty()){e.preventDefault();requestFlowEditorClose();}
});
// Capture explicit user close actions before app.js's shared dialog handler.
// Programmatic close after a successful save is intentionally unaffected.
document.addEventListener('click',e=>{if(e.target.closest('#flow-editor-dialog [data-close]')&&(flowEditorSaving||flowEditorIsDirty())){e.preventDefault();e.stopImmediatePropagation();requestFlowEditorClose();}},true);
window.addEventListener('beforeunload',e=>{if($('#flow-editor-dialog').open&&flowEditorIsDirty()){e.preventDefault();e.returnValue='';}});
$('.flow-canvas-viewport').addEventListener('pointerdown',e=>{
  if(flowEditorSaving||flowPointer||e.button!==0||e.isPrimary===false)return;
  const viewport=$('.flow-canvas-viewport'),handle=e.target.closest('[data-flow-drag]'),point={id:e.pointerId,startX:e.clientX,startY:e.clientY,scrollLeft:viewport.scrollLeft,scrollTop:viewport.scrollTop,moved:false};
  if(handle){const identity=handle.dataset.flowDrag,p=flowPositions()[identity];if(!p)return;flowPointer={...point,kind:'node',node:identity,from:{...p},positions:structuredClone(flowDesign.positions||{}),seedOnly:flowDesign.seedOnly,undo:flowDesign.undo,fit:flowDesign.fit,zoom:flowDesign.zoom,scale:flowCanvasZoom()};flowSelectNode(identity,false,false);$(`[data-flow-drag="${CSS.escape(identity)}"]`,$('#flow-canvas'))?.focus({preventScroll:true});}
  else{if(e.pointerType==='touch'||e.target.closest('.flow-canvas-node,button,a,input,select,textarea'))return;flowPointer={...point,kind:'pan'};viewport.classList.add('panning');}
  e.preventDefault();viewport.setPointerCapture?.(e.pointerId);
});
$('.flow-canvas-viewport').addEventListener('pointermove',e=>{
  const pointer=flowPointer;if(!pointer||pointer.id!==e.pointerId)return;const viewport=$('.flow-canvas-viewport'),dx=e.clientX-pointer.startX,dy=e.clientY-pointer.startY;if(!pointer.moved&&Math.hypot(dx,dy)<4)return;pointer.moved=true;e.preventDefault();
  if(pointer.kind==='pan'){viewport.scrollLeft=Math.max(0,pointer.scrollLeft-dx);viewport.scrollTop=Math.max(0,pointer.scrollTop-dy);return;}
  flowDesign.fit=false;flowDesign.zoom=pointer.scale;flowMoveNode(pointer.node,pointer.from.x+(dx+viewport.scrollLeft-pointer.scrollLeft)/pointer.scale,pointer.from.y+(dy+viewport.scrollTop-pointer.scrollTop)/pointer.scale);
});
$('.flow-canvas-viewport').addEventListener('pointerup',e=>{if(flowPointer?.id===e.pointerId)flowFinishPointer();});
$('.flow-canvas-viewport').addEventListener('pointercancel',e=>{if(flowPointer?.id===e.pointerId)flowFinishPointer(true);});
$('.flow-canvas-viewport').addEventListener('lostpointercapture',e=>{if(flowPointer?.id===e.pointerId)flowFinishPointer(true);});
$('.flow-canvas-viewport').addEventListener('wheel',e=>{if(!(e.ctrlKey||e.metaKey)||flowEditorSaving||flowPointer)return;e.preventDefault();const viewport=$('.flow-canvas-viewport'),rect=viewport.getBoundingClientRect();flowSetZoom(flowCanvasZoom()*(e.deltaY<0?1.1:1/1.1),{x:e.clientX-rect.left,y:e.clientY-rect.top});},{passive:false});
window.addEventListener('blur',()=>{if(flowPointer)flowFinishPointer(true);});
window.addEventListener('resize',()=>{if($('#flow-editor-dialog').open&&!flowPointer)flowSetMobilePane(flowDesign.mobilePane||'canvas');});
$('#flow-editor-form').addEventListener('invalid',e=>{if(e.target.id==='flow-name')$('#flow-metadata').open=true;if(e.target.closest('#flow-inspector')){flowSetMobilePane('inspector',true);flowDesign.invalidNode=flowDesign.selected;drawFlowCanvas();flowRevealNode();e.target.setAttribute('aria-invalid','true');flowDesignMessage('当前节点还有未完成的配置。请修改标记的字段后再保存。');}},true);
$('#flow-inspector').addEventListener('input',e=>{
  const n=flowDesign.nodes.find(n=>n.id===flowDesign.selected),t=e.target;if(!n)return;flowDesign.seedOnly=false;flowDesign.invalidNode=null;flowInvalidateUndo();t.removeAttribute('aria-invalid');t.removeAttribute('aria-describedby');
  if(t.dataset.designField&&t.tagName!=='SELECT')n[t.dataset.designField]=t.value;
  if(t.dataset.retrievalField&&n.retrieval)n.retrieval[t.dataset.retrievalField]=t.dataset.retrievalField==='top_k'?Number(t.value):t.value;
  if(t.dataset.conditionField==='value'&&t.tagName!=='SELECT'&&n.condition)n.condition.value=n.condition.field==='citations_count'?Number(t.value):t.value;
  drawFlowCanvas();
});
$('#flow-inspector').addEventListener('change',e=>{
  const n=flowDesign.nodes.find(n=>n.id===flowDesign.selected),t=e.target;if(!n)return;flowDesign.seedOnly=false;flowInvalidateUndo();let message='节点配置已更新。保存后应用到新的工作流版本。';
  if(t.dataset.designField&&t.tagName==='SELECT'){n[t.dataset.designField]=t.value;if(t.dataset.designField==='agent_id')n.agent_revision=flowAgent(t.value)?.revision;}
  if(t.dataset.flowDependency){const prior=[...n.depends_on];n.depends_on=t.checked?[...n.depends_on,t.dataset.flowDependency]:n.depends_on.filter(d=>d!==t.dataset.flowDependency);try{flowValidateGraph();}catch(error){n.depends_on=prior;message=error.message;}if(n.condition&&!n.depends_on.includes(n.condition.source)){delete n.condition;message='上游连接已移除，对应的分支条件也已清除。';}}
  if(t.dataset.designToggle==='retrieval'){if(t.checked)n.retrieval={query:n.goal,top_k:3};else delete n.retrieval;message=t.checked?'已启用知识检索。请填写要检索的内容与最多引用条数。':'已关闭此节点的可选知识检索。';}
  if(t.dataset.designToggle==='condition'){if(t.checked)n.condition=flowDefaultCondition(flowDesign.nodes.find(v=>v.id===n.depends_on[0]));else delete n.condition;message=t.checked?'已启用分支条件。检查来源、结果字段与比较值。':'已清除分支条件，此节点按上游完成状态执行。';}
  if(t.dataset.conditionField&&n.condition){n.condition[t.dataset.conditionField]=t.value;if(t.dataset.conditionField==='field'){n.condition.operator='eq';n.condition.value=t.value==='risk_level'?'HIGH':t.value==='citations_count'?1:'';}else if(t.dataset.conditionField==='value'&&n.condition.field==='citations_count')n.condition.value=Number(t.value);}
  if(t.tagName==='SELECT'||t.type==='checkbox')renderFlowDesign();flowDesignMessage(message);
});
