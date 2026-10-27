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
function controlLabel(select){return select.labels?.[0]?.childNodes[0]?.textContent.trim()||select.getAttribute('aria-label')||'选项';}
function focusFormControl(field){const picker=formPickers.get(field);(picker?.trigger||field)?.focus({preventScroll:true});(picker?.trigger||field)?.scrollIntoView({block:'nearest',behavior:'instant'});}
function closeFormPicker(restore=false){
 const p=pickerOpen;if(!p)return;pickerOpen=null;
 if(p.popup.hidePopover&&p.popup.matches(':popover-open'))p.popup.hidePopover();p.popup.hidden=true;p.trigger.setAttribute('aria-expanded','false');p.trigger.removeAttribute('aria-activedescendant');
 if(restore&&p.trigger.isConnected)p.trigger.focus({preventScroll:true});
}
function pickerOptions(p){return [...p.select.options].filter(o=>!o.disabled&&!o.parentElement.disabled&&o.textContent.toLocaleLowerCase().includes(p.search.value.trim().toLocaleLowerCase()));}
function highlightPicker(p,index){
 p.index=Math.max(0,Math.min(p.options.length-1,index));
 [...p.list.children].forEach((node,i)=>node.classList.toggle('is-active',i===p.index));
 const active=p.list.children[p.index];if(active){p.search.setAttribute('aria-activedescendant',active.id);active.scrollIntoView({block:'nearest'});}else p.search.removeAttribute('aria-activedescendant');
}
function pickerFingerprint(p){return JSON.stringify([p.select.value,p.search.value,[...p.select.options].map(o=>[o.value,o.textContent,o.disabled])]);}
function renderPicker(p){
 p.fingerprint=pickerFingerprint(p);p.options=pickerOptions(p);p.list.innerHTML=p.options.map((o,i)=>`<div role="option" id="${p.select.id}-option-${i}" aria-selected="${o.value===p.select.value}" data-picker-index="${i}"><span>${esc(o.textContent)}</span>${o.value===p.select.value?icon('check'):''}</div>`).join('');
 p.empty.hidden=!!p.options.length;p.status.textContent=p.options.length+' 个可选项';
 p.create.hidden=p.select.id!=='agent-domain';p.create.textContent=p.search.value.trim()?'新建“'+p.search.value.trim()+'”领域':'新建处理领域';
 highlightPicker(p,Math.max(0,p.options.findIndex(o=>o.value===p.select.value)));
}
function positionPicker(p){
 const box=p.trigger.getBoundingClientRect(),margin=12,width=Math.min(Math.max(box.width,280),innerWidth-margin*2);
 const below=innerHeight-box.bottom-margin,above=box.top-margin,up=below<220&&above>below,height=Math.min(360,Math.max(120,up?above:below));
 Object.assign(p.popup.style,{width:width+'px',maxHeight:height+'px',left:Math.max(margin,Math.min(box.left,innerWidth-width-margin))+'px',top:(up?Math.max(margin,box.top-height-6):box.bottom+6)+'px'});
}
function openFormPicker(p){
 if(p.wrapper.hidden||p.select.matches(':disabled'))return;
 syncFormPicker(p);closeFormPicker();pickerOpen=p;p.search.value='';p.popup.hidden=false;
 renderPicker(p);positionPicker(p);if(p.popup.showPopover)p.popup.showPopover();p.trigger.setAttribute('aria-expanded','true');p.search.focus({preventScroll:true});
}
function choosePicker(p,index){
 const o=p.options[index];if(!o)return;
 const changed=p.select.value!==o.value;p.select.value=o.value;syncFormPicker(p);closeFormPicker(true);if(changed){p.select.dispatchEvent(new Event('input',{bubbles:true}));p.select.dispatchEvent(new Event('change',{bubbles:true}));}else p.select.dispatchEvent(new CustomEvent('picker-selected',{bubbles:true}));
}
function syncFormPicker(p){
 const selected=p.select.selectedOptions[0],text=selected?.textContent||'请选择'+controlLabel(p.select),hidden=pickerSourceHidden(p.select);
 if(p.value.textContent!==text)p.value.textContent=text;
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
 const label=select.labels?.[0];if(label){label.id||=select.id+'-label';trigger.setAttribute('aria-labelledby',label.id+' '+value.id);}else trigger.setAttribute('aria-label',controlLabel(select));
 const popup=document.createElement('div');popup.className='select-popover';popup.setAttribute('popover','manual');popup.hidden=true;
 popup.innerHTML=`<div class="select-search">${icon('search')}<input type="search" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="${select.id}-options" aria-label="搜索${esc(controlLabel(select))}" placeholder="搜索${esc(controlLabel(select))}"></div><p class="select-result-count" role="status"></p><div id="${select.id}-options" class="select-options" role="listbox" aria-label="${esc(controlLabel(select))}"></div><div class="select-empty" hidden><p>没有找到匹配的选项</p><button type="button" class="text-button">清除搜索</button></div><button type="button" class="select-create" hidden></button><div class="select-keyboard-hints" aria-hidden="true"><span>↑ ↓ 选择 · ↵ 确认</span><span>Esc 关闭</span></div>`;
 wrapper.append(trigger,popup);select.after(wrapper);select.classList.add('enhanced-select');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
 const p={select,wrapper,trigger,value,popup,search:popup.querySelector('input'),status:popup.querySelector('[role=status]'),list:popup.querySelector('[role=listbox]'),empty:popup.querySelector('.select-empty'),create:popup.querySelector('.select-create'),index:0,options:[]};formPickers.set(select,p);
 trigger.addEventListener('click',()=>pickerOpen===p?closeFormPicker(true):openFormPicker(p));
 trigger.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();openFormPicker(p);if(e.key==='End')highlightPicker(p,p.options.length-1);}});
 p.search.addEventListener('input',e=>{if(!e.isComposing)renderPicker(p);});p.search.addEventListener('compositionend',()=>renderPicker(p));
 p.search.addEventListener('keydown',e=>{
  if(e.isComposing)return;
  if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();highlightPicker(p,p.index+(e.key==='ArrowDown'?1:-1));}
  if(e.key==='Enter'){e.preventDefault();choosePicker(p,p.index);}
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeFormPicker(true);}
  if(e.key==='Tab'){e.preventDefault();closeFormPicker(true);if(!e.shiftKey){const root=p.trigger.closest('dialog')||document,items=[...root.querySelectorAll('button,input,select,textarea,summary,a[href]')].filter(el=>!el.disabled&&el.tabIndex>=0&&el.getClientRects().length&&!el.classList.contains('enhanced-select'));const next=items[items.indexOf(p.trigger)+1];next?.focus({preventScroll:true});}}
 });
 popup.addEventListener('click',e=>{const option=e.target.closest('[data-picker-index]');if(option)choosePicker(p,Number(option.dataset.pickerIndex));});
 p.empty.querySelector('button').addEventListener('click',()=>{p.search.value='';renderPicker(p);p.search.focus();});
 p.create.addEventListener('click',()=>{const name=p.search.value.trim();closeFormPicker();toggleAgentDomainEditor(true);$('#agent-domain-name').value=name;$('#agent-domain-name').dispatchEvent(new Event('input',{bubbles:true}));});
 select.addEventListener('change',()=>syncFormPicker(p));select.addEventListener('input',()=>syncFormPicker(p));
 select.addEventListener('focus',()=>{if(!p.wrapper.hidden&&document.activeElement===select)p.trigger.focus({preventScroll:true});});
 const observer=new MutationObserver(()=>syncFormPicker(p));observer.observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','required','aria-invalid','aria-describedby','aria-busy','hidden']});p.observer=observer;
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
document.addEventListener('DOMContentLoaded',()=>{refreshFormControls();new MutationObserver(refreshFormControls).observe(document.body,{childList:true,subtree:true});});
document.addEventListener('pointerdown',e=>{if(pickerOpen&&!pickerOpen.wrapper.contains(e.target))closeFormPicker();},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&pickerOpen){e.preventDefault();e.stopImmediatePropagation();closeFormPicker(true);}},true);
document.addEventListener('click',e=>{const label=e.target.closest('label');if(label&&e.target===label){const p=formPickers.get(label.control||document.getElementById(label.htmlFor));if(p&&!p.wrapper.hidden){e.preventDefault();p.trigger.focus();}}});
document.addEventListener('input',e=>{if(e.isComposing)return;if(e.target.dataset?.inlineErrorOriginal!==undefined&&e.target.validity.valid&&e.target.value.trim())clearFieldInlineError(e.target);});
document.addEventListener('reset',refreshFormControls,true);window.addEventListener('resize',()=>{refreshFormControls();if(pickerOpen)positionPicker(pickerOpen);});

document.addEventListener('compositionend',e=>{if(e.target.dataset?.inlineErrorOriginal!==undefined&&e.target.validity.valid&&e.target.value.trim())clearFieldInlineError(e.target);});
