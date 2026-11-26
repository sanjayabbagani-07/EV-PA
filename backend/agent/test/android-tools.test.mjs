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
  ]);
  assert.equal(registry.validateArgs('android.open_app', { app_name: 'Maps', unexpected: true }).ok, false);
  assert.equal((await registry.execute('android.open_app', { app_name: 'Maps' }, { userId: 'owner', store: new InMemoryStore() })).error.code, 'TOOL_UNAVAILABLE');
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
    verified: true,
    verification: 'Android accepted the launch intent.',
  }, now);
  const result = await execution;
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.data.packageName, 'com.example.maps');
});

test('Android UI tools require Accessibility and reject sensitive text targets', async () => {
  const h = await connectedHarness(false);
  const back = await h.registry.execute('android.go_back', {}, h.ctx);
  assert.equal(back.error.code, 'ACCESSIBILITY_REQUIRED');
  const typeText = h.registry.get('android.type_text');
  const denied = evaluate(typeText, { target: 'Password field', text: 'not-a-real-password' }, {});
  const otp = evaluate(typeText, { target: 'Search', text: '123456' }, {});
  assert.equal(denied.decision, 'deny');
  assert.equal(otp.decision, 'deny');
  assert.equal(evaluate(typeText, { target: 'Search', text: 'charging stations' }, {}).decision, 'allow');
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
