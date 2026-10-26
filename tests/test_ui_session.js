'use strict';

// Run with: node tests/test_ui_session.js
// Exercise the actual browser API helper in an isolated VM. All fetch responses
// and timeout errors are synthetic; no server, browser, model or network is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.resolve(__dirname, '..', 'agent_framework', 'webui', 'app.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const start = source.indexOf('async function api(');
const end = source.indexOf('\nfunction error(', start);
assert(start >= 0 && end > start, 'Could not locate the actual app.js API helper');
const apiSource = source.slice(start, end);

const response = (status, data) => ({
  status,
  ok: status >= 200 && status < 300,
  async json() { return data; },
});
const stale = () => response(403, {error: '页面会话已失效，请刷新后重试'});
const session = () => response(200, {
  csrf_token: 'new-token',
  tenant: 'tenant-test',
  workspace: {id: 'session-workspace'},
  version: 'session-version',
});
const timeout = message => Object.assign(new Error(message), {name: 'TimeoutError'});
const intent = "api('/api/workflow-runs/flow-test/resume',{node_id:'node-test'},42000)";
let passed = 0;

async function scenario(name, responses, expression, verify) {
  const calls = [];
  const state = {
    workspaceId: 'workspace-alpha',
    meta: {
      tenant: 'tenant-test',
      csrf_token: 'old-token',
      workspace: {id: 'workspace-alpha'},
      version: 'original-version',
    },
  };
  let index = 0;
  const fetch = async (requestPath, options) => {
    calls.push({path: requestPath, ...options, headers: {...options.headers}});
    assert(index < responses.length, 'Unexpected request or mutation replay');
    const next = responses[index++];
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next({path: requestPath, options, state, calls});
    return next;
  };
  const context = vm.createContext({
    state,
    fetch,
    // A recorded deadline is sufficient for a mocked fetch. Timeout outcomes
    // below are explicit rejected requests rather than elapsed wall-clock waits.
    AbortSignal: {timeout: timeoutMs => ({timeoutMs})},
  });
  vm.runInContext(apiSource, context, {filename: sourcePath});
  let result;
  let error;
  try {
    result = await vm.runInContext(expression, context);
  } catch (caught) {
    error = caught;
  }
  verify({calls, result, error, state});
  passed += 1;
  console.log('PASS ' + name);
}

async function main() {
  await scenario('explicit stale POST refreshes once and returns the retried result',
    [stale(), session(), response(202, {accepted: true, id: 'original'})], intent,
    ({calls, result, error, state}) => {
      assert.ifError(error);
      assert.equal(result.id, 'original');
      assert.deepEqual(calls.map(call => [call.path, call.method]), [
        ['/api/workflow-runs/flow-test/resume', 'POST'],
        ['/api/session', 'GET'],
        ['/api/workflow-runs/flow-test/resume', 'POST'],
      ]);
      assert.equal(calls[0].headers['X-Agent-Token'], 'old-token');
      assert.equal(calls[2].headers['X-Agent-Token'], 'new-token');
      assert.equal(calls[0].body, calls[2].body);
      assert.equal(calls[1].body, undefined);
      assert(!('X-Agent-Token' in calls[1].headers));
      assert(calls.every(call => call.headers['X-Agent-Workspace'] === 'workspace-alpha'));
      assert(calls.every(call => call.signal.timeoutMs === 42000));
      assert.equal(state.meta.csrf_token, 'new-token');
      assert.equal(state.meta.version, 'original-version');
      assert.equal(state.meta.workspace.id, 'workspace-alpha');
    });

  await scenario('a second stale response stops after one retry',
    [stale(), session(), stale()], intent, ({calls, error}) => {
      assert.equal(calls.length, 3);
      assert.match(error.message, /页面会话已失效/);
    });

  await scenario('ordinary authorization 403 never refreshes or replays',
    [response(403, {error: '此动作需要授权'})], intent, ({calls, error}) => {
      assert.equal(calls.length, 1);
      assert.match(error.message, /需要授权/);
    });

  await scenario('a stale GET never triggers mutation recovery',
    [stale()], "api('/api/runs')", ({calls, error}) => {
      assert.equal(calls.length, 1);
      assert(error);
    });

  for (const [name, failure] of [
    ['network failure', new TypeError('fetch failed')],
    ['request timeout', timeout('request timed out')],
    ['unknown write outcome', new TypeError('connection closed after write')],
  ]) {
    await scenario(name + ' never replays', [failure], intent, ({calls, error}) => {
      assert.equal(calls.length, 1);
      assert.equal(error, failure);
    });
  }

  await scenario('an unreadable success response never replays', [{
    status: 200,
    ok: true,
    async json() { throw new SyntaxError('Unexpected end of JSON'); },
  }], intent, ({calls, error}) => {
    assert.equal(calls.length, 1);
    assert.equal(error.name, 'SyntaxError');
  });

  await scenario('session refresh 403 stops without another POST',
    [stale(), stale()], intent, ({calls, error}) => {
      assert.equal(calls.length, 2);
      assert.equal(calls[1].method, 'GET');
      assert.match(error.message, /页面会话已失效/);
    });

  await scenario('session refresh timeout stops without another POST',
    [stale(), timeout('session timed out')], intent, ({calls, error}) => {
      assert.equal(calls.length, 2);
      assert.equal(error.name, 'TimeoutError');
    });

  await scenario('an uncertain retry response is never replayed again',
    [stale(), session(), new TypeError('retry response lost')], intent,
    ({calls, error}) => {
      assert.equal(calls.length, 3);
      assert.match(error.message, /response lost/);
    });

  await scenario('callers can explicitly disable session recovery',
    [stale()], "api('/api/runs',{goal:'模拟'},15000,false)", ({calls, error}) => {
      assert.equal(calls.length, 1);
      assert.match(error.message, /页面会话已失效/);
    });

  await scenario('workspace switching stops replay and preserves the original session scope', [
    stale(),
    ({state}) => {
      state.workspaceId = 'workspace-beta';
      return session();
    },
  ], "api('/api/knowledge/assets',{kind:'KNOWLEDGE',title:'仅模拟'})",
  ({calls, error, state}) => {
    assert.equal(calls.length, 2);
    assert.match(error.message, /工作空间已切换.*此操作未执行/);
    assert(calls.every(call => call.headers['X-Agent-Workspace'] === 'workspace-alpha'));
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(state.meta.csrf_token, 'old-token');
  });

  await scenario('a tenant change stops replay and retains the original token',
    [stale(), response(200, {csrf_token: 'new-token', tenant: 'tenant-other'})], intent,
    ({calls, error, state}) => {
      assert.equal(calls.length, 2);
      assert.match(error.message, /服务环境已变化/);
      assert.equal(state.meta.csrf_token, 'old-token');
    });

  await scenario('retry payload remains frozen if the caller mutates its object', [
    stale(),
    ({state}) => {
      state.payload.goal = 'changed-after-send';
      return session();
    },
    response(200, {ok: true}),
  ], "state.payload={goal:'original'};api('/api/runs',state.payload)",
  ({calls, result, error}) => {
    assert.ifError(error);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].body, calls[2].body);
    assert.equal(JSON.parse(calls[2].body).goal, 'original');
  });

  assert.equal(passed, 15);
  console.log('\n15 isolated UI session checks passed. No network requests were made.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
