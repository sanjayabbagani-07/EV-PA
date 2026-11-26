# EV 2.0 Agent - Part 1

This backend runtime provides a bounded `Think -> Plan -> Validate -> Permission-check -> Execute -> Observe -> Verify` loop under the `/api/agent` namespace.

## Authentication

Agent routes use a separate owner passphrase and short-lived signed owner session:

- `EV_OWNER_PASSPHRASE`: at least 12 characters.
- `EV_SESSION_SECRET`: at least 32 characters.
- `EV_SESSION_TTL_HOURS`: optional, 1-72 hours; defaults to 12.

`POST /api/agent/login` exchanges the passphrase for a bearer session token. This is separate from `EV_API_TOKEN`, which continues to protect the existing admin and provider-management routes.

## API

- `GET /api/agent/status`
- `GET /api/agent/tools`
- `POST /api/agent/tasks`
- `GET /api/agent/tasks`
- `GET /api/agent/tasks/:id`
- `POST /api/agent/tasks/:id/cancel`
- `POST /api/agent/approvals/:id`
- `GET /api/agent/memory`
- `POST /api/agent/memory/delete`
- `POST /api/agent/devices/pairings` (owner session; one-time, five-minute code)
- `GET /api/agent/devices` and `POST /api/agent/devices/:id/revoke` (owner session)
- `POST /api/agent/device/pair` (one-time code exchange; returns a device credential once)
- `GET|POST /api/agent/device/status`, `POST /api/agent/device/disconnect`, and `GET /api/agent/device/commands/next` (paired Android credential)
- `POST /api/agent/device/commands/:id/result` (paired Android credential; one result per dispatched command)

Every task, approval, and memory operation is owner-scoped. Consequential tools remain paused until the exact approval is approved by the authenticated owner. Approvals are single-use and expire.

Android pairing codes are stored as SHA-256 hashes, expire after five minutes, and are single-use. Device bearer credentials are random 256-bit values; only their SHA-256 hashes are stored server-side. The Android app encrypts its credential with an Android Keystore AES-GCM key. A device is considered connected when its last authenticated status check is no more than 90 seconds old.

The Android tool registry sends allow-listed app discovery, app/URL launch, back navigation, and accessibility actions through a single-use command queue to the paired connected device. Accessibility operations require the service to be manually enabled by the user. Visible-state requests are explicit, bounded, and exclude editable field values. Device-originated results are size/type validated before returning to the tool caller. Launch results verify intent acceptance, not that an application completed loading.

## Built-in tools

Part 1 includes current time, weather, Hacker News, optional Tavily web search, and owner-approved saved memory. Tool arguments are schema-validated, tools have allowlisted implementations and timeouts, and tool output is treated as untrusted data.

The browser adapter reports `not_configured`. Android actions are available only through the authenticated device command channel and the registered `android.*` tools; they are not simulated when no paired device is connected.

## Persistence limitation

Tasks, approvals, memories, pairing codes, device credentials, and pending Android commands use `InMemoryStore`. They are lost whenever the backend process restarts or sleeps; paired Android devices must pair again after a restart. No paid or durable database has been added.

## Provider configuration

The existing `GEMINI_API_KEY` and `GEMINI_MODEL` settings are used server-side. `TAVILY_API_KEY` is optional for web search. Provider keys are not returned by agent status or routes.
