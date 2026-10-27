/* Appearance and navigation preferences are local to this browser, never task permissions. */
(() => {
  'use strict';
  const root = document.documentElement;
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const compactViewport = matchMedia('(max-width: 959px)');
  const read = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
  const save = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  let appearance = read('af-appearance', 'dark');
  if (!['system', 'light', 'dark'].includes(appearance)) appearance = 'dark';
  function applyTheme() {
    root.dataset.theme = appearance === 'system' ? (systemTheme.matches ? 'dark' : 'light') : appearance;
    root.dataset.appearance = appearance;
    const select = document.getElementById('appearance-select');
    if (select) { select.value = appearance; if (typeof refreshFormControls === 'function') refreshFormControls(); }
  }
  applyTheme();
  systemTheme.addEventListener('change', applyTheme);
  document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.getElementById('app-sidebar');
    const shell = document.querySelector('.shell');
    const toggle = document.getElementById('sidebar-toggle');
    const scrim = document.getElementById('nav-scrim');
    const select = document.getElementById('appearance-select');
    let collapsed = read('af-navigation-collapsed', 'false') === 'true';
    let mobileOpen = false;
    const dismiss = document.createElement('button');
    dismiss.type = 'button'; dismiss.className = 'icon-button sidebar-dismiss';
    dismiss.setAttribute('aria-label', '关闭导航'); dismiss.innerHTML = '<span data-icon="close"></span>';
    sidebar.prepend(dismiss);
    function updateNavigation(returnFocus = false) {
      const mobile = compactViewport.matches;
      root.dataset.navCollapsed = String(!mobile && collapsed);
      root.dataset.navOpen = String(mobile && mobileOpen);
      sidebar.inert = mobile && !mobileOpen;
      if (mobile && mobileOpen) { sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); }
      else { sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); }
      shell.inert = mobile && mobileOpen;
      scrim.hidden = !(mobile && mobileOpen);
      toggle.setAttribute('aria-expanded', String(mobile ? mobileOpen : !collapsed));
      const label = mobile ? '打开导航' : collapsed ? '展开导航' : '收起导航';
      toggle.setAttribute('aria-label', label); toggle.title = label;
      if (returnFocus) toggle.focus({preventScroll: true});
    }
    function closeNavigation() { mobileOpen = false; updateNavigation(true); }
    toggle.addEventListener('click', () => {
      if (compactViewport.matches) {
        mobileOpen = !mobileOpen; updateNavigation();
        if (mobileOpen) dismiss.focus({preventScroll: true});
      } else { collapsed = !collapsed; save('af-navigation-collapsed', String(collapsed)); updateNavigation(); }
    });
    dismiss.addEventListener('click', closeNavigation);
    scrim.addEventListener('click', closeNavigation);
    sidebar.addEventListener('click', event => {
      if (compactViewport.matches && event.target.closest('a, [data-action="help"]')) closeNavigation();
    });
    document.addEventListener('keydown', event => {
      if (!compactViewport.matches || !mobileOpen || document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') { event.preventDefault(); closeNavigation(); }
      if (event.key === 'Tab') {
        const items = [...sidebar.querySelectorAll('a,button,select')].filter(el => !el.disabled && el.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    compactViewport.addEventListener('change', () => { const needsFocus = sidebar.contains(document.activeElement); mobileOpen = false; updateNavigation(needsFocus); });
    select.addEventListener('change', () => { appearance = select.value; save('af-appearance', appearance); applyTheme(); });
    applyTheme(); updateNavigation();
    if (typeof hydrate === 'function') hydrate(sidebar);
  });
})();
