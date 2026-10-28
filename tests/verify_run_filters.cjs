'use strict';

// Requires an explicitly supplied disposable service. All records belong to a
// new test workspace; no model execution or business write tool is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const base = (process.env.RUN_FILTER_BASE_URL || process.env.AGENT_UI_BASE_URL || '').replace(/\/$/, '');
assert(base, 'Set RUN_FILTER_BASE_URL or AGENT_UI_BASE_URL to an isolated preview service.');
const output = path.resolve(process.env.RUN_FILTER_OUTPUT || '/private/tmp/agent-run-filters');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' });
  page.setDefaultTimeout(12000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const report = { checks: [], errors: [], queries: [], layouts: [], fixtures: {} };
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/runs') report.queries.push(Object.fromEntries(url.searchParams));
  });
  const pass = text => { report.checks.push(text); console.log('PASS ' + text); };
  const call = (url, data) => page.evaluate(({ url, data }) => api(url, data), { url, data });
  const ready = async () => {
    await page.waitForFunction(() => state.connected && !state.busy && !document.querySelector('#content .route-loading'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const filters = () => page.locator('#run-filter-panel');
  const toggle = () => page.locator('[data-action="toggle-run-filters"]');
  const query = async (action, expected) => {
    const received = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/api/runs' && url.searchParams.get('limit') === '50' && expected(url.searchParams);
    });
    await action();
    const response = await received;
    assert(response.ok(), await response.text());
    const data = await response.json();
    await ready();
    return data;
  };
  const choose = async (id, value) => {
    const label = await page.locator('#' + id).evaluate((select, value) => [...select.options].find(option => option.value === value)?.label, value);
    assert(label, id + ' is missing option ' + value);
    await page.locator('#' + id + '-picker').click();
    const popup = page.locator('.select-popover:popover-open');
    const search = popup.locator('input[type=search]');
    if (await search.isVisible()) await search.fill(label);
    await popup.getByRole('option', { name: label, exact: true }).click();
  };
  const clear = async () => {
    const data = await query(() => page.locator('[data-action="clear-filter"]').first().click(), params => !['search', 'status', 'agent_id', 'domain', 'created_after', 'created_before', 'cursor'].some(key => params.has(key)));
    assert.equal(await page.locator('#run-search').inputValue(), '');
    assert.equal(await page.locator('#status-filter').inputValue(), 'all');
    assert.equal(await page.locator('#run-agent-filter').inputValue(), '');
    assert.equal(await page.locator('#run-domain-filter').inputValue(), '');
    assert.equal(await page.locator('#run-after').inputValue(), '');
    assert.equal(await page.locator('#run-before').inputValue(), '');
    assert.equal(await page.locator('.run-filter-chips [data-run-clear]').count(), 0);
    assert(await page.evaluate(() => document.activeElement.matches('#run-search,[data-action="toggle-run-filters"]')), 'Clearing filters lost focus to the page body or a removed button');
    return data;
  };
  const shot = name => page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
  const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  try {
    await page.goto(base + '/#/workbench');
    await ready();
    const workspace = await call('/api/workspaces', { name: '运行筛选独立验收 ' + Date.now(), business: '界面回归', scenario: '运行记录筛选', description: '临时隔离测试数据', revision: 0 });
    report.fixtures.workspaceId = workspace.id;
    await page.goto(base + '/?workspace_id=' + workspace.id + '#/runs');
    await ready();
    assert.equal(await toggle().getAttribute('aria-expanded'), 'false');
    assert.equal(await toggle().getAttribute('aria-controls'), 'run-filter-panel');
    assert.equal(await filters().isVisible(), false);
    assert(await page.locator('#run-search').isVisible());
    assert(await page.locator('#status-filter-picker').isVisible());
    assert(await page.locator('#run-sort-picker').isVisible());
    assert.equal(await page.locator('#run-sort').evaluate(el => !!el.closest('#run-filter-panel')), false);
    for (const id of ['status-filter', 'run-sort']) {
      await page.locator('#' + id + '-picker').click();
      assert.equal(await page.locator('.select-popover:popover-open .select-search').isVisible(), false, id + ' adds an unnecessary search field');
      await page.keyboard.press('Escape');
    }
    assert.equal(await page.locator('.run-pagination:visible').count(), 0);
    assert.match(await page.locator('.table-bottom').innerText(), /0\s*条/);
    assert.doesNotMatch(await page.locator('.table-bottom').innerText(), /第\s*1\s*页|0\s*\/\s*0/);
    await shot('empty-desktop');
    await toggle().focus();
    await page.keyboard.press('Enter');
    assert.equal(await toggle().getAttribute('aria-expanded'), 'true');
    assert(await filters().isVisible());
    await query(() => page.locator('[data-action="refresh"]').click(), params => params.get('sort') === 'created_desc');
    assert(await filters().isVisible(), 'Refreshing collapsed the advanced filters');
    await toggle().focus();
    await page.keyboard.press('Space');
    assert.equal(await filters().isVisible(), false);
    pass('Default layout shows search, status and sort; advanced filters expand by keyboard and keep their state on refresh; empty lists hide pagination');

    const fixture = await page.evaluate(async () => {
      const definition = (await api('/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;
      const firstDomain = await api('/api/agent-domains', { name: '客户服务与跨业务协作处理领域的长名称验收', description: '隔离筛选夹具', work_method: '只验证筛选' });
      const secondDomain = await api('/api/agent-domains', { name: '另一个隔离领域', description: '区分筛选结果', work_method: '' });
      const createAgent = (name, domain) => api('/api/agents', { name, description: '只用于运行记录筛选，不启动模型', runtime: 'mock', model: 'builtin', options: {}, prompt: '按照输入整理结果。', skills: [], mcp_servers: [], definition, processing_domain_id: domain, revision: 0 });
      const firstAgent = await createAgent('客户服务与跨业务长名称显示和筛选焦点验证智能体ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', firstDomain.id);
      const secondAgent = await createAgent('另一个隔离智能体', secondDomain.id);
      const ids = [];
      for (let index = 0; index < 52; index++) {
        const agent = index === 51 ? secondAgent : firstAgent;
        const data = await api('/api/runs', { goal: '筛选验收-' + (index === 51 ? '乙' : '甲') + '-' + String(index).padStart(3, '0'), agent_id: agent.id, agent_revision: agent.revision, start: false, grant: false });
        ids.push(data.run.run_id);
      }
      return { firstAgent, secondAgent, firstDomain, secondDomain, ids };
    });
    report.fixtures = { ...report.fixtures, agentId: fixture.firstAgent.id, secondAgentId: fixture.secondAgent.id, domainId: fixture.firstDomain.id, runIds: fixture.ids };
    await query(() => page.locator('[data-action="refresh"]').click(), params => params.get('sort') === 'created_desc');
    const firstPage = await page.locator('tr[data-run]').evaluateAll(rows => rows.map(row => row.dataset.run));
    assert.equal(firstPage.length, 50);
    assert(await page.locator('[data-run-page="next"]').isEnabled());
    const nextPage = await query(() => page.locator('[data-run-page="next"]').click(), params => !!params.get('cursor'));
    assert.equal(nextPage.runs.length, 2);
    assert.equal(await page.locator('tr[data-run]').count(), 2);
    assert.equal(firstPage.filter(id => nextPage.runs.some(row => row.run_id === id)).length, 0);
    await query(() => page.locator('[data-run-page="prev"]').click(), params => !params.has('cursor'));
    assert.deepEqual(await page.locator('tr[data-run]').evaluateAll(rows => rows.map(row => row.dataset.run)), firstPage);
    pass('Real cursor pagination shows 50 plus 2 saved records, without duplicates, and returns to the same first page');

    await query(() => choose('run-sort', 'created_asc'), params => params.get('sort') === 'created_asc' && !params.has('cursor'));
    assert.equal(await page.locator('#run-sort').inputValue(), 'created_asc');
    assert.equal(await page.locator('[data-action="clear-filter"]:visible').count(), 0, 'Sorting alone creates a filter-clear action');
    assert.equal(await filters().isVisible(), false, 'Sorting expanded the advanced panel');
    await toggle().click();
    const agentData = await query(() => choose('run-agent-filter', fixture.firstAgent.id), params => params.get('agent_id') === fixture.firstAgent.id && params.get('sort') === 'created_asc');
    assert.equal(agentData.filtered_total, 51);
    assert.equal(await page.locator('#run-agent-filter').inputValue(), fixture.firstAgent.id);
    assert.match(await toggle().innerText(), /1/);
    assert.equal(await page.locator('[data-run-clear="agent"]').count(), 1);
    const domainData = await query(() => choose('run-domain-filter', fixture.firstDomain.id), params => params.get('domain') === fixture.firstDomain.id && params.get('agent_id') === fixture.firstAgent.id);
    assert.equal(domainData.filtered_total, 51);
    assert.match(await toggle().innerText(), /2/);
    await toggle().click();
    assert.equal(await filters().isVisible(), false);
    assert(await page.locator('[data-run-clear="agent"]').isVisible(), 'Collapsing hides the active filter context');
    await query(() => page.locator('[data-action="refresh"]').click(), params => params.get('domain') === fixture.firstDomain.id && params.get('agent_id') === fixture.firstAgent.id && params.get('sort') === 'created_asc');
    assert.equal(await page.locator('#run-agent-filter').inputValue(), fixture.firstAgent.id);
    assert.equal(await page.locator('#run-domain-filter').inputValue(), fixture.firstDomain.id);
    assert.equal(await filters().isVisible(), false, 'Refreshing changed the user-selected collapsed state');
    const removed = await query(() => page.locator('[data-run-clear="domain"]').click(), params => !params.has('domain') && params.get('agent_id') === fixture.firstAgent.id);
    assert.equal(removed.filtered_total, 51);
    assert.equal(await page.locator('[data-run-clear="domain"]').count(), 0);
    assert(await page.evaluate(() => document.activeElement !== document.body && document.activeElement.checkVisibility()), 'Removing a filter chip lost visible focus');
    await clear();
    assert.equal(await page.locator('#run-sort').inputValue(), 'created_asc', 'Clearing filters reset the independent sort preference');
    pass('Agent and domain controls send real combined API filters, show their count and removable chips, retain values on refresh, and clear without losing focus or sort');

    await query(() => page.locator('#run-search').fill('筛选验收-甲-000'), params => params.get('search') === '筛选验收-甲-000');
    assert.equal(await page.locator('tr[data-run]').count(), 1);
    await query(() => choose('status-filter', 'CREATED'), params => params.get('status') === 'CREATED' && params.get('search') === '筛选验收-甲-000');
    assert.equal(await page.locator('tr[data-run]').count(), 1);
    const empty = await query(() => choose('status-filter', 'SUCCEEDED'), params => params.get('status') === 'SUCCEEDED' && params.get('search') === '筛选验收-甲-000');
    assert.equal(empty.filtered_total, 0);
    assert.equal(await page.locator('.run-pagination:visible').count(), 0);
    assert.match(await page.locator('.table-bottom').innerText(), /0\s*条/);
    assert.match(await page.locator('.empty h3').innerText(), /没有匹配/);
    await clear();
    pass('Search and status compose correctly; zero matches show a recovery action and a quiet 0-record count without a pager');

    if (!(await filters().isVisible())) await toggle().click();
    const dates = await page.evaluate(() => {
      const local = offset => { const day = new Date(); day.setDate(day.getDate() + offset); return [day.getFullYear(), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')].join('-'); };
      const yesterday = local(-1), tomorrow = local(1), future = local(2);
      return { yesterday, tomorrow, future, after: String(new Date(yesterday + 'T00:00:00').getTime() / 1000), before: String(new Date(tomorrow + 'T00:00:00').getTime() / 1000 + 86400) };
    });
    await query(() => page.locator('#run-after').fill(dates.yesterday), params => params.get('created_after') === dates.after);
    await query(() => page.locator('#run-before').fill(dates.tomorrow), params => params.get('created_after') === dates.after && params.get('created_before') === dates.before);
    assert.equal(await page.locator('tr[data-run]').count(), 50);
    await page.locator('#run-after').fill(dates.future);
    await page.locator('#run-date-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#run-after').getAttribute('aria-invalid'), 'true');
    assert.match(await page.locator('#run-after').getAttribute('aria-describedby') || '', /run-date-error/);
    await query(() => page.locator('[data-action="refresh"]').click(), params => !!params.get('created_after') && !!params.get('created_before'));
    assert.equal(await page.locator('#run-after').inputValue(), dates.future, 'A refresh discarded the invalid date draft');
    assert(await page.locator('#run-date-error').isVisible());
    assert.equal(report.queries.filter(params => params.created_after && params.created_before && Number(params.created_after) >= Number(params.created_before)).length, 0, 'An invalid reversed date range reached the API');
    await query(() => page.locator('#run-after').fill(dates.yesterday), params => params.get('created_after') === dates.after && params.get('created_before') === dates.before);
    assert.equal(await page.locator('#run-date-error').isVisible(), false);
    assert.notEqual(await page.locator('#run-after').getAttribute('aria-invalid'), 'true');
    await clear();
    pass('Invalid date ranges are explained at the field and preserved on refresh; only validated ranges reach the API and correction clears the error');

    if (!(await filters().isVisible())) await toggle().click();
    await query(() => choose('run-agent-filter', fixture.firstAgent.id), params => params.get('agent_id') === fixture.firstAgent.id);
    await query(() => choose('run-domain-filter', fixture.firstDomain.id), params => params.get('domain') === fixture.firstDomain.id);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { const appearance = document.getElementById('appearance-select'); appearance.value = theme; appearance.dispatchEvent(new Event('change', { bubbles: true })); }, theme);
      for (const width of [320, 375, 414, 768, 1440]) {
        await page.setViewportSize({ width, height: width <= 414 ? 900 : 1000 });
        await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
        const layout = await page.evaluate(() => ({
          theme: document.documentElement.dataset.theme, width: innerWidth,
          root: document.documentElement.scrollWidth, body: document.body.scrollWidth,
          panel: document.querySelector('#run-filter-panel').scrollWidth,
          panelWidth: document.querySelector('#run-filter-panel').clientWidth,
          compactLabels: ['status-filter', 'run-sort'].map(id => { const text = document.querySelector('#' + id + '-picker > span'); return { id, text: text.textContent, width: text.clientWidth, scrollWidth: text.scrollWidth }; }),
          pagination: [...document.querySelectorAll('.run-pagination button')].map(button => { const range = document.createRange(); range.selectNodeContents(button); return { text: button.textContent, fragments: range.getClientRects().length, width: button.getBoundingClientRect().width }; }),
        }));
        assert(layout.root <= width && layout.body <= width, `${theme} ${width}: page overflow`);
        assert(layout.panel <= layout.panelWidth + 1, `${theme} ${width}: filter panel overflow`);
        assert(layout.compactLabels.every(label => label.scrollWidth <= label.width + 1), `${theme} ${width}: a default status or sort label is truncated`);
        assert(layout.pagination.length === 2 && layout.pagination.every(button => button.fragments === 1), `${theme} ${width}: pagination labels wrapped`);
        report.layouts.push(layout);
        if (width === 375 || width === 1440) await shot(`filters-${theme}-${width}`);
        await page.locator('#run-agent-filter-picker').click();
        const popup = await page.locator('.select-popover:popover-open').boundingBox();
        assert(popup.x >= 0 && popup.x + popup.width <= width + 1, `${theme} ${width}: long-name menu escapes viewport`);
        await page.keyboard.press('Escape');
      }
    }
    pass('Long selected names, filter chips, menus and single-line pagination fit five viewport sizes in light and dark themes');
    assert.deepEqual(report.errors, []);
    save();
    console.log('Run-filter checks passed: ' + report.checks.length + '; evidence: ' + output);
  } catch (error) {
    report.failure = error.stack;
    await shot('failure').catch(() => {});
    save();
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
