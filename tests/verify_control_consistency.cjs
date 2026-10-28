'use strict';

// Real application controls, exercised in a temporary browser-only dialog.
// The server may use an empty temporary data directory; this script never saves
// agents, domains, workspaces, tasks, or other business records.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const base = process.env.CONTROL_UI_BASE_URL || 'http://127.0.0.1:8876';
const output = path.resolve(process.env.CONTROL_UI_OUTPUT || '/private/tmp/agent-control-consistency');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const checks = [], errors = [], geometry = [];
  page.on('pageerror', error => errors.push(error.message));
  const pass = (id, detail) => { checks.push({ id, detail, passed: true }); console.log('PASS ' + id + ' ' + detail); };
  const trigger = id => page.locator('#' + id + '-picker');
  const popup = () => page.locator('.select-popover:popover-open');
  const close = async () => { if (await popup().count()) await page.keyboard.press('Escape'); };
  const open = async id => { await close(); await trigger(id).click(); await popup().waitFor(); };
  const activeId = () => page.evaluate(() => document.activeElement.id);
  const activeOption = () => page.evaluate(() => {
    const el = document.activeElement;
    return document.getElementById(el.getAttribute('aria-activedescendant'))?.textContent.trim() || '';
  });
  const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, geometry }, null, 2));
  try {
    await page.goto(base + '/#/agents');
    await page.locator('#content h1').waitFor();
    const routes = ['workbench', 'runs', 'agents', 'workflows', 'skills', 'library', 'daily', 'evaluations', 'workspaces', 'registry', 'domains', 'runtimes'];
    for (const route of routes) {
      await page.goto(base + '/#/' + route);
      await page.waitForFunction(view => typeof state !== 'undefined' && state.view === view && !!document.querySelector('#content h1'), route);
      await page.waitForFunction(() => !state.busy && !document.querySelector('#content .route-loading'));
      await page.waitForFunction(() => typeof refreshFormControls === 'function');
      await page.evaluate(() => refreshFormControls());
      await page.waitForFunction(() => !!document.querySelector('#appearance-select-picker'));
      const view = await page.evaluate(() => ({
        route: state.view,
        overflow: document.documentElement.scrollWidth > innerWidth,
        controls: [...document.querySelectorAll('#content .select-trigger, #content input:not([type=hidden]):not([type=checkbox]):not([type=radio]), #content textarea')]
          .filter(el => el.getClientRects().length && !el.classList.contains('enhanced-select'))
          .map(el => { const shell = el.closest('.filter-input,.resource-search') || el; return { id: el.id, height: shell.getBoundingClientRect().height, fieldHeight: el.getBoundingClientRect().height, radius: getComputedStyle(shell).borderRadius, font: getComputedStyle(el).fontSize }; }),
      }));
      assert.equal(view.overflow, false, route + ' overflows horizontally');
      for (const control of view.controls) {
        assert(control.height >= 40, `${route} ${control.id}: desktop control shorter than 40px (${control.height}px)`);
        assert.equal(control.radius, '8px', `${route} ${control.id}: control radius differs`);
        assert.equal(control.font, '14px', `${route} ${control.id}: control text size differs`);
      }
      geometry.push(view);
    }
    pass('routes', 'All twelve real routes render without page overflow; visible control geometry recorded');

    await page.goto(base + '/#/agents');
    await page.waitForFunction(() => !state.busy && state.view === 'agents' && !document.querySelector('#content .route-loading'));
    await page.locator('[data-action="new-agent"]').first().click();
    await page.locator('#agent-dialog[open]').waitFor();
    await trigger('agent-domain').waitFor({ state: 'visible' });
    await open('agent-domain');
    const domainSearch = popup().locator('input[type=search]');
    const draftDomain = 'UI consistency unsaved domain';
    await domainSearch.fill(draftDomain);
    await page.keyboard.press('Tab');
    assert.equal(await popup().locator('.select-empty button').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await popup().locator('.select-create').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.equal(await popup().count(), 0);
    assert.equal(await page.locator('#agent-domain-name').inputValue(), draftDomain);
    assert.equal(await page.locator('#agent-domain-create-fields').isVisible(), true);
    assert.equal(await activeId(), 'agent-domain-name');
    await page.evaluate(() => document.getElementById('agent-dialog').close());
    pass('domain-create-keyboard', 'The real domain picker exposes clear and create actions to Tab and opens an unsaved domain editor with Enter');

    await page.goto(base + '/#/library');
    await page.waitForFunction(() => !state.busy && state.view === 'library' && !document.querySelector('#content .route-loading'));
    await page.locator('#hub-tab-memory').click();
    const memoryMenu = page.locator('.resource-create-menu');
    const memorySummary = memoryMenu.locator(':scope > summary');
    await memorySummary.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await memoryMenu.evaluate(el => el.open), true);
    assert.equal(await memoryMenu.locator('[data-new-memory]').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('End');
    assert.equal(await memoryMenu.locator('[data-new-preference]').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Home');
    assert.equal(await memoryMenu.locator('[data-new-memory]').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await memoryMenu.evaluate(el => el.open), false);
    assert.equal(await memorySummary.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('ArrowUp');
    assert.equal(await memoryMenu.locator('[data-new-preference]').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.locator('#asset-dialog[open]').waitFor();
    assert.equal(await page.locator('#asset-kind').inputValue(), 'PREFERENCE');
    assert.equal(await memoryMenu.evaluate(el => el.open), false);
    await page.locator('#asset-dialog [data-close]').last().click();
    await memorySummary.click();
    await page.locator('#hub-query').click();
    assert.equal(await memoryMenu.evaluate(el => el.open), false);
    await memorySummary.focus();
    await page.keyboard.press('ArrowDown');
    await page.locator('#hub-query').focus();
    assert.equal(await memoryMenu.evaluate(el => el.open), false);
    pass('action-menu', 'The real memory menu supports arrows, Home, End, Escape, outside clicks and focus departure; Enter opens an unsaved preference');

    await page.evaluate(() => {
      const dialog = document.createElement('dialog');
      dialog.id = 'control-consistency-fixture';
      dialog.className = 'structured-dialog';
      dialog.setAttribute('aria-labelledby', 'ui-audit-title');
      dialog.innerHTML = `<form id="ui-audit-form" class="structured-dialog-form"><div class="dialog-head"><h2 id="ui-audit-title">Control consistency verification</h2></div><div class="dialog-body">
        <button id="ui-audit-before" type="button">Before fields</button>
        <label for="ui-audit-short"><span>Short choices</span><select id="ui-audit-short" required aria-describedby="ui-audit-help"><option value="">Choose a value</option><option value="a">Alpha</option><option value="aa">Apricot</option><option value="b" selected>Beta</option><option value="c">Gamma</option><option value="d" disabled>Unavailable</option></select></label>
        <p id="ui-audit-help" class="field-help">Existing help remains associated.</p>
        <input id="ui-audit-next" aria-label="Next field" value="Keep this value">
        <label>Long choices<select id="ui-audit-long">${Array.from({ length: 12 }, (_, i) => `<option value="${i}">Choice ${String(i).padStart(2, '0')}</option>`).join('')}</select></label>
        <fieldset id="ui-audit-fieldset"><legend>Disable inherited controls</legend><label>Fieldset choices<select id="ui-audit-inherited"><option value="one">One</option><option value="two">Two</option></select></label></fieldset>
        <label>Grouped choices<select id="ui-audit-grouped"><optgroup id="ui-audit-group" label="Editable group"><option value="g1">Group one</option><option id="ui-audit-option" value="g2">Group two</option></optgroup><option value="outside">Outside group</option></select></label>
        <details id="ui-audit-details"><summary>Initially closed advanced fields</summary><label>Advanced choice<select id="ui-audit-advanced"><option>Advanced one</option><option>Advanced two</option></select></label></details>
        <div id="ui-audit-scroll"><div id="ui-audit-scroll-before"></div><label>Scrolling choice<select id="ui-audit-scrolling"><option>Scrolling one</option><option>Scrolling two</option></select></label><div id="ui-audit-scroll-after"></div></div>
        <label>Text field<input id="ui-audit-text" required placeholder="Type here"></label>
        <label>Multiline field<textarea id="ui-audit-textarea" rows="3" placeholder="Write here"></textarea></label>
      </div><div class="dialog-foot"><button id="ui-audit-reset" type="reset" class="button secondary">Reset fields</button><button id="ui-audit-last" type="button" class="button primary">After fields</button></div></form>`;
      document.body.append(dialog);
      // Assign individual style properties because the application's CSP rejects
      // style attributes parsed from HTML, including this browser-only fixture.
      Object.assign(document.getElementById('ui-audit-scroll').style, { height: '180px', overflow: 'auto', border: '1px solid var(--border)' });
      document.getElementById('ui-audit-scroll-before').style.height = '70px';
      document.getElementById('ui-audit-scroll-after').style.height = '400px';
      dialog.showModal();
      refreshFormControls();
    });
    await trigger('ui-audit-short').waitFor();
    assert.equal(await trigger('ui-audit-short').textContent().then(s => s.trim()), 'Beta');
    assert.equal(await trigger('ui-audit-short').getAttribute('aria-required'), 'true');
    assert.equal(await trigger('ui-audit-short').getAttribute('aria-describedby'), 'ui-audit-help');
    const accessibleLabel = await trigger('ui-audit-short').evaluate(el => el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '));
    assert(accessibleLabel.includes('Short choices'));
    assert(!accessibleLabel.includes('Alpha') && !accessibleLabel.includes('Unavailable'), 'Accessible label includes unselected options');
    await open('ui-audit-short');
    assert.equal(await popup().locator('.select-search').isVisible(), false);
    assert.equal(await popup().locator('[role=listbox]').evaluate(el => document.activeElement === el), true);
    assert.equal(await popup().getByRole('option', { name: 'Unavailable', exact: true }).getAttribute('aria-disabled'), 'true');
    pass('short-menu', 'Short menus focus the option list, omit search, and preserve disabled choices and a clean label');

    await page.keyboard.press('Home');
    assert.equal(await activeOption(), 'Choose a value');
    await page.keyboard.press('ArrowDown');
    assert.equal(await activeOption(), 'Alpha');
    await page.keyboard.press('End');
    assert.equal(await activeOption(), 'Gamma', 'End must skip the disabled final option');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#ui-audit-short').inputValue(), 'c');
    assert.equal(await activeId(), 'ui-audit-short-picker');
    await page.keyboard.press('ArrowUp');
    await popup().waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#ui-audit-short').inputValue(), 'c');
    assert.equal(await page.locator('#control-consistency-fixture').isVisible(), true);
    assert.equal(await activeId(), 'ui-audit-short-picker');
    await open('ui-audit-short');
    await page.keyboard.press('Tab');
    assert.equal(await popup().count(), 0);
    assert.equal(await activeId(), 'ui-audit-next');
    await open('ui-audit-short');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await popup().count(), 0);
    assert.equal(await activeId(), 'ui-audit-short-picker');
    await open('ui-audit-short');
    await page.keyboard.press('Home');
    await page.keyboard.press('a');
    assert.equal(await activeOption(), 'Alpha');
    await page.keyboard.press('a');
    assert.equal(await activeOption(), 'Apricot');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#ui-audit-short').inputValue(), 'aa');
    await open('ui-audit-short');
    await page.keyboard.press('b');
    assert.equal(await activeOption(), 'Beta', 'A new menu session retained the previous typeahead prefix');
    await page.keyboard.press('Escape');
    pass('keyboard', 'Home, End, arrows, Enter, Escape and both Tab directions preserve selection and predictable focus');

    await page.evaluate(() => {
      const field = document.getElementById('ui-audit-short');
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', 'ui-audit-help ui-audit-title');
      field.setAttribute('aria-busy', 'true');
    });
    await page.waitForFunction(() => document.getElementById('ui-audit-short-picker').getAttribute('aria-invalid') === 'true');
    assert.equal(await trigger('ui-audit-short').getAttribute('aria-describedby'), 'ui-audit-help ui-audit-title');
    assert.equal(await trigger('ui-audit-short').getAttribute('aria-busy'), 'true');
    await page.evaluate(() => {
      const field = document.getElementById('ui-audit-short');
      field.disabled = true;
      field.required = false;
      field.removeAttribute('aria-invalid');
      field.removeAttribute('aria-busy');
    });
    await page.waitForFunction(() => document.getElementById('ui-audit-short-picker').disabled);
    assert.equal(await trigger('ui-audit-short').getAttribute('aria-required'), 'false');
    assert.equal(await trigger('ui-audit-short').getAttribute('aria-invalid'), null);
    assert.equal(await trigger('ui-audit-short').getAttribute('aria-busy'), null);
    await page.evaluate(() => { document.getElementById('ui-audit-short').disabled = false; document.getElementById('ui-audit-fieldset').disabled = true; });
    await page.waitForFunction(() => document.getElementById('ui-audit-inherited-picker').disabled);
    await page.evaluate(() => { document.getElementById('ui-audit-fieldset').disabled = false; });
    await page.waitForFunction(() => !document.getElementById('ui-audit-inherited-picker').disabled);
    pass('state-sync', 'Required, errors, help, busy and direct or inherited disabled states track the native fields');

    await open('ui-audit-grouped');
    await page.evaluate(() => { document.getElementById('ui-audit-group').disabled = true; });
    const groupTwo = popup().getByRole('option', { name: 'Group two', exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('.select-popover:popover-open [role=option]')].some(el => el.textContent.includes('Group two') && el.getAttribute('aria-disabled') === 'true'));
    await groupTwo.click({ force: true });
    assert.equal(await page.locator('#ui-audit-grouped').inputValue(), 'g1');
    assert.equal(await popup().count(), 1, 'Clicking a disabled option closes the popup');
    await page.evaluate(() => { document.getElementById('ui-audit-group').disabled = false; document.getElementById('ui-audit-option').label = 'Renamed group two'; });
    await popup().getByRole('option', { name: 'Renamed group two', exact: true }).waitFor();
    await page.evaluate(() => { document.getElementById('ui-audit-option').removeAttribute('label'); document.getElementById('ui-audit-option').firstChild.data = 'Updated group two'; });
    await popup().getByRole('option', { name: 'Updated group two', exact: true }).waitFor();
    await page.evaluate(() => { document.getElementById('ui-audit-option').disabled = true; });
    await page.waitForFunction(() => [...document.querySelectorAll('.select-popover:popover-open [role=option]')].some(el => el.textContent.includes('Updated group two') && el.getAttribute('aria-disabled') === 'true'));
    await page.keyboard.press('End');
    assert.equal(await activeOption(), 'Outside group');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#ui-audit-grouped').inputValue(), 'outside');
    pass('dynamic-options', 'Disabled groups and options cannot be chosen; option labels and text-node edits update while open');

    await page.locator('#ui-audit-details > summary').click();
    await trigger('ui-audit-advanced').waitFor({ state: 'visible' });
    await page.evaluate(() => { document.getElementById('ui-audit-details').open = false; });
    await trigger('ui-audit-advanced').waitFor({ state: 'hidden' });
    await page.locator('#ui-audit-details > summary').click();
    await trigger('ui-audit-advanced').waitFor({ state: 'visible' });
    await page.locator('#ui-audit-reset').click();
    await page.waitForFunction(() => document.querySelector('#ui-audit-short-picker > span').textContent === 'Beta');
    assert.equal(await page.locator('#ui-audit-short').inputValue(), 'b');
    pass('disclosure-reset', 'Initially hidden advanced selects enhance on reveal and native reset restores the displayed choice');

    await open('ui-audit-long');
    const search = popup().locator('input[type=search]');
    assert.equal(await search.evaluate(el => el === document.activeElement), true);
    await search.fill('Choice');
    await page.keyboard.press('Space');
    assert.equal(await search.inputValue(), 'Choice ');
    assert.equal(await popup().count(), 1, 'A search-space selected an option');
    await search.fill('Choice 09');
    assert.equal(await popup().getByRole('option').count(), 1);
    const beforeIME = await page.locator('#ui-audit-long').inputValue();
    await search.evaluate(el => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })); });
    assert.equal(await popup().count(), 1, 'IME Escape dismissed the picker');
    assert.equal(await page.locator('#ui-audit-long').inputValue(), beforeIME, 'IME Enter committed an option');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#ui-audit-long').inputValue(), '9');
    await open('ui-audit-long');
    await search.fill('No matching result');
    await page.keyboard.press('Tab');
    assert.equal(await popup().locator('.select-empty button').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.equal(await search.inputValue(), '');
    await page.keyboard.press('Escape');
    pass('search-ime', 'Long menus search, allow empty-state recovery by keyboard, and leave composition Enter/Escape alone');

    await open('ui-audit-scrolling');
    const before = { field: await trigger('ui-audit-scrolling').boundingBox(), popup: await popup().boundingBox(), placement: await popup().getAttribute('data-placement') };
    await page.evaluate(() => { const el = document.getElementById('ui-audit-scroll'); el.scrollTop += el.scrollTop > 30 ? -24 : 24; });
    await page.waitForFunction(y => Math.abs(document.querySelector('.select-popover:popover-open').getBoundingClientRect().top - y) >= 20, before.popup.y);
    const after = { field: await trigger('ui-audit-scrolling').boundingBox(), popup: await popup().boundingBox(), placement: await popup().getAttribute('data-placement') };
    assert(Math.abs(after.field.y - before.field.y) >= 20, 'The scroll fixture did not move its trigger');
    // Crossing the available-space threshold may legitimately flip the menu.
    // Verify the actual anchor gap on both sides instead of assuming one side.
    for (const frame of [before, after]) {
      const gap = frame.placement === 'top' ? frame.field.y - frame.popup.y - frame.popup.height : frame.popup.y - frame.field.y - frame.field.height;
      assert(gap >= 0 && gap <= 8, 'Popup detached from its scrolling trigger: ' + JSON.stringify(frame));
    }
    geometry.push({ context: 'scroll-anchor', before, after });
    await close();
    pass('scroll-anchor', 'An open menu follows its trigger while the enclosing form scrolls');

    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { const appearance = document.getElementById('appearance-select'); appearance.value = value; appearance.dispatchEvent(new Event('change', { bubbles: true })); }, theme);
      for (const width of [320, 375, 414, 768, 1440]) {
        await page.setViewportSize({ width, height: width <= 414 ? 812 : 1000 });
        await open('ui-audit-short');
        const box = await popup().boundingBox();
        assert(box.x >= -1 && box.x + box.width <= width + 1, `${theme} ${width}: popup escapes horizontally`);
        assert(box.y >= -1 && box.y + box.height <= (width <= 414 ? 812 : 1000) + 1, `${theme} ${width}: popup escapes vertically`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const metrics = await trigger('ui-audit-short').evaluate(el => ({ height: el.getBoundingClientRect().height, radius: getComputedStyle(el).borderRadius, font: getComputedStyle(el).fontSize, touch: matchMedia('(max-width:700px),(pointer:coarse)').matches }));
        assert(metrics.height >= (metrics.touch ? 44 : 40), 'Control is shorter than its desktop or touch target');
        assert.equal(metrics.radius, '8px');
        assert.equal(metrics.font, metrics.touch ? '16px' : '14px');
        const surface = await popup().evaluate(el => ({ radius: getComputedStyle(el).borderRadius, filter: getComputedStyle(el).backdropFilter, image: getComputedStyle(el).backgroundImage }));
        assert.equal(surface.radius, '12px');
        assert.equal(surface.filter, 'none', 'Menu surface still blurs the page');
        assert.equal(surface.image, 'none', 'Menu surface still carries a decorative gradient');
        geometry.push({ theme, width, popup: box, trigger: metrics });
        if (width === 375 || width === 1440) await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), animations: 'disabled' });
        await close();
      }
    }
    pass('visual-consistency', 'Light and dark menus stay within five viewport sizes, use solid 12px menu surfaces, and share 40px/14px desktop or 44px/16px touch controls with 8px radii');
    const touchContext = await browser.newContext({ viewport: { width: 1024, height: 900 }, hasTouch: true, isMobile: true });
    const touchPage = await touchContext.newPage();
    await touchPage.goto(base + '/#/runs');
    await touchPage.waitForFunction(() => state.connected && !state.busy && !!document.getElementById('status-filter-picker'));
    const touchControl = await touchPage.locator('#status-filter-picker').evaluate(el => ({ coarse: matchMedia('(pointer:coarse)').matches, height: el.getBoundingClientRect().height, font: getComputedStyle(el).fontSize, radius: getComputedStyle(el).borderRadius }));
    assert.equal(touchControl.coarse, true);
    assert(touchControl.height >= 44);
    assert.equal(touchControl.font, '16px');
    assert.equal(touchControl.radius, '8px');
    geometry.push({ context: 'wide-touch', ...touchControl });
    await touchContext.close();
    pass('coarse-pointer', 'A touch device keeps 44px targets and 16px field text even above the mobile width breakpoint');
    assert.deepEqual(errors, []);
    save();
    console.log('Control consistency checks passed: ' + checks.length + '; evidence: ' + output);
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
    save();
    throw error;
  } finally {
    await page.evaluate(() => document.getElementById('control-consistency-fixture')?.remove()).catch(() => {});
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
