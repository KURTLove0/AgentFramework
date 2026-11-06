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
    const navigation = document.getElementById('main-navigation');
    const navigationFrame = sidebar.querySelector('.sidebar-navigation');
    const scrollControls = [...sidebar.querySelectorAll('[data-nav-scroll]')];
    let navigationFrameRequest = 0;
    let currentNavigation = null;
    let revealNavigation = false;
    let revealCurrentNavigation = false;

    // Scroll only the navigation region: choosing a route must not move the page
    // or take focus from a search result, editor, or restored reading position.
    function revealNavigationItem(item) {
      if (!item || !navigation.contains(item)) return;
      const bounds = navigation.getBoundingClientRect(), target = item.getBoundingClientRect();
      const delta = target.top < bounds.top + 4 ? target.top - bounds.top - 4
        : target.bottom > bounds.bottom - 4 ? target.bottom - bounds.bottom + 4 : 0;
      if (delta) navigation.scrollBy({top: delta, behavior: 'instant'});
    }
    function scheduleNavigation(reveal = false, current = false) {
      revealNavigation ||= reveal;
      revealCurrentNavigation ||= current;
      if (navigationFrameRequest) return;
      navigationFrameRequest = requestAnimationFrame(() => {
        navigationFrameRequest = 0;
        if (!navigationFrame.clientHeight) return;
        // Compare with the whole frame so the controls' own height cannot keep
        // them visible after the window grows large enough to fit every link.
        const overflowing = navigation.scrollHeight > navigationFrame.clientHeight + 1;
        scrollControls.forEach(button => { button.hidden = !overflowing; });
        if (revealNavigation) {
          revealNavigationItem(!revealCurrentNavigation && navigation.contains(document.activeElement)
            ? document.activeElement : navigation.querySelector('[aria-current="page"]'));
          revealNavigation = false;
          revealCurrentNavigation = false;
        }
        const atTop = navigation.scrollTop <= 1;
        const atBottom = navigation.scrollTop + navigation.clientHeight >= navigation.scrollHeight - 1;
        scrollControls.forEach(button => {
          const up = button.dataset.navScroll === 'up', atEdge = up ? atTop : atBottom;
          button.setAttribute('aria-disabled', String(atEdge));
          button.title = atEdge ? (up ? '已到导航顶部' : '已到导航底部') : button.getAttribute('aria-label');
          button.lastElementChild.textContent = atEdge ? (up ? '已到顶部' : '已到末尾') : (up ? '上方导航' : '更多导航');
        });
      });
    }
    scrollControls.forEach(button => button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      navigation.scrollBy({top: (button.dataset.navScroll === 'up' ? -1 : 1) * Math.max(40, navigation.clientHeight - 48), behavior: 'instant'});
    }));
    navigation.addEventListener('scroll', () => scheduleNavigation(), {passive: true});
    navigation.addEventListener('focusin', event => revealNavigationItem(event.target));
    const navigationResize = new ResizeObserver(() => scheduleNavigation(true));
    [navigationFrame, navigation, ...navigation.children].forEach(element => navigationResize.observe(element));
    new MutationObserver(() => {
      const active = navigation.querySelector('[aria-current="page"]');
      if (active === currentNavigation) return;
      currentNavigation = active;
      scheduleNavigation(true, true);
    }).observe(navigation, {subtree: true, attributes: true, attributeFilter: ['aria-current']});
    document.fonts.ready.then(() => scheduleNavigation(true));
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
      scheduleNavigation(true);
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
