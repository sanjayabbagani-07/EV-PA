import test from 'node:test';
import assert from 'node:assert/strict';
import { ANDROID_TOOLS } from '../tools/android.mjs';
import { ToolRegistry } from '../registry.mjs';
import { InMemoryStore } from '../store.mjs';
import { evaluate } from '../policy.mjs';

const now = Date.parse('2026-11-26T14:00:00Z');

async function connectedHarness(accessibilityEnabled = true) {
  const store = new InMemoryStore({ now: () => now });
  await store.createDevice({
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'owner',
    platform: 'android',
    name: 'Test phone',
    status: 'active',
    tokenHash: 'a'.repeat(64),
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    accessibilityEnabled,
    appDiscoveryAvailable: true,
  });
  const registry = new ToolRegistry();
  ANDROID_TOOLS.forEach((tool) => registry.register(tool));
  const ctx = { userId: 'owner', store, now: () => now };
  return { registry, store, ctx };
}

async function executeWithMockedDevice(harness, toolName, args, deviceResult) {
  const execution = harness.registry.execute(toolName, args, harness.ctx);
  let command = null;
  for (let i = 0; i < 20 && !command; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    command = await harness.store.claimNextDeviceCommand('11111111-1111-4111-8111-111111111111', now);
  }
  assert.ok(command, `${toolName} should queue an Android command`);
  assert.equal(await harness.store.completeDeviceCommand(
    '11111111-1111-4111-8111-111111111111',
    command.id,
    deviceResult,
    now,
  ), true);
  return { command, result: await execution };
}

test('Android tools are registered with strict schemas and unavailable while no device is connected', async () => {
  const registry = new ToolRegistry();
  ANDROID_TOOLS.forEach((tool) => registry.register(tool));
  assert.deepEqual(registry.names(), [
    'android.get_device_status',
    'android.list_apps',
    'android.open_app',
    'android.open_url',
    'android.go_back',
    'android.tap_element',
    'android.type_text',
    'android.scroll',
    'android.get_visible_state',
    'android.search_in_app',
  ]);
  assert.equal(registry.validateArgs('android.open_app', { app_name: 'Maps', unexpected: true }).ok, false);
  assert.equal(registry.validateArgs('android.search_in_app', {
    field_target: 'Search',
    query: 'weather',
    submit_target: 'Search',
    submit_match_by: 'text',
    unexpected: true,
  }).ok, false);
  assert.equal(registry.validateArgs('android.type_text', { target: 'Search', text: 'hello', extra: true }).ok, false);
  assert.equal(registry.validateArgs('android.scroll', { direction: 'down', extra: true }).ok, false);
  assert.equal(registry.validateArgs('android.tap_element', { target: 'Continue', match_by: 'text', extra: true }).ok, false);
  assert.equal((await registry.execute('android.open_app', { app_name: 'Maps' }, { userId: 'owner', store: new InMemoryStore() })).error.code, 'TOOL_UNAVAILABLE');
});

test('Android app discovery and launch return the paired device outcome without overstating launch verification', async () => {
  const h = await connectedHarness();
  const listed = await executeWithMockedDevice(h, 'android.list_apps', {}, {
    ok: true,
    data: { apps: [{ name: 'Maps', packageName: 'com.example.maps' }], count: 1, truncated: false },
    verified: true,
    verification: 'Queried launchable application labels and package identifiers.',
  });
  assert.equal(listed.command.action, 'list_apps');
  assert.deepEqual(listed.result.data.apps[0], { name: 'Maps', packageName: 'com.example.maps' });
  assert.equal(listed.result.verified, true);

  const launched = await executeWithMockedDevice(h, 'android.open_app', { app_name: 'Maps' }, {
    ok: true,
    data: { app: 'Maps', packageName: 'com.example.maps', launchInitiated: true },
    verified: false,
    verification: 'Android accepted the launch intent; destination screen readiness was not verified.',
  });
  assert.equal(launched.command.action, 'open_app');
  assert.equal(launched.result.ok, true);
  assert.equal(launched.result.verified, false);

  const unavailable = await executeWithMockedDevice(h, 'android.open_app', { app_name: 'Missing app' }, {
    ok: false,
    error: { code: 'APP_NOT_FOUND', message: 'No launchable installed app matched that name.' },
    verified: false,
  });
  assert.equal(unavailable.result.error.code, 'APP_NOT_FOUND');
});

test('Android inspection, typing, scrolling, tapping, navigation and search relay structured device outcomes', async () => {
  const h = await connectedHarness();
  const cases = [
    ['android.get_visible_state', {}, 'get_visible_state', true, { packageName: 'com.example.app', visibleLabels: [], editableFields: [] }],
    ['android.type_text', { target: 'Search', text: 'coffee' }, 'type_text', true, { target: 'Search', textEntered: true }],
    ['android.scroll', { direction: 'down' }, 'scroll', false, { direction: 'down', actionInitiated: true }],
    ['android.tap_element', { target: 'Continue', match_by: 'text' }, 'tap_element', false, { target: 'Continue', actionInitiated: true }],
    ['android.go_back', {}, 'go_back', false, {}],
    ['android.search_in_app', { field_target: 'Search', query: 'coffee', submit_target: 'Search', submit_match_by: 'text' }, 'search_in_app', false,
      { fieldTarget: 'Search', submitTarget: 'Search', queryEntered: true, searchSubmitted: true }],
  ];

  for (const [toolName, args, action, verified, data] of cases) {
    const { command, result } = await executeWithMockedDevice(h, toolName, args, {
      ok: true,
      data,
      verified,
      verification: verified ? 'Observed accessible state.' : 'Action accepted; resulting app state was not verified.',
    });
    assert.equal(command.action, action);
    assert.equal(result.ok, true);
    assert.equal(result.verified, verified);
    assert.deepEqual(result.data, data);
  }
});

test('Android tool call is queued for the paired device and returns the device verification', async () => {
  const h = await connectedHarness();
  const execution = h.registry.execute('android.open_app', { app_name: 'Maps' }, h.ctx);
  let command = null;
  for (let i = 0; i < 20 && !command; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    command = await h.store.claimNextDeviceCommand('11111111-1111-4111-8111-111111111111', now);
  }
  assert.equal(command.action, 'open_app');
  assert.deepEqual(command.arguments, { app_name: 'Maps' });
  await h.store.completeDeviceCommand(command.deviceId || '11111111-1111-4111-8111-111111111111', command.id, {
    ok: true,
    data: { app: 'Maps', packageName: 'com.example.maps' },
    verified: false,
    verification: 'Android accepted the launch intent; destination screen readiness was not verified.',
  }, now);
  const result = await execution;
  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.equal(result.data.packageName, 'com.example.maps');
});

test('Android UI tools require Accessibility and reject sensitive text targets', async () => {
  const h = await connectedHarness(false);
  const deniedActions = [
    ['android.go_back', {}],
    ['android.get_visible_state', {}],
    ['android.tap_element', { target: 'Continue', match_by: 'text' }],
    ['android.type_text', { target: 'Search', text: 'charging stations' }],
    ['android.scroll', { direction: 'down' }],
    ['android.search_in_app', {
      field_target: 'Search',
      query: 'charging stations',
      submit_target: 'Search',
      submit_match_by: 'text',
    }],
  ];
  for (const [toolName, args] of deniedActions) {
    const denied = await h.registry.execute(toolName, args, h.ctx);
    assert.equal(denied.error.code, 'ACCESSIBILITY_REQUIRED', toolName);
  }
  assert.equal(await h.store.claimNextDeviceCommand('11111111-1111-4111-8111-111111111111', now), null);
  const typeText = h.registry.get('android.type_text');
  const denied = evaluate(typeText, { target: 'Password field', text: 'not-a-real-password' }, {});
  const otp = evaluate(typeText, { target: 'Search', text: '123456' }, {});
  const searchTool = h.registry.get('android.search_in_app');
  const sensitiveSearch = evaluate(searchTool, {
    field_target: 'Search',
    query: '123456',
    submit_target: 'Search',
  }, {});
  const deleteTool = h.registry.get('android.tap_element');
  const consequentialTaps = ['Send message', 'Delete account', 'Pay now'].map((target) =>
    evaluate(deleteTool, { target, match_by: 'text' }, {}).decision
  );
  const invalidSearchSubmit = evaluate(searchTool, {
    field_target: 'Search',
    query: 'weather',
    submit_target: 'Continue',
  }, {}).decision;
  const ambiguousSearchSubmit = evaluate(searchTool, {
    field_target: 'Search',
    query: 'weather',
    submit_target: 'Search history',
  }, {}).decision;
  const lowRiskTap = evaluate(deleteTool, { target: 'Continue', match_by: 'text' }, {}).decision;
  assert.equal(denied.decision, 'deny');
  assert.equal(otp.decision, 'deny');
  assert.equal(sensitiveSearch.decision, 'deny');
  assert.deepEqual(consequentialTaps, ['confirm', 'confirm', 'confirm']);
  assert.equal(invalidSearchSubmit, 'deny');
  assert.equal(ambiguousSearchSubmit, 'deny');
  assert.equal(lowRiskTap, 'confirm');
  assert.equal(evaluate(typeText, { target: 'Search', text: 'charging stations' }, {}).decision, 'allow');
});

test('Android search command is authenticated, queued, and reports what was verified', async () => {
  const h = await connectedHarness();
  const execution = h.registry.execute('android.search_in_app', {
    field_target: 'Search',
    query: 'Python tutorials',
    submit_target: 'Search',
    submit_match_by: 'content_description',
  }, h.ctx);
  let command = null;
  for (let i = 0; i < 20 && !command; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    command = await h.store.claimNextDeviceCommand('11111111-1111-4111-8111-111111111111', now);
  }
  assert.equal(command.action, 'search_in_app');
  assert.deepEqual(command.arguments, {
    field_target: 'Search',
    query: 'Python tutorials',
    submit_target: 'Search',
    submit_match_by: 'content_description',
  });
  await h.store.completeDeviceCommand(command.deviceId || '11111111-1111-4111-8111-111111111111', command.id, {
    ok: true,
    data: { fieldTarget: 'Search', submitTarget: 'Search', queryEntered: true, searchSubmitted: true },
    verified: false,
    verification: 'Accessible query field and submit action were verified; result loading was not.',
  }, now);
  const result = await execution;
  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.match(result.verification, /result loading was not/i);
});

test('Android command timeouts return a structured failure to the caller', async () => {
  const h = await connectedHarness();
  h.store.waitForDeviceCommand = async () => null;
  const result = await h.registry.execute('android.list_apps', {}, h.ctx);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'COMMAND_TIMEOUT');
  assert.equal(result.verified, false);
});

test('Android device status reports only owner-scoped connection and permission metadata', async () => {
  const h = await connectedHarness(true);
  const result = await h.registry.execute('android.get_device_status', {}, h.ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.devices[0], {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Test phone',
    connected: true,
    accessibilityEnabled: true,
    appDiscoveryAvailable: true,
    status: 'active',
    lastSeenAt: new Date(now).toISOString(),
  });
});
