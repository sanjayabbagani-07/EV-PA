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
- `GET /api/agent/device/status` and `POST /api/agent/device/disconnect` (paired Android credential)

Every task, approval, and memory operation is owner-scoped. Consequential tools remain paused until the exact approval is approved by the authenticated owner. Approvals are single-use and expire.

Android pairing codes are stored as SHA-256 hashes, expire after five minutes, and are single-use. Device bearer credentials are random 256-bit values; only their SHA-256 hashes are stored server-side. The Android app encrypts its credential with an Android Keystore AES-GCM key. A device is considered connected when its last authenticated status check is no more than 90 seconds old. No remote commands are available in this phase.

## Built-in tools

Part 1 includes current time, weather, Hacker News, optional Tavily web search, and owner-approved saved memory. Tool arguments are schema-validated, tools have allowlisted implementations and timeouts, and tool output is treated as untrusted data.

Browser and Android adapters report `not_configured`. They do not pretend to execute device actions.

## Persistence limitation

Tasks, approvals, memories, pairing codes, and device credentials use `InMemoryStore`. They are lost whenever the backend process restarts or sleeps; paired Android devices must pair again after a restart. No paid or durable database has been added.

## Provider configuration

The existing `GEMINI_API_KEY` and `GEMINI_MODEL` settings are used server-side. `TAVILY_API_KEY` is optional for web search. Provider keys are not returned by agent status or routes.
