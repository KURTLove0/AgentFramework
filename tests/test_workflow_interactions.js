'use strict';

// Run: node tests/test_workflow_interactions.js
// The actual UI scripts run against a small in-memory DOM and pointer surface.
// No browser, network, persistent user data or model calls are involved.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const registry=new Map(),documentEvents=new Map(),windowEvents=new Map(),storage=new Map();
let documentState,context,canvasCards=[],canvasButtons=[],inspectorFields=[],navigationButtons=[],mobileViewport=false;const toastMessages=[];
const camel=s=>s.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());

class Element{
  constructor(id='',tag='DIV',parent=null){this.id=id;this.tagName=tag;this.parent=parent;this.dataset={};this.style={};this.attributes={};this.events=new Map();this.disabled=false;this.hidden=false;this.open=false;this.value='';this.scrollLeft=0;this.scrollTop=0;this.clientWidth=600;this.clientHeight=400;this.offsetWidth=248;this.offsetHeight=190;this.selectionStart=0;this.selectionEnd=0;this.classes=new Set();this._html='';this._text='';this.classList={add:c=>this.classes.add(c),remove:c=>this.classes.delete(c),toggle:(c,on)=>{if(on===undefined)on=!this.classes.has(c);on?this.classes.add(c):this.classes.delete(c);}};}
  get className(){return [...this.classes].join(' ');} set className(v){this.classes=new Set(v.split(/\s+/).filter(Boolean));}
  set innerHTML(value){this._html=value;if(this.id==='flow-canvas')mountCanvas(value);if(this.id==='flow-inspector')mountInspector(value);}
  get innerHTML(){return this._html;}
  set textContent(value){this._text=String(value);} get textContent(){return this._text;}
  setAttribute(k,v){this.attributes[k]=String(v);if(k==='class')this.className=v;}
  removeAttribute(k){delete this.attributes[k];} hasAttribute(k){return k in this.attributes;}
  addEventListener(type,fn,options={}){if(!this.events.has(type))this.events.set(type,[]);this.events.get(type).push({fn,once:options?.once});}
  emit(type,event={}){for(const listener of [...(this.events.get(type)||[])]){listener.fn(event);if(listener.once)this.events.set(type,this.events.get(type).filter(x=>x!==listener));}}
  focus(){documentState.activeElement=this;} setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;} scrollIntoView(){} remove(){this.removed=true;}
  showModal(){this.open=true;} close(){this.open=false;this.emit('close');}
  matches(selector){if(selector[0]==='#')return this.id===selector.slice(1);if(selector[0]==='.')return this.classes.has(selector.slice(1));const data=selector.match(/^\[data-([a-z-]+)(?:="([^"]*)")?\]$/);if(data)return camel(data[1]) in this.dataset&&(data[2]===undefined||this.dataset[camel(data[1])]===data[2]);if(selector==='[aria-invalid="true"]')return this.attributes['aria-invalid']==='true';return this.tagName.toLowerCase()===selector;}
  closest(selector){if(selector==='#flow-editor-dialog [data-close]')return this.hasAttribute('data-close')&&this.closest('#flow-editor-dialog')?this:null;for(let node=this;node;node=node.parent)if(selector.split(',').some(s=>node.matches(s.trim())))return node;return null;}
  querySelector(s){return query(s,this);} querySelectorAll(s){return queryAll(s,this);}
  insertAdjacentHTML(_position,html){if(html.includes('class="flow-mobile-panes"')){const panes=register('flow-mobile-panes','DIV',editorForm);panes.className='flow-mobile-panes';const buttons=parseButtons(html,panes);navigationButtons.push(...buttons);for(const b of buttons)if(b.id)registry.set(b.id,b);}if(html.includes('id="flow-canvas-controls"')){register('flow-canvas-controls','DIV',editorForm);navigationButtons=parseButtons(html,registry.get('flow-canvas-controls'));for(const b of navigationButtons)if(b.id)registry.set(b.id,b);}}
  setPointerCapture(id){this.capture=id;} hasPointerCapture(id){return this.capture===id;} releasePointerCapture(){this.capture=null;}
  getBoundingClientRect(){return {left:0,top:0,width:this.clientWidth,height:this.clientHeight};}
}
function register(id,tag='DIV',parent=null){const node=new Element(id,tag,parent);registry.set(id,node);return node;}
function attrs(node,html){for(const m of html.matchAll(/data-([a-z-]+)="([^"]*)"/g))node.dataset[camel(m[1])]=m[2];const id=html.match(/\bid="([^"]*)"/);if(id)node.id=id[1];const cls=html.match(/\bclass="([^"]*)"/);if(cls)node.className=cls[1];const value=html.match(/\bvalue="([^"]*)"/);if(value)node.value=value[1];if(/\bdisabled(?:\s|>)/.test(html))node.disabled=true;}
function parseButtons(html,parent){return [...html.matchAll(/<button\b([^>]*)>/g)].map(m=>{const b=new Element('','BUTTON',parent);attrs(b,m[1]);return b;});}
function mountCanvas(html){canvasCards=[];canvasButtons=[];for(const m of html.matchAll(/<article class="([^"]*)" data-flow-position="([^"]*)">([\s\S]*?)<\/article>/g)){const card=new Element('','ARTICLE',canvas);card.className=m[1];card.dataset.flowPosition=m[2];canvasCards.push(card);canvasButtons.push(...parseButtons(m[3],card));}}
function mountInspector(html){inspectorFields=[];for(const m of html.matchAll(/<(input|select|textarea)\b([^>]*data-(?:design-field|retrieval-field|condition-field|flow-dependency|design-toggle)="[^"]*"[^>]*)>/g)){const field=new Element('',m[1].toUpperCase(),inspector);attrs(field,m[2]);inspectorFields.push(field);}}
function all(){return [...registry.values(),...canvasCards,...canvasButtons,...inspectorFields,...navigationButtons];}
function queryAll(selector,root=null){if(selector==='.flow-canvas-node')return canvasCards;if(selector==='[data-flow-zoom]')return navigationButtons.filter(n=>'flowZoom'in n.dataset);if(selector==='input,select,textarea,button')return [nameField,descriptionField,saveButton,closeButton,...inspectorFields,...navigationButtons,...canvasButtons];if(selector==='[data-close]'&&root===confirmDialog)return [confirmBack,confirmClose];return all().filter(n=>!n.removed&&n.matches(selector)&&(!root||n===root||ancestor(n,root)));}
function ancestor(node,root){for(let p=node.parent;p;p=p.parent)if(p===root)return true;return false;}
function query(selector,root=null){if(selector==='#flow-metadata summary')return metadataSummary;if(selector==='.dialog-foot [data-close]')return confirmBack;if(selector==='button[type="submit"]')return saveButton;if(selector[0]==='#'&&!selector.includes(' '))return registry.get(selector.slice(1))||null;return queryAll(selector,root)[0]||null;}

const editor=register('flow-editor-dialog','DIALOG'),editorForm=register('flow-editor-form','FORM',editor),designer=register('designer','DIV',editorForm),canvas=register('flow-canvas'),viewport=register('viewport'),inspector=register('flow-inspector','ASIDE',designer);designer.className='flow-designer';viewport.className='flow-canvas-viewport';viewport.parent=designer;canvas.parent=viewport;const toolbar=register('toolbar','DIV',editorForm);toolbar.className='flow-designer-toolbar';
const nameField=register('flow-name','INPUT',editorForm),descriptionField=register('flow-description','TEXTAREA',editorForm),metadata=register('flow-metadata','DETAILS',editorForm),metadataSummary=register('metadata-summary');
const saveButton=register('flow-save','BUTTON',editorForm),closeButton=register('flow-close','BUTTON',editor);closeButton.attributes['data-close']='';
const confirmDialog=register('confirm-dialog','DIALOG'),confirmBack=register('confirm-back','BUTTON',confirmDialog),confirmClose=register('confirm-close','BUTTON',confirmDialog);confirmBack.attributes['data-close']='';confirmClose.attributes['data-close']='';
for(const id of ['flow-editor-title','flow-editor-error','flow-designer-status','confirm-title','confirm-body','confirm-error','confirm-submit','flow-chat-agent','flow-chat-history','flow-chat-proposal','flow-chat-form','flow-chat-message','flow-chat-send','flow-chat-consent','flow-chat-consent-label','flow-chat-runtime','flow-chat-error','flow-start-form','flow-start-dialog','flow-start-summary','flow-start-error','flow-live-consent','flow-mcp-consent-label','flow-scenarios','flow-change','flow-grant','flow-consent','flow-mcp-consent'])register(id);
for(const [key,id] of [['flowFit','fit'],['addFlowNode','add'],['flowBranch','branch']]){const b=register(id,'BUTTON',editorForm);b.dataset[key]='';}
documentState={activeElement:null,addEventListener(type,fn,capture){if(!documentEvents.has(type))documentEvents.set(type,[]);documentEvents.get(type).push({fn,capture});}};
const state={workspaceId:'workspace-test',meta:{tenant:'tenant-test'},agents:[{id:'agent-qa',name:'规范知识助手',revision:2,archived:false,runtime:'mock',definition:{domain_pack_ref:'knowledge-answer@1.0.0'}},{id:'agent-writer',name:'发布审核员',revision:3,archived:false,runtime:'mock',definition:{domain_pack_ref:'change-assessment@2.0.0'}}]};
context=vm.createContext({console,document:documentState,window:{matchMedia:()=>({matches:mobileViewport}),localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},addEventListener(type,fn){if(!windowEvents.has(type))windowEvents.set(type,[]);windowEvents.get(type).push(fn);}},state,structuredClone,crypto:webcrypto,CSS:{escape:String},$:query,$$:queryAll,esc:x=>String(x??''),icon:()=>'',toast:message=>toastMessages.push(message),runtimeLabel:()=>'',time:()=>'',json:JSON.stringify,queueMicrotask});
for(const file of ['workflows.js','workflow_designer.js'])vm.runInContext(fs.readFileSync(path.join(ROOT,'agent_framework/webui',file),'utf8'),context,{filename:file});
const run=code=>vm.runInContext(code,context);context.originalLoadFlows=run('loadFlows');
const definition={id:'workflow-test',revision:1,name:'模拟流程',description:'仅隔离测试',nodes:[{id:'knowledge',name:'查询规范',agent_id:'agent-qa',agent_revision:2,goal:'查询模拟规范',depends_on:[],retrieval:{query:'规范',top_k:3}},{id:'review',name:'评估变更',agent_id:'agent-writer',agent_revision:3,goal:'评估模拟变更',depends_on:['knowledge'],condition:{source:'knowledge',field:'citations_count',operator:'gte',value:1}}]};context.definition=definition;
function reset(){storage.clear();toastMessages.length=0;mobileViewport=false;state.selected=null;state.flowFeedback=null;state.workspaceId='workspace-test';state.composing=false;viewport.scrollLeft=0;viewport.scrollTop=0;viewport.capture=null;confirmDialog.open=false;run('openVisualFlowEditor(definition)');}
function pointer(type,target,x,y,extra={}){const event={target,pointerId:1,button:0,pointerType:'mouse',isPrimary:true,clientX:x,clientY:y,preventDefault(){this.prevented=true;},...extra};viewport.emit(type,event);return event;}
function key(target,value,extra={}){const event={target,key:value,preventDefault(){this.prevented=true;},...extra};editor.emit('keydown',event);return event;}
function click(dataKey,value='',extra={}){const target=new Element('','BUTTON',editorForm);target.dataset={...extra,[dataKey]:value};const event={target,preventDefault(){},stopImmediatePropagation(){this.stopped=true;}};const pending=[];for(const listener of documentEvents.get('click')||[])if(!listener.capture&&!event.stopped){const result=listener.fn(event);if(result?.then)pending.push(result);}return Promise.all(pending);}
const node=id=>query(`[data-flow-position="${id}"]`,canvas),handle=id=>query(`[data-flow-drag="${id}"]`,canvas);
const plain=value=>JSON.parse(JSON.stringify(value));
let passed=0;
function test(name,fn){reset();fn();passed++;console.log('PASS '+name);}

test('navigation is added once and selected node has a move handle',()=>{assert(registry.has('flow-canvas-controls'));assert(handle('knowledge'));run('flowEnsureCanvasControls()');assert.equal(navigationButtons.filter(n=>n.dataset.flowZoom==='reset').length,1);assert.equal(viewport.attributes.role,'region');});
test('pointer press and tiny jitter do not alter a draft',()=>{pointer('pointerdown',handle('knowledge'),100,100);pointer('pointermove',handle('knowledge'),102,101);pointer('pointerup',handle('knowledge'),102,101);assert.equal(run('flowEditorIsDirty()'),false);});
test('node dragging updates snapped coordinates and keeps business nodes unchanged',()=>{const original=run('JSON.stringify(flowDesign.nodes)');pointer('pointerdown',handle('knowledge'),100,100);pointer('pointermove',handle('knowledge'),164,132);assert(node('knowledge').classes.has('dragging'));pointer('pointerup',handle('knowledge'),164,132);const p=run('flowPositions().knowledge');assert.equal(p.x,104);assert.equal(p.y,104);assert.equal(run('JSON.stringify(flowDesign.nodes)'),original);assert(run('flowEditorIsDirty()'));assert(!node('knowledge').classes.has('dragging'));});
test('dragging accounts for the current canvas zoom',()=>{run('flowSetZoom(.5)');pointer('pointerdown',handle('knowledge'),100,100);pointer('pointermove',handle('knowledge'),140,120);pointer('pointerup',handle('knowledge'),140,120);assert.equal(run('flowPositions().knowledge.x'),120);assert.equal(run('flowPositions().knowledge.y'),112);});
test('Escape cancels a drag and restores the clean draft',()=>{pointer('pointerdown',handle('knowledge'),100,100);pointer('pointermove',handle('knowledge'),180,140);const event=key(handle('knowledge'),'Escape');assert(event.prevented);assert.equal(run('flowPointer'),null);assert.equal(run('flowEditorIsDirty()'),false);});
test('pointer cancellation restores layout without affecting the graph',()=>{const original=run('JSON.stringify(flowDesign.nodes)');pointer('pointerdown',handle('review'),100,100);pointer('pointermove',handle('review'),180,140);pointer('pointercancel',handle('review'),180,140);assert.equal(run('flowEditorIsDirty()'),false);assert.equal(run('JSON.stringify(flowDesign.nodes)'),original);});
test('blank canvas panning changes only viewport scroll',()=>{viewport.scrollLeft=200;viewport.scrollTop=150;pointer('pointerdown',canvas,100,100);pointer('pointermove',canvas,60,80);pointer('pointerup',canvas,60,80);assert.equal(viewport.scrollLeft,240);assert.equal(viewport.scrollTop,170);assert(!viewport.classes.has('panning'));assert.equal(run('flowEditorIsDirty()'),false);});
test('keyboard handle movement supports Shift acceleration and coordinate bounds',()=>{key(handle('knowledge'),'ArrowRight',{shiftKey:true});assert.equal(run('flowPositions().knowledge.x'),68);run("flowMoveNode('knowledge',-100,100000)");assert.equal(run('flowPositions().knowledge.x'),24);assert.equal(run('flowPositions().knowledge.y'),8192);});
test('IME keys and text-field arrows never move nodes',()=>{const before=run('JSON.stringify(flowPositions())');key(handle('knowledge'),'ArrowRight',{isComposing:true});key(handle('knowledge'),'ArrowRight',{keyCode:229});state.composing=true;key(handle('knowledge'),'ArrowRight');state.composing=false;key(query('[data-design-field="name"]',inspector),'ArrowRight');assert.equal(run('JSON.stringify(flowPositions())'),before);});
test('zoom is bounded and does not mark a draft as changed',()=>{run('flowSetZoom(99)');assert.equal(run('flowCanvasZoom()'),1.75);run('flowSetZoom(.01)');assert.equal(run('flowCanvasZoom()'),.35);assert.equal(registry.get('flow-zoom-label').textContent,'35%');assert.equal(run('flowEditorIsDirty()'),false);});
test('zoom preserves the logical point under its anchor',()=>{viewport.scrollLeft=300;run('flowSetZoom(1.2,{x:100,y:100})');assert.equal(viewport.scrollLeft,380);});
test('fit considers both viewport dimensions and remains a view-only change',()=>{run("flowDesign.positions={knowledge:{x:40,y:72},review:{x:360,y:500}};drawFlowCanvas();flowEditorMarkSaved()");click('flowFit');assert(run('flowCanvasZoom()')<.6);assert.equal(run('flowEditorIsDirty()'),false);click('flowFit');assert.equal(run('flowCanvasZoom()'),1);assert.equal(run('flowEditorIsDirty()'),false);});
test('fit keeps readable size when actual nodes already fit, ignoring blank canvas extent',()=>{const size=[viewport.clientWidth,viewport.clientHeight];try{viewport.clientWidth=1200;viewport.clientHeight=400;run("flowDesign.positions={knowledge:{x:40,y:72},review:{x:360,y:72}};drawFlowCanvas();flowEditorMarkSaved()");click('flowFit');assert.equal(run('flowCanvasZoom()'),1);assert.equal(run('flowEditorIsDirty()'),false);}finally{[viewport.clientWidth,viewport.clientHeight]=size;}});
test('ordinary wheel scrolling remains native and modified wheel zooms',()=>{let event={target:canvas,ctrlKey:false,metaKey:false,clientX:100,clientY:100,deltaY:-10,preventDefault(){this.prevented=true;}};viewport.emit('wheel',event);assert(!event.prevented);assert.equal(run('flowCanvasZoom()'),1);event={...event,ctrlKey:true};viewport.emit('wheel',event);assert(event.prevented);assert(run('flowCanvasZoom()')>1);});
test('selection updates inspector, dependencies and the visible canvas area',()=>{run("flowDesign.positions={knowledge:{x:40,y:72},review:{x:1800,y:72}};drawFlowCanvas();flowEditorMarkSaved();flowSelectNode('review')");assert(node('knowledge').classes.has('upstream'));assert(node('review').classes.has('selected'));assert.equal(query('[data-design-field="name"]',inspector).value,'评估变更');assert(viewport.scrollLeft>1000);assert.equal(run('flowEditorIsDirty()'),false);});
test('layout cache is scoped and contains only coordinates',()=>{run("flowMoveNode('knowledge',120,160);flowSaveLayout({id:'workflow-test'})");assert.equal(storage.size,1);const [cacheKey,body]=[...storage][0];assert(cacheKey.includes('tenant-test')&&cacheKey.includes('workspace-test'));const saved=JSON.parse(body);assert.deepEqual(Object.keys(saved.knowledge).sort(),['x','y']);run('openVisualFlowEditor(definition)');assert.equal(run('flowPositions().knowledge.x'),120);state.workspaceId='other-space';run('openVisualFlowEditor(definition)');assert.equal(run('flowPositions().knowledge.x'),36);});
test('invalid layout data degrades to automatic layout',()=>{const cacheKey=run("flowLayoutKey('workflow-test')");storage.set(cacheKey,'not json');run('openVisualFlowEditor(definition)');assert.equal(run('flowPositions().knowledge.x'),36);storage.set(cacheKey,JSON.stringify({knowledge:{x:-500,y:999999},foreign:{x:100,y:100}}));run('openVisualFlowEditor(definition)');assert.equal(run('flowPositions().knowledge.x'),24);assert.equal(run('flowPositions().knowledge.y'),8192);assert(!('foreign'in run('flowDesign.positions')));});
test('automatic arrange restores the original clean layout and routing',()=>{const nodes=run('JSON.stringify(flowDesign.nodes)');run("flowMoveNode('knowledge',200,300)");click('flowArrange');assert.equal(run('JSON.stringify(flowDesign.nodes)'),nodes);assert.equal(run('flowEditorIsDirty()'),false);});
test('node deletion undo restores manual layout and the complete branch definition',()=>{run("flowMoveNode('knowledge',120,160);flowEditorMarkSaved()");const original=run('JSON.stringify(flowDesign.nodes)'),positions=run('JSON.stringify(flowDesign.positions)');click('flowDelete');assert.equal(run('flowDesign.nodes.length'),1);assert(!('knowledge'in run('flowDesign.positions')));click('flowUndo');assert.equal(run('JSON.stringify(flowDesign.nodes)'),original);assert.equal(run('JSON.stringify(flowDesign.positions)'),positions);assert.equal(run('flowEditorIsDirty()'),false);});
test('validation selects, marks and reveals the node with a missing goal',()=>{run("flowDesign.positions={knowledge:{x:1800,y:72}};flowDesign.nodes[0].goal='';flowSelectNode('review')");assert.throws(()=>run('serializeFlowDesign()'),/请说明此节点/);assert.equal(run('flowDesign.selected'),'knowledge');assert(node('knowledge').classes.has('invalid'));assert.equal(query('[data-design-field="goal"]',inspector).attributes['aria-invalid'],'true');assert(viewport.scrollLeft>1000);});
test('tap direction controls move a node without a drag and preserve its API definition',()=>{assert(inspector.innerHTML.includes('调整节点位置'));assert.equal((inspector.innerHTML.match(/data-flow-nudge=/g)||[]).length,4);const before=run('JSON.stringify(flowDesign.nodes)');click('flowNudge','right');click('flowNudge','down');assert.equal(run('flowPositions().knowledge.x'),44);assert.equal(run('flowPositions().knowledge.y'),80);assert.equal(run('JSON.stringify(flowDesign.nodes)'),before);assert(run('flowEditorIsDirty()'));});
test('mobile editor opens on canvas and selects properties only on an explicit node click',()=>{mobileViewport=true;run('openVisualFlowEditor(definition)');assert(!viewport.hidden&&inspector.hidden);assert.equal(documentState.activeElement,viewport);assert.equal(designer.dataset.mobilePane,'canvas');click('flowSelect','review');assert(viewport.hidden&&!inspector.hidden);assert.equal(designer.dataset.mobilePane,'inspector');assert.equal(run('flowDesign.selected'),'review');assert.equal(run('flowEditorIsDirty()'),false);});
test('mobile dragging stays on canvas while zoom and locate return from properties',()=>{mobileViewport=true;run('openVisualFlowEditor(definition)');pointer('pointerdown',handle('review'),100,100);pointer('pointermove',handle('review'),140,120);pointer('pointerup',handle('review'),140,120);assert(!viewport.hidden&&inspector.hidden);click('flowPane','inspector');assert(inspector.hidden===false);click('flowZoom','in');assert(!viewport.hidden&&inspector.hidden);click('flowPane','inspector');click('flowLocate');assert(!viewport.hidden&&inspector.hidden);});
test('mobile pane tabs support arrows and desktop always restores both panes',()=>{mobileViewport=true;run('openVisualFlowEditor(definition)');const pane=query('[data-flow-pane="canvas"]');key(pane,'ArrowRight');assert(viewport.hidden&&!inspector.hidden);assert.equal(query('[data-flow-pane="inspector"]').attributes['aria-selected'],'true');mobileViewport=false;for(const listener of windowEvents.get('resize')||[])listener();assert(!viewport.hidden&&!inspector.hidden);assert.equal(run('flowEditorIsDirty()'),false);});
test('layout data never enters the workflow node API contract',()=>{run("flowMoveNode('knowledge',120,160)");const serial=plain(run('serializeFlowDesign()'));assert.deepEqual(serial,definition.nodes);assert(serial.every(n=>!('position'in n)&&!('positions'in n)&&!('x'in n)&&!('y'in n)));});
test('saving disables canvas movement and user cancellation cannot discard the request',()=>{run('flowEditorSetSaving(true)');pointer('pointerdown',handle('knowledge'),100,100);assert.equal(run('flowPointer'),null);const before=run('JSON.stringify(flowPositions())');key(handle('knowledge'),'ArrowRight');assert.equal(run('JSON.stringify(flowPositions())'),before);run('requestFlowEditorClose()');assert(editor.open);assert(!confirmDialog.open);run('flowEditorSetSaving(false)');});
test('dragging is included in the existing unsaved-close protection',()=>{run("flowMoveNode('knowledge',120,160);requestFlowEditorClose()");assert(editor.open&&confirmDialog.open);confirmDialog.close();assert(editor.open);assert.equal(run('flowPositions().knowledge.x'),120);run('requestFlowEditorClose()');registry.get('confirm-submit').onclick();assert(!editor.open&&!confirmDialog.open);});

async function verifySaveContract(){
  reset();context.savedRequests=[];
  run("flowMoveNode('knowledge',120,160);api=async(path,payload)=>{savedRequests.push({path,payload});return {...definition,revision:2}};loadFlows=async()=>{};render=()=>{}");
  const submit=editorForm.events.get('submit')[0].fn;
  await submit({target:editorForm,preventDefault(){}});
  const request=plain(context.savedRequests[0]);
  assert.equal(request.path,'/api/workflows/workflow-test');
  assert.deepEqual(Object.keys(request.payload).sort(),['description','name','nodes','revision']);
  assert.deepEqual(request.payload.nodes,definition.nodes);
  assert.equal(request.payload.revision,1);
  assert(!editor.open);
  assert.equal(run('flowEditorSaving'),false);
  assert.equal(JSON.parse(storage.get(run("flowLayoutKey('workflow-test')"))).knowledge.x,120);
  passed++;console.log('PASS successful save keeps the original API contract and stores layout separately');
  await verifyMutationRefreshSafety();
  console.log('\n'+passed+' isolated workflow interaction checks passed.');
}
verifySaveContract().catch(error=>{console.error(error);process.exitCode=1;});

async function verifyMutationRefreshSafety(){
  const editorSubmit=editorForm.events.get('submit')[0].fn;
  async function saveWithFailure({proposal=false,postFailure=false,partialGet=false}={}){
    reset();state.view='workflows';state.flows={workflows:[structuredClone(definition)],runs:[]};state.flowChats=[];context.requests=[];
    run('loadFlows=originalLoadFlows;render=()=>{}');
    if(proposal){context.proposal=structuredClone(definition);delete context.proposal.id;delete context.proposal.revision;state.flowChat={id:'chat-preserved',messages:[],proposal:context.proposal};run('openVisualFlowEditor(proposal)');}
    context.postFailure=postFailure;context.partialGet=partialGet;context.fromProposal=proposal;
    run("api=async(path,payload)=>{requests.push({path,payload});if(payload!==undefined){if(postFailure)throw Error('模拟写入响应未知');return {...definition,id:fromProposal?'workflow-from-chat':'workflow-test',revision:fromProposal?1:2};}if(partialGet&&path==='/api/workflows')return {workflows:[],runs:[]};throw Error('模拟列表GET失败');}");
    await editorSubmit({target:editorForm,preventDefault(){}});
    return plain(context.requests);
  }
  let calls=await saveWithFailure();
  assert.equal(calls.filter(c=>c.payload!==undefined).length,1);assert.equal(calls.length,2);assert(!editor.open);assert(registry.get('flow-editor-error').hidden);assert.equal(state.flows.workflows[0].revision,2);assert(state.flowFeedback.refreshError);assert(run('flowMutationFeedback()').includes('操作已经完成'));assert(toastMessages.at(-1).includes('工作流已保存'));
  passed++;console.log('PASS save success followed by GET failure retains its receipt without reporting a failed save');
  calls=await saveWithFailure({proposal:true,partialGet:true});
  assert.equal(calls.filter(c=>c.payload!==undefined).length,1);assert.equal(calls[0].path,'/api/workflows');assert.equal(calls[0].payload.revision,0);assert.equal(calls.length,3);assert(state.flows.workflows.some(w=>w.id==='workflow-from-chat'));assert.equal(state.flowChat.id,'chat-preserved');assert(!editor.open);assert(registry.get('flow-editor-error').hidden);
  passed++;console.log('PASS saving an adopted chat proposal survives a later partial refresh failure without duplicate creation');
  calls=await saveWithFailure({postFailure:true});
  assert.equal(calls.length,1);assert(editor.open);assert(!registry.get('flow-editor-error').hidden);assert.equal(state.flowFeedback,null);
  passed++;console.log('PASS a failed or unknown POST keeps the editor open and never triggers a replay or follow-up refresh');
  reset();state.view='workflows';state.flows={workflows:[structuredClone(definition)],runs:[]};context.requests=[];context.navigations=[];context.runReceipt={run:{id:'flowrun-created',name:'模拟运行',status:'CREATED',snapshot:{definition},nodes:{},created_at:1},children:{},events:[]};
  const startForm=registry.get('flow-start-form');startForm.dataset={id:'workflow-test',revision:'1',requestId:'request-stable'};registry.get('flow-change').value='change-test';registry.get('flow-start-dialog').open=true;registry.get('flow-start-error').hidden=true;
  run("loadFlows=originalLoadFlows;navigate=(view,id)=>{navigations.push({view,id});state.selected=id};api=async(path,payload)=>{requests.push({path,payload});if(payload!==undefined)return runReceipt;throw Error('模拟列表GET失败');}");
  await startForm.events.get('submit')[0].fn({target:startForm,preventDefault(){}});
  assert.equal(context.requests.filter(c=>c.payload!==undefined).length,1);assert.equal(context.requests[0].payload.request_id,'request-stable');assert.equal(state.flowDetail.run.id,'flowrun-created');assert.equal(state.flows.runs[0].id,'flowrun-created');assert.equal(context.navigations[0].id,'flowrun-created');assert(!registry.get('flow-start-dialog').open);assert(registry.get('flow-start-error').hidden);assert(toastMessages.at(-1).includes('运行已创建'));
  passed++;console.log('PASS start success preserves the single created run and stable request identity when refresh fails');
  reset();state.view='workflows';state.flows={workflows:[structuredClone(definition)],runs:[]};context.requests=[];
  run("loadFlows=originalLoadFlows;api=async(path,payload)=>{requests.push({path,payload});if(payload!==undefined)return runReceipt;throw Error('模拟列表GET失败');}");
  await click('grantFlow','flowrun-created',{node:'review'});
  assert.equal(context.requests.filter(c=>c.payload!==undefined).length,1);assert.equal(context.requests[0].payload.node_id,'review');assert.equal(state.flowDetail.run.id,'flowrun-created');assert(toastMessages.at(-1).includes('已授权此提案'));assert(state.flowFeedback.refreshError);
  passed++;console.log('PASS granted run receipt remains successful when the subsequent GET fails');
  reset();state.view='workflows';state.flows={workflows:[structuredClone(definition)],runs:[]};context.requests=[];
  run("loadFlows=originalLoadFlows;api=async(path,payload)=>{requests.push({path,payload});if(payload!==undefined)return {...definition,archived:true,revision:2};throw Error('模拟列表GET失败');}");
  await click('archiveFlow','workflow-test');
  assert.equal(context.requests.filter(c=>c.payload!==undefined).length,1);assert.equal(state.flows.workflows[0].archived,true);assert(toastMessages.at(-1).includes('工作流已归档'));
  passed++;console.log('PASS archive receipt stays authoritative when the following list refresh fails');
}
