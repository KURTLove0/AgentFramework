'use strict';

let helpSession = null;
function helpFocusTarget(candidate) {
  return candidate?.isConnected && !candidate.disabled && (candidate.tabIndex >= 0 || candidate.hasAttribute('tabindex') || candidate.isContentEditable) && !candidate.closest('[inert],dialog:not([open])') && candidate.getClientRects().length
    ? candidate : document.querySelector('[data-action="help"]');
}
function openHelp(opener = document.activeElement) {
  if (document.querySelector('dialog[open]')) return;
  const dialog = document.getElementById('help-dialog');
  helpSession = {opener: helpFocusTarget(opener), route: location.hash};
  dialog.showModal();
  dialog.querySelector('.help-body').scrollTop = 0;
  dialog.querySelector('[data-close]').focus({preventScroll: true});
}
async function startTaskFromHelp() {
  const opener = helpFocusTarget(helpSession?.opener);
  const route = location.hash, workspace = state.workspaceId;
  helpSession = null;
  document.getElementById('help-dialog').close();
  await newTask({}, opener);
  const editor = document.getElementById('create-dialog'), session = taskJourney.editorSession;
  if (!editor.open || route !== location.hash || workspace !== state.workspaceId) return;
  // The task's loading state temporarily disables its opener. Native dialog
  // restoration therefore cannot reliably return to it after cancelling.
  editor.addEventListener('close', () => {
    if (session === taskJourney.editorSession && route === location.hash && workspace === state.workspaceId && !document.querySelector('dialog[open]')) {
      helpFocusTarget(opener)?.focus({preventScroll: true});
    }
  }, {once: true});
}
document.getElementById('help-dialog').addEventListener('close', () => {
  if (document.getElementById('help-dialog').open) return;
  const session = helpSession;
  helpSession = null;
  if (session && session.route === location.hash && !document.querySelector('dialog[open]')) {
    helpFocusTarget(session.opener)?.focus({preventScroll: true});
  }
});
document.addEventListener('keydown', event => {
  if (event.key !== '?' || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || state.composing || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target.isContentEditable || target.closest('input,textarea,select,[role="textbox"],[role="combobox"]') || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  openHelp(target);
});

// Match the visible hints and assistive shortcut metadata to the host platform.
const helpMacPlatform = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || '');
document.querySelectorAll('[data-shortcut-modifier]').forEach(key => { key.textContent = helpMacPlatform ? '⌘' : 'Ctrl'; });
const helpCommandTrigger = document.querySelector('[data-action="command"]');
helpCommandTrigger.setAttribute('aria-keyshortcuts', (helpMacPlatform ? 'Meta' : 'Control') + '+K');
helpCommandTrigger.title = '搜索与命令（' + (helpMacPlatform ? '⌘ K' : 'Ctrl K') + '）';
