'use strict';

// Keep the submitted snapshot stable until its authoritative response arrives.
function lockFormSubmission(form){
 if(!form)return ()=>{};
 const controls=new Set(),busy=form.getAttribute('aria-busy'),dialog=form.closest('dialog');let released=false;
 const freeze=()=>{for(const field of form.querySelectorAll('input,select,textarea,button'))if(!field.disabled){controls.add(field);field.disabled=true;}};
 const block=event=>{event.preventDefault();event.stopImmediatePropagation();};
 freeze();form.setAttribute('aria-busy','true');if(typeof closeFormPicker==='function')closeFormPicker();
 form.addEventListener('click',block,true);form.addEventListener('submit',block,true);dialog?.addEventListener('cancel',block,true);
 const observer=new MutationObserver(freeze);observer.observe(form,{childList:true,subtree:true});
 return ()=>{if(released)return;released=true;observer.disconnect();form.removeEventListener('click',block,true);form.removeEventListener('submit',block,true);dialog?.removeEventListener('cancel',block,true);for(const field of controls)if(form.contains(field))field.disabled=false;if(busy===null)form.removeAttribute('aria-busy');else form.setAttribute('aria-busy',busy);if(typeof refreshFormControls==='function')refreshFormControls();};
}
// Progressive enhancement: native selects remain the form's source of truth.
const formPickers=new Map();
let pickerOpen=null,controlsQueued=false,pickerSequence=0;
function pickerSourceHidden(select){
 if(select.hidden||select.parentElement?.closest('[hidden],[inert],[aria-hidden="true"],details:not([open])'))return true;
 const view=select.ownerDocument?.defaultView;
 for(let node=select;node;node=node.parentElement){const style=view?.getComputedStyle?.(node);if(style&&(style.display==='none'||style.visibility==='hidden'))return true;}
 return false;
}
function shouldEnhanceSelect(select){return !select.multiple&&select.size<=1&&!select.classList.contains('enhanced-select')&&!select.matches('[data-no-picker]')&&!pickerSourceHidden(select);}
function ensureSelectIdentity(select){if(!select.id)select.id='af-select-'+(++pickerSequence);}
function controlLabel(select){
 const explicit=select.getAttribute('aria-label');if(explicit)return explicit;
 const label=select.labels?.[0];if(!label)return '选项';
 const copy=label.cloneNode(true);copy.querySelectorAll('input,select,textarea,button,svg,.select-picker,.field-help,.field-meter,.required-note,small').forEach(node=>node.remove());
 return copy.textContent.replace(/\s+/g,' ').trim()||'选项';
}
function focusFormControl(field){const picker=formPickers.get(field);(picker?.trigger||field)?.focus({preventScroll:true});(picker?.trigger||field)?.scrollIntoView({block:'nearest',behavior:'instant'});}
function closeFormPicker(restore=false){
 const p=pickerOpen;if(!p)return;pickerOpen=null;
 if(p.popup.hidePopover&&p.popup.matches(':popover-open'))p.popup.hidePopover();p.popup.hidden=true;p.trigger.setAttribute('aria-expanded','false');p.search.setAttribute('aria-expanded','false');p.search.removeAttribute('aria-activedescendant');p.list.removeAttribute('aria-activedescendant');
 if(restore&&p.trigger.isConnected)p.trigger.focus({preventScroll:true});
}
function pickerOptionDisabled(option){return option.disabled||option.parentElement?.disabled;}
function pickerOptions(p){return [...p.select.options].filter(o=>!o.hidden&&!o.parentElement?.hidden&&((o.label||o.textContent)+' '+(o.parentElement?.label||'')).toLocaleLowerCase().includes(p.search.value.trim().toLocaleLowerCase()));}
function highlightPicker(p,index){
 p.index=index>=0&&index<p.options.length&&!pickerOptionDisabled(p.options[index])?index:-1;p.activeOption=p.options[p.index];
 const nodes=[...p.list.querySelectorAll('[role=option]')];nodes.forEach((node,i)=>node.classList.toggle('is-active',i===p.index));
 const active=nodes[p.index],owner=p.searchable?p.search:p.list;
 p.search.removeAttribute('aria-activedescendant');p.list.removeAttribute('aria-activedescendant');
 if(active){owner.setAttribute('aria-activedescendant',active.id);if(pickerOpen===p&&!p.popup.hidden)active.scrollIntoView({block:'nearest'});}
}
function movePicker(p,direction,edge=false){
 const enabled=p.options.map((o,i)=>pickerOptionDisabled(o)?-1:i).filter(i=>i>=0);if(!enabled.length){highlightPicker(p,-1);return;}
 const current=enabled.indexOf(p.index),next=edge?(direction>0?enabled.length-1:0):Math.max(0,Math.min(enabled.length-1,current+(direction>0?1:-1)));
 highlightPicker(p,enabled[next]);
}
function pickerFingerprint(p){return JSON.stringify([p.select.value,p.search.value,[...p.select.options].map(o=>[o.value,o.label,o.textContent,o.disabled,o.hidden,o.parentElement?.disabled,o.parentElement?.hidden,o.parentElement?.label])]);}
function renderPicker(p){
 const previous=p.activeOption;p.searchable=p.select.dataset.pickerSearch!=='false'&&(p.select.options.length>7||['agent-domain','task-agent','agent-model'].includes(p.select.id)||p.select.dataset.pickerSearch==='true');
 p.popup.dataset.searchable=String(p.searchable);p.search.parentElement.hidden=!p.searchable;p.status.hidden=!p.searchable;p.popup.querySelector('.select-keyboard-hints').hidden=!p.searchable;p.list.tabIndex=p.searchable?-1:0;
 p.fingerprint=pickerFingerprint(p);p.options=pickerOptions(p);let group=null,markup='';
 p.options.forEach((o,i)=>{const parent=o.parentElement?.tagName==='OPTGROUP'?o.parentElement:null;if(parent!==group){if(group)markup+='</div>';group=parent;if(group)markup+=`<div role="group" aria-label="${esc(group.label)}"><div class="select-option-group" aria-hidden="true">${esc(group.label)}</div>`;}
  markup+=`<div role="option" id="${p.select.id}-option-${i}" aria-selected="${o.selected}" aria-disabled="${!!pickerOptionDisabled(o)}" class="${pickerOptionDisabled(o)?'is-disabled':''}" data-picker-index="${i}"><span>${esc(o.label||o.textContent)}</span>${o.selected?icon('check'):''}</div>`;
 });if(group)markup+='</div>';p.list.innerHTML=markup;
 p.empty.hidden=!!p.options.length;p.status.textContent=p.options.filter(o=>!pickerOptionDisabled(o)).length+' 个可选项';
 p.create.hidden=p.select.id!=='agent-domain';p.create.textContent=p.search.value.trim()?'新建“'+p.search.value.trim()+'”领域':'新建处理领域';
 const preferred=p.options.indexOf(previous),selected=p.options.findIndex(o=>o.selected&&!pickerOptionDisabled(o));highlightPicker(p,preferred>=0&&!pickerOptionDisabled(previous)?preferred:selected>=0?selected:p.options.findIndex(o=>!pickerOptionDisabled(o)));
 if(pickerOpen===p&&p.search.parentElement.hidden&&document.activeElement===p.search)p.list.focus({preventScroll:true});
}
function positionPicker(p){
 const box=p.trigger.getBoundingClientRect(),viewport=window.visualViewport,margin=12,gap=4,left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,viewportWidth=viewport?.width||innerWidth,viewportHeight=viewport?.height||innerHeight,width=Math.min(Math.max(box.width,240),viewportWidth-margin*2);
 const below=top+viewportHeight-box.bottom-margin-gap,above=box.top-top-margin-gap,up=below<220&&above>below,height=Math.max(0,Math.min(400,up?above:below));
 p.popup.dataset.placement=up?'top':'bottom';
 Object.assign(p.popup.style,{width:width+'px',maxHeight:height+'px',left:Math.max(left+margin,Math.min(box.left,left+viewportWidth-width-margin))+'px'});
 const actualHeight=Math.min(height,p.popup.getBoundingClientRect().height||height);
 p.popup.style.top=(up?Math.max(top+margin,box.top-actualHeight-gap):box.bottom+gap)+'px';
 if(innerWidth<=700){p.popup.style.bottom=Math.max(margin,innerHeight-top-viewportHeight+margin)+'px';p.popup.style.setProperty('--picker-viewport-height',Math.max(0,viewportHeight-margin*2)+'px');}else{p.popup.style.removeProperty('bottom');p.popup.style.removeProperty('--picker-viewport-height');}
}
function openFormPicker(p){
 if(p.wrapper.hidden||p.select.matches(':disabled'))return;
 syncFormPicker(p);closeFormPicker();pickerOpen=p;p.search.value='';p.activeOption=null;p.typeahead='';p.typedAt=0;p.popup.hidden=false;
 renderPicker(p);if(p.popup.showPopover)p.popup.showPopover();positionPicker(p);p.trigger.setAttribute('aria-expanded','true');p.search.setAttribute('aria-expanded','true');(p.searchable?p.search:p.list).focus({preventScroll:true});highlightPicker(p,p.index);
}
function choosePicker(p,index){
 const o=p.options[index];if(!o||pickerOptionDisabled(o)||p.select.matches(':disabled')||!p.select.contains(o))return;
 const changed=p.select.value!==o.value;p.select.value=o.value;syncFormPicker(p);closeFormPicker(true);if(changed){p.select.dispatchEvent(new Event('input',{bubbles:true}));p.select.dispatchEvent(new Event('change',{bubbles:true}));}else p.select.dispatchEvent(new CustomEvent('picker-selected',{bubbles:true}));
}
function syncFormPicker(p){
 const selected=p.select.selectedOptions[0],label=controlLabel(p.select),text=selected?.label||selected?.textContent||'请选择'+label,hidden=pickerSourceHidden(p.select);
 if(p.value.textContent!==text)p.value.textContent=text;
 p.trigger.setAttribute('aria-label',label+'：'+text);p.search.setAttribute('aria-label','搜索'+label);p.search.placeholder='搜索'+label;p.list.setAttribute('aria-label',label);
 p.wrapper.hidden=hidden;p.trigger.disabled=p.select.matches(':disabled');p.trigger.setAttribute('aria-required',String(p.select.required));
 if(hidden&&pickerOpen===p)closeFormPicker();
 for(const attr of ['aria-invalid','aria-describedby','aria-busy']){const v=p.select.getAttribute(attr);if(v===null)p.trigger.removeAttribute(attr);else p.trigger.setAttribute(attr,v);}
 p.trigger.title=text;
 if(p.select.matches(':disabled')&&pickerOpen===p)closeFormPicker();
 if(pickerOpen===p){if(p.fingerprint!==pickerFingerprint(p))renderPicker(p);positionPicker(p);}
}
function createFormPicker(select){
 if(formPickers.has(select))return;
 ensureSelectIdentity(select);
 const wrapper=document.createElement('div');wrapper.className='select-picker';
 const trigger=document.createElement('button');trigger.type='button';trigger.className='select-trigger';trigger.id=select.id+'-picker';trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls',select.id+'-options');
 const value=document.createElement('span');value.id=select.id+'-selected';trigger.append(value);trigger.insertAdjacentHTML('beforeend',icon('chevron'));
 trigger.setAttribute('aria-label',controlLabel(select));
 const popup=document.createElement('div');popup.className='select-popover';popup.setAttribute('popover','manual');popup.hidden=true;
 popup.innerHTML=`<div class="select-search">${icon('search')}<input type="search" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="${select.id}-options" aria-label="搜索${esc(controlLabel(select))}" placeholder="搜索${esc(controlLabel(select))}"></div><p class="select-result-count" role="status"></p><div id="${select.id}-options" class="select-options" role="listbox" aria-label="${esc(controlLabel(select))}"></div><div class="select-empty" hidden><p>没有找到匹配的选项</p><button type="button" class="text-button">清除搜索</button></div><button type="button" class="select-create" hidden></button><div class="select-keyboard-hints" aria-hidden="true"><span>↑ ↓ 选择 · ↵ 确认</span><span>Esc 关闭</span></div>`;
 wrapper.append(trigger,popup);select.after(wrapper);select.classList.add('enhanced-select');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
 const p={select,wrapper,trigger,value,popup,search:popup.querySelector('input'),status:popup.querySelector('[role=status]'),list:popup.querySelector('[role=listbox]'),empty:popup.querySelector('.select-empty'),create:popup.querySelector('.select-create'),index:0,options:[]};formPickers.set(select,p);
 trigger.addEventListener('click',()=>pickerOpen===p?closeFormPicker(true):openFormPicker(p));
 trigger.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();openFormPicker(p);if(e.key==='Home'||e.key==='End')movePicker(p,e.key==='End'?1:-1,true);else if(e.key==='ArrowUp')movePicker(p,1,true);}});
 p.search.addEventListener('input',e=>{if(!e.isComposing)renderPicker(p);});p.search.addEventListener('compositionend',()=>renderPicker(p));
 popup.addEventListener('keydown',e=>{
  if(e.isComposing)return;
  const listFocus=e.target===p.search||e.target===p.list;
  if(listFocus&&['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();movePicker(p,['ArrowDown','End'].includes(e.key)?1:-1,['Home','End'].includes(e.key));}
  if(listFocus&&(e.key==='Enter'||(e.target===p.list&&e.key===' '))){e.preventDefault();choosePicker(p,p.index);}
  if(e.target===p.list&&e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&e.key!==' '){
   e.preventDefault();const now=Date.now();p.typeahead=now-(p.typedAt||0)>700?e.key:(p.typeahead||'')+e.key;p.typedAt=now;
   const query=p.typeahead.toLocaleLowerCase(),prefix=[...query].every(c=>c===query[0])?query[0]:query;
   for(let offset=1;offset<=p.options.length;offset++){const index=(Math.max(-1,p.index)+offset)%p.options.length,o=p.options[index];if(!pickerOptionDisabled(o)&&(o.label||o.textContent).trim().toLocaleLowerCase().startsWith(prefix)){highlightPicker(p,index);break;}}
  }
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeFormPicker(true);}
  if(e.key==='Tab'){
   const local=[...popup.querySelectorAll('input,button,[tabindex]')].filter(el=>el.tabIndex>=0&&!el.matches(':disabled')&&el.checkVisibility());
   if(e.shiftKey&&e.target===local[0]){e.preventDefault();closeFormPicker(true);}
   else if(!e.shiftKey&&e.target===local.at(-1)){e.preventDefault();closeFormPicker(true);const root=p.trigger.closest('dialog')||document,items=[...root.querySelectorAll('button,input,select,textarea,summary,a[href],[tabindex]')].filter(el=>el.tabIndex>=0&&!el.matches(':disabled')&&!el.closest('[inert]')&&el.checkVisibility()&&!el.classList.contains('enhanced-select'));const next=items[items.indexOf(p.trigger)+1]||(root!==document?items[0]:null);next?.focus();}
  }
 });
 popup.addEventListener('click',e=>{const option=e.target.closest('[data-picker-index]');if(option)choosePicker(p,Number(option.dataset.pickerIndex));});
 p.empty.querySelector('button').addEventListener('click',()=>{p.search.value='';renderPicker(p);p.search.focus();});
 p.create.addEventListener('click',()=>{const name=p.search.value.trim();closeFormPicker();toggleAgentDomainEditor(true);$('#agent-domain-name').value=name;$('#agent-domain-name').dispatchEvent(new Event('input',{bubbles:true}));});
 select.addEventListener('change',()=>syncFormPicker(p));select.addEventListener('input',()=>syncFormPicker(p));
 select.addEventListener('focus',()=>{if(!p.wrapper.hidden&&document.activeElement===select)p.trigger.focus({preventScroll:true});});
 const observer=new MutationObserver(()=>syncFormPicker(p));observer.observe(select,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['disabled','required','aria-invalid','aria-describedby','aria-busy','aria-label','hidden','selected','value','label']});p.observer=observer;
 syncFormPicker(p);if(document.activeElement===select)p.trigger.focus({preventScroll:true});
}
function enhanceFieldMeter(field){
 if(!field.id||field.dataset.meterEnhanced||field.maxLength<1)return;
 field.dataset.meterEnhanced='true';const meter=document.createElement('span');meter.className='field-meter';meter.id=field.id+'-meter';meter.dataset.fieldMeter=field.id;meter.setAttribute('aria-label','输入长度');field.after(meter);
 field.setAttribute('aria-describedby',[field.getAttribute('aria-describedby'),meter.id].filter(Boolean).join(' '));
 const update=()=>{const text=field.value.length+' / '+field.maxLength;if(meter.textContent!==text)meter.textContent=text;meter.classList.toggle('near-limit',field.value.length>field.maxLength*.9);if(field.tagName==='TEXTAREA'&&field.getClientRects().length){field.style.height='auto';field.style.height=Math.min(240,Math.max(96,field.scrollHeight+2))+'px';}};
 field.addEventListener('input',update);field.addEventListener('compositionend',update);field.form?.addEventListener('reset',()=>queueMicrotask(update));field._updateMeter=update;update();
}
function setFieldInlineError(field,message){
 field.id||='task-field-'+(field.name||Date.now());field.setAttribute('aria-invalid','true');let hint=document.getElementById(field.id+'-hint-error');if(!hint){hint=document.createElement('span');hint.id=field.id+'-hint-error';hint.className='field-validation-error';(formPickers.get(field)?.wrapper||field).after(hint);}
 hint.textContent=message;field.dataset.inlineErrorOriginal??=field.getAttribute('aria-describedby')||'';field.setAttribute('aria-describedby',[field.dataset.inlineErrorOriginal,hint.id].filter(Boolean).join(' '));
}
function clearFieldInlineError(field){
 document.getElementById(field.id+'-hint-error')?.remove();if(field.dataset.inlineErrorOriginal!==undefined){const original=field.dataset.inlineErrorOriginal;if(original)field.setAttribute('aria-describedby',original);else field.removeAttribute('aria-describedby');delete field.dataset.inlineErrorOriginal;field.removeAttribute('aria-invalid');}
}
function refreshFormControls(){
 if(controlsQueued)return;controlsQueued=true;queueMicrotask(()=>{controlsQueued=false;
  for(const [select,p]of formPickers){if(!select.isConnected){if(pickerOpen===p)closeFormPicker();p.observer.disconnect();formPickers.delete(select);}}
  for(const select of document.querySelectorAll('select'))if(shouldEnhanceSelect(select))createFormPicker(select);
  for(const id of ['agent-name','agent-description','agent-prompt','agent-domain-name','agent-domain-description','task-goal']){const field=document.getElementById(id);if(field){enhanceFieldMeter(field);field._updateMeter?.();}}
  for(const p of formPickers.values())syncFormPicker(p);
 });
}
document.addEventListener('DOMContentLoaded',()=>{refreshFormControls();new MutationObserver(records=>{if(records.some(record=>!record.target.parentElement?.closest('.select-picker,.field-meter')&&!record.target.closest?.('.select-picker,.field-meter')&&!(record.type==='attributes'&&record.attributeName==='style'&&record.target.matches?.('input,textarea'))))refreshFormControls();}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open','hidden','disabled','inert','class','style']});});
document.addEventListener('pointerdown',e=>{if(pickerOpen&&!pickerOpen.wrapper.contains(e.target))closeFormPicker();},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.isComposing&&pickerOpen){e.preventDefault();e.stopImmediatePropagation();closeFormPicker(true);}},true);
document.addEventListener('click',e=>{const label=e.target.closest('label');if(label&&e.target===label){const p=formPickers.get(label.control||document.getElementById(label.htmlFor));if(p&&!p.wrapper.hidden){e.preventDefault();p.trigger.focus();}}});
document.addEventListener('input',e=>{if(e.isComposing)return;if(e.target.dataset?.inlineErrorOriginal!==undefined&&e.target.validity.valid&&e.target.value.trim())clearFieldInlineError(e.target);});
document.addEventListener('reset',refreshFormControls,true);window.addEventListener('resize',()=>{refreshFormControls();if(pickerOpen)positionPicker(pickerOpen);});
document.addEventListener('focusin',e=>{if(pickerOpen&&!pickerOpen.wrapper.contains(e.target))closeFormPicker();});
document.addEventListener('close',e=>{if(pickerOpen&&e.target.contains(pickerOpen.wrapper))closeFormPicker();},true);
document.addEventListener('scroll',e=>{if(pickerOpen&&!pickerOpen.popup.contains(e.target))positionPicker(pickerOpen);},true);
window.visualViewport?.addEventListener('resize',()=>{if(pickerOpen)positionPicker(pickerOpen);});
window.visualViewport?.addEventListener('scroll',()=>{if(pickerOpen)positionPicker(pickerOpen);});

document.addEventListener('compositionend',e=>{if(e.target.dataset?.inlineErrorOriginal!==undefined&&e.target.validity.valid&&e.target.value.trim())clearFieldInlineError(e.target);});

// Action disclosures use the same dismissal and keyboard behavior as pickers.
function actionDisclosures(){return [...document.querySelectorAll('.resource-create-menu,.flow-tools-more')].filter(menu=>menu.querySelector(':scope>summary')?.checkVisibility());}
function actionDisclosureItems(menu){return [...menu.querySelectorAll('button,a[href]')].filter(item=>!item.matches(':disabled')&&item.checkVisibility());}
document.addEventListener('toggle',e=>{if(!e.target.matches?.('.resource-create-menu,.flow-tools-more'))return;const menu=e.target,summary=menu.querySelector(':scope>summary');summary?.setAttribute('aria-expanded',String(menu.open));if(menu.open&&summary?.checkVisibility()){closeFormPicker();for(const other of actionDisclosures())if(other!==menu)other.open=false;}},true);
document.addEventListener('pointerdown',e=>{for(const menu of actionDisclosures())if(menu.open&&!menu.contains(e.target))menu.open=false;},true);
document.addEventListener('focusin',e=>{for(const menu of actionDisclosures())if(menu.open&&!menu.contains(e.target))menu.open=false;});
document.addEventListener('click',e=>{const item=e.target.closest('button,a[href]'),menu=item?.closest('.resource-create-menu,.flow-tools-more');if(menu&&actionDisclosures().includes(menu)&&!item.matches(':disabled')){menu.open=false;menu.querySelector(':scope>summary')?.focus({preventScroll:true});}});
document.addEventListener('keydown',e=>{
 if(e.isComposing)return;
 const menu=e.target.closest('.resource-create-menu,.flow-tools-more');if(!menu||!actionDisclosures().includes(menu))return;
 const summary=menu.querySelector(':scope>summary');
 if(e.key==='Escape'&&menu.open){e.preventDefault();e.stopImmediatePropagation();menu.open=false;summary.focus({preventScroll:true});return;}
 if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
 e.preventDefault();menu.open=true;const items=actionDisclosureItems(menu),index=items.indexOf(document.activeElement),next=e.key==='Home'?0:e.key==='End'?items.length-1:index<0?(e.key==='ArrowDown'?0:items.length-1):(index+(e.key==='ArrowDown'?1:items.length-1))%items.length;
 items[next]?.focus();
},true);
