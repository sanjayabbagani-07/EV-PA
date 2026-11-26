import { ToolError } from '../errors.mjs';

const DEVICE_ONLINE_MS = 90_000;
const COMMAND_TIMEOUT_MS = 30_000;
const ACCESSIBILITY_ACTIONS = new Set(['go_back', 'tap_element', 'type_text', 'scroll', 'get_visible_state']);
const sensitiveTarget = /\b(password|passcode|passwd|pin|otp|code|verification|one[- ]time|2fa|mfa|cvv|cvc|card number|payment|security code|ssn)\b/i;
const sensitiveValue = /^(?:\d{4,8}|(?:\d[ -]?){13,19})$/;

function connectedDevices(ctx) {
  const now = ctx.now();
  return ctx.store.listDevices(ctx.userId).then((devices) => devices.filter((device) =>
    device.platform === 'android' && device.status === 'active' &&
    Number.isFinite(Date.parse(device.lastSeenAt || '')) && now - Date.parse(device.lastSeenAt) <= DEVICE_ONLINE_MS
  ));
}

async function selectDevice(ctx, requestedId) {
  const devices = await connectedDevices(ctx);
  if (requestedId) {
    const selected = devices.find((device) => device.id === requestedId);
    if (!selected) throw new ToolError('ANDROID_DEVICE_OFFLINE', 'That Android device is not connected or does not belong to this account.');
    return selected;
  }
  if (devices.length === 0) throw new ToolError('ANDROID_DEVICE_OFFLINE', 'No paired Android device is currently connected. Open EV on the paired phone.');
  if (devices.length > 1) throw new ToolError('ANDROID_DEVICE_AMBIGUOUS', 'More than one Android device is connected. Specify the device_id to control.');
  return devices[0];
}

function availability(ctx) {
  return ctx.store?.hasConnectedDevice?.(ctx.userId)
    ? true
    : 'Pair an Android device and open the EV companion app to connect it.';
}

function makeCommandTool({
  name, description, action, required = [], properties = {}, sideEffects = false,
  permission = 'auto', scanArgs = false, scanFields, summarize, timeoutMs = 35_000,
}) {
  return {
    name,
    description,
    permission,
    sideEffects,
    timeoutMs,
    ...(scanArgs ? { scanArgs: true, scanFields } : {}),
    ...(summarize ? { summarize } : {}),
    ...(['type_text', 'tap_element'].includes(action) ? {
      assess: ({ target, text }) => sensitiveTarget.test(String(target || '')) ||
          (action === 'type_text' && (sensitiveTarget.test(String(text || '')) || sensitiveValue.test(String(text || '').trim())))
        ? { decision: 'deny', category: 'credentials', reason: 'EV will not interact with password, verification, payment, or other sensitive fields.' }
        : { decision: 'allow' },
    } : {}),
    available: availability,
    parameters: { type: 'object', required, properties: {
      ...properties,
      device_id: { type: 'string', minLength: 36, maxLength: 36, description: 'Optional paired device id, required only when multiple phones are connected.' },
    } },
    async run(args, ctx) {
      const device = await selectDevice(ctx, args.device_id);
      if (ACCESSIBILITY_ACTIONS.has(action) && device.accessibilityEnabled !== true) {
        return {
          ok: false,
          error: {
            code: 'ACCESSIBILITY_REQUIRED',
            message: 'Enable EV Accessibility Service manually in Android Settings, then return to the EV companion app.',
          },
          verified: false,
        };
      }

      const id = crypto.randomUUID();
      const createdAt = ctx.now();
      const command = {
        id,
        userId: ctx.userId,
        deviceId: device.id,
        action,
        arguments: Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'device_id')),
        createdAt,
        expiresAt: createdAt + COMMAND_TIMEOUT_MS,
      };
      const queued = await ctx.store.createDeviceCommand(command);
      if (!queued) {
        return { ok: false, error: { code: 'ANDROID_DEVICE_OFFLINE', message: 'The Android device disconnected before the command could be queued.' }, verified: false };
      }
      try {
        const result = await ctx.store.waitForDeviceCommand(id, { signal: ctx.signal, timeoutMs: COMMAND_TIMEOUT_MS });
        if (!result) return { ok: false, error: { code: 'COMMAND_TIMEOUT', message: 'The Android device did not return a command result.' }, verified: false };
        return result;
      } finally {
        await ctx.store.cancelDeviceCommand(id);
        await ctx.store.deleteDeviceCommand(id);
      }
    },
  };
}

export const androidGetDeviceStatus = {
  name: 'android.get_device_status',
  description: 'Check the connection and permissions of paired Android devices, including whether EV Accessibility Service is enabled.',
  permission: 'auto',
  timeoutMs: 2000,
  parameters: { type: 'object', properties: {} },
  async run(_args, ctx) {
    const devices = await ctx.store.listDevices(ctx.userId);
    const now = ctx.now();
    return {
      ok: true,
      verified: true,
      verification: 'Read the authenticated owner device registry.',
      data: {
        devices: devices.filter((device) => device.platform === 'android').map((device) => ({
          id: device.id,
          name: device.name,
          connected: device.status === 'active' && Number.isFinite(Date.parse(device.lastSeenAt || '')) && now - Date.parse(device.lastSeenAt) <= DEVICE_ONLINE_MS,
          accessibilityEnabled: device.accessibilityEnabled === true,
          appDiscoveryAvailable: device.appDiscoveryAvailable === true,
          status: device.status,
          lastSeenAt: device.lastSeenAt,
        })),
      },
    };
  },
};

const deviceId = { type: 'string', minLength: 36, maxLength: 36, description: 'Optional paired device id, required only when multiple phones are connected.' };
export const androidTools = [
  makeCommandTool({
    name: 'android.list_apps',
    description: 'List launchable installed Android applications and their package ids on the connected paired phone.',
    action: 'list_apps',
    timeoutMs: 15_000,
  }),
  makeCommandTool({
    name: 'android.open_app',
    description: 'Launch an installed Android application by its displayed name or package id.',
    action: 'open_app',
    required: ['app_name'],
    properties: { app_name: { type: 'string', minLength: 1, maxLength: 100, description: 'Installed application label or package id.' } },
    sideEffects: true,
    summarize: ({ app_name }) => `Open Android app "${app_name}"`,
  }),
  makeCommandTool({
    name: 'android.open_url',
    description: 'Open a safe HTTP or HTTPS URL with an Android application that supports it.',
    action: 'open_url',
    required: ['url'],
    properties: { url: { type: 'string', minLength: 8, maxLength: 2048, description: 'HTTP or HTTPS URL.' } },
    sideEffects: true,
    scanArgs: true,
    summarize: ({ url }) => `Open URL ${url}`,
  }),
  makeCommandTool({
    name: 'android.go_back',
    description: 'Use Android Accessibility Service to navigate back in the current app.',
    action: 'go_back',
    sideEffects: true,
    summarize: () => 'Navigate back on the Android phone',
  }),
  makeCommandTool({
    name: 'android.tap_element',
    description: 'Tap a visible accessible Android UI element by its text or content description.',
    action: 'tap_element',
    required: ['target', 'match_by'],
    properties: {
      target: { type: 'string', minLength: 1, maxLength: 120, description: 'Visible text or content description of the element.' },
      match_by: { type: 'string', enum: ['text', 'content_description'], description: 'Which accessible property should match the target.' },
    },
    sideEffects: true,
    scanArgs: true,
    summarize: ({ target }) => `Tap the accessible Android element "${target}"`,
  }),
  makeCommandTool({
    name: 'android.type_text',
    description: 'Enter ordinary non-sensitive text into an accessible Android text field; never use for passwords, codes, payment data, or sensitive account fields.',
    action: 'type_text',
    required: ['target', 'text'],
    properties: {
      target: { type: 'string', minLength: 1, maxLength: 120, description: 'Accessible label or hint of the ordinary text field.' },
      text: { type: 'string', minLength: 1, maxLength: 500, description: 'Ordinary text to enter; never a password, OTP, payment credential, or other sensitive value.' },
    },
    sideEffects: true,
    scanArgs: true,
    scanFields: ['action', 'target'],
    summarize: ({ target }) => `Enter ordinary text in the Android field "${target}"`,
  }),
  makeCommandTool({
    name: 'android.scroll',
    description: 'Scroll a visible Android screen or accessible scroll container in the requested direction.',
    action: 'scroll',
    required: ['direction'],
    properties: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction.' },
      target: { type: 'string', maxLength: 120, description: 'Optional accessible scroll-container label.' },
    },
    sideEffects: true,
    summarize: ({ direction, target }) => `Scroll ${direction}${target ? ` in "${target}"` : ''} on Android`,
  }),
  makeCommandTool({
    name: 'android.get_visible_state',
    description: 'Read limited visible Android interface labels on request; excludes text-field values and sensitive UI content.',
    action: 'get_visible_state',
    timeoutMs: 15_000,
  }),
].map((tool) => {
  if (tool.name === 'android.get_device_status') return tool;
  tool.parameters.properties.device_id = deviceId;
  return tool;
});

export const ANDROID_TOOLS = [androidGetDeviceStatus, ...androidTools];
