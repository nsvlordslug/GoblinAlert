# Kick Live Detection Design

**Status:** Approved shape, ready for implementation planning
**Date:** 2026-04-20
**Author:** brainstorm between user and Claude

## Goal

Detect when tracked Kick channels go live and post a GoblinAlert announcement in each subscribing guild's channel, with full feature parity to the existing Twitch and YouTube integrations (rich embed, role ping, `/message` custom alerts, multi-platform combining, "Stream ended" state on offline, owner-DM-on-failure).

## Why this is simpler than YouTube

Kick has an actual official public API with proper webhook events. No reverse engineering, no premiere/scheduled-broadcast edge cases, no lease renewal. The only non-trivial piece is the RSA signature verification (different from Twitch's HMAC-SHA256 and YouTube's HMAC-SHA1, but not harder).

## User experience

Admin adds a Kick channel the same way they add Twitch or YouTube:

```
/link name:Wynterlovely platform:kick username:wynterlovely
/add streamer:Wynterlovely platform:kick username:wynterlovely
```

Acceptable inputs for `username`:
- Slug, e.g. `wynterlovely`
- Full URL, e.g. `https://kick.com/wynterlovely` (bot extracts slug)
- Broadcaster user ID (numeric)

Bot resolves to canonical data via `GET /public/v1/channels?slug=X` and stores:
- `streamer_platforms.platform_user_id` ← `broadcaster_user_id` (canonical numeric ID)
- `streamer_platforms.platform_username` ← the canonical slug

When the streamer goes live, the same announcement pipeline fires as for Twitch and YouTube: role ping, rich embed with Kick's green accent bar (`#53FC18`), stream title, category, viewer count, thumbnail, and "Watch on Kick" button with the Kick logo emoji. Multi-platform combining works unchanged. When the stream ends, embed updates to grey "Stream ended" state.

`/message` custom alert text applies unchanged.

## Architecture

### 1. Kick OAuth 2.1 Client Credentials flow

`src/platforms/kickAuth.js` — mirrors the existing `src/platforms/twitchAuth.js` pattern. POSTs to `https://id.kick.com/oauth/token` with `grant_type=client_credentials`, scopes `events:subscribe user:read channel:read`. Caches the access token in memory with its expiry; refreshes on demand when expired. Throws if `KICK_CLIENT_ID` or `KICK_CLIENT_SECRET` are missing.

Exports:
- `isConfigured()` — returns true if both env vars are set.
- `getAppToken()` — returns a valid token, refreshing if needed.

### 2. Kick API wrapper

`src/platforms/kickApi.js` — HTTP wrapper over `https://api.kick.com/public/v1/`.

Exports:
- `resolveChannel(input)` — accepts slug/URL/numeric ID. Normalizes to slug (extracts from URL if needed), calls `GET /public/v1/channels?slug=<slug>`, returns `{ broadcasterUserId, slug, title, category, isLive, viewerCount, thumbnailUrl, startedAt, streamUrl }` or null if not found.
- `getStreamInfo(broadcasterUserId)` — calls `GET /public/v1/channels?broadcaster_user_id=<id>`, returns the same shape. Used by the webhook handler to fetch stream details to pass into `handleStreamOnline`.

Both functions attach the Authorization header with the app token via `kickAuth.getAppToken()`.

### 3. Kick event subscription manager

`src/platforms/kickEvents.js` — lifecycle for `livestream.status.updated` subscriptions.

Exports:
- `isConfigured()` — alias for `kickAuth.isConfigured()`.
- `subscribe(broadcasterUserId)` — `POST /public/v1/events/subscriptions` with body `{ events: [{ name: "livestream.status.updated", version: 1 }], broadcaster_user_id: broadcasterUserId, method: "webhook" }`. Stores the returned subscription ID in `kick_subscriptions` table.
- `unsubscribe(subscriptionId)` — `DELETE /public/v1/events/subscriptions/:id`. Removes from DB.
- `listActiveSubscriptions()` — `GET /public/v1/events/subscriptions` — returns Kick's view of active subs; used on boot to reconcile with DB.
- `healthCheckAndResubscribe()` — reconciles: any row in `kick_subscriptions` not present in Kick's active list gets re-subscribed. Called on boot and every 6 hours (Kick's docs say persistent subs auto-unsubscribe after 24h of failing deliveries, so this handles recovery from extended outages).
- `verifyEventSignature(rawBody, headers)` — RSA-SHA256 verification using Kick's static public key (fetched once, cached). Signed string format: `messageId + "." + timestamp + "." + rawBody` per Kick's docs.
- `parseEventPayload(rawBody)` — returns `{ broadcasterUserId, isLive, eventMessageId }`. `isLive` is the critical field — both online and offline share the same event name.

### 4. Webhook handler at `/webhooks/kick`

`src/web/webhookServer.js` — add POST route only (Kick doesn't use GET verification like PubSubHubbub does).

1. Verify RSA signature via `kickEvents.verifyEventSignature(rawBody, headers)`. If mismatch → 401.
2. Idempotency: use `Kick-Event-Message-Id` as a dedup key (cache last N message IDs in memory; reject duplicates with 200 OK so Kick doesn't retry).
3. Parse payload: `{ broadcasterUserId, isLive }`.
4. If `isLive === true`: fetch stream details via `kickApi.getStreamInfo(broadcasterUserId)`, then call `handleStreamOnline('kick', broadcasterUserId, slug, discordClient, streamDetails)`.
5. If `isLive === false`: call `handleStreamOffline('kick', broadcasterUserId, slug, discordClient)`.
6. Respond 202 Accepted immediately (before the DB/Discord work) so Kick doesn't retry.

### 5. No polling loop

Unlike YouTube, Kick pushes both online AND offline events. No offline polling needed. This saves code and quota.

### 6. No lease renewal

Unlike YouTube's PubSubHubbub 10-day lease, Kick subscriptions are persistent. Only the health-check-and-resubscribe loop runs (every 6h), which is defensive rather than required by the API.

## Data model

### New table `kick_subscriptions`

```sql
CREATE TABLE IF NOT EXISTS kick_subscriptions (
  broadcaster_user_id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

- `broadcaster_user_id` — canonical Kick ID (numeric, stored as text for consistency with other platforms).
- `subscription_id` — the ID Kick returns when we subscribe. Needed to unsubscribe.
- `created_at` — when we subscribed.

One row per distinct Kick channel, shared across all guilds that track that streamer (same pattern as `youtube_subscriptions`).

No change to `streamer_platforms` schema. The existing `platform_user_id` column is already used for all platforms — Kick just stores the broadcaster user ID there.

Migration goes through the existing `runMigrations()` in `db/database.js`.

## External setup (one-time, by user)

1. Go to [kick.com](https://kick.com) → Account Settings → **Developer** tab → create an app.
2. Copy the **Client ID** and **Client Secret**.
3. Under the app's webhook settings, register `https://goblinalert.com/webhooks/kick` as the webhook URL.
4. Add to `.env` (both local and `/root/goblinalert/.env` on Hetzner):

   ```
   KICK_CLIENT_ID=<from step 2>
   KICK_CLIENT_SECRET=<from step 2>
   ```

   The existing `KICK_WEBHOOK_SECRET` env var placeholder can be removed or left empty — Kick uses RSA public key verification, not shared secrets.
5. Cloudflare Tunnel already routes `goblinalert.com` → port 3500; no tunnel config change needed.

## Implementation components

| File | Change | Purpose |
|---|---|---|
| `src/platforms/kickAuth.js` | New | OAuth client credentials, token caching. |
| `src/platforms/kickApi.js` | New | `resolveChannel`, `getStreamInfo`. |
| `src/platforms/kickEvents.js` | New | Subscription lifecycle, signature verification, payload parsing, public key caching. |
| `src/web/webhookServer.js` | Modify | Add `POST /webhooks/kick`. |
| `src/services/liveTracker.js` | Modify | Minor — add `platform === 'kick'` branch to the platform dispatch added during YouTube work. |
| `src/db/database.js` | Modify | New `kick_subscriptions` table migration; helpers (`getKickSubscription`, `upsertKickSubscription`, `removeKickSubscription`, `listKickSubscriptions`, `countStreamersByKickChannel`). |
| `src/commands/add.js`, `link.js` | Modify | Add Kick to addChoices. Add YouTube-style prepare helper: resolve slug → broadcaster_user_id → ensure subscription exists. |
| `src/commands/unlink.js`, `remove.js` | Modify | Add Kick to addChoices. On last unlink, unsubscribe from Kick events. |
| `src/commands/upgrade.js` | Modify | Update Free/Plus tier descriptions to include Kick ("Twitch + YouTube + Kick"). |
| `src/index.js` | Modify | On boot, call `kickEvents.healthCheckAndResubscribe()` if Kick is configured. Also start the 6h health check timer. |

## Scope boundaries

### In scope
- Live detection via Kick's official webhook API.
- Offline detection via same event (is_live=false payload).
- Multi-platform combining (no additional work — already platform-agnostic).
- Custom alert messages via `/message` (already platform-agnostic).
- Channel identifier resolution for `/add` and `/link` — slug, URL, or numeric ID.
- Subscription lifecycle — subscribe on first `/link`, unsubscribe on last `/unlink`.
- Persistent subscription health check every 6h with auto-resubscribe on missing subs.
- Graceful degradation when `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` missing — log warning, no crashes, existing platforms keep working.
- Re-enable Kick in `/add`, `/link`, `/unlink` dropdowns (currently hidden per earlier change). Update `/upgrade` to mention Kick in Free/Plus tier lists.

### Out of scope
- Kick chat / subscription events (`chat.message.sent` etc.) — not needed for live alerts.
- Kick polling as a fallback — not needed; persistent webhooks suffice. If Kick's API becomes unreliable, revisit.
- App Verification (the optional TikTok-style badge). Free tier has plenty of subscription slots for our scale.
- Updating existing (inert) Kick rows in the DB — prod has zero Kick rows currently, clean slate.
- Kick's subscriber count / follower count in the embed. Matches Twitch/YouTube behavior (we display viewer_count only when live).

## Edge cases and failure modes

- **Missing `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` on boot.** Kick modules don't start. `/link platform:kick` returns an ephemeral error: "Kick integration isn't configured. Please contact the bot operator." Twitch and YouTube keep working.
- **OAuth token refresh fails** (Kick auth endpoint down, revoked client). Functions that need the token throw; command returns error to user. Next call retries.
- **Subscription limit exceeded** (10,000 per event type per app). Realistically a non-issue at our scale, but on 400/429 we log warn and return error to `/link`.
- **Webhook signature mismatch.** 401 response. Logged at warn level.
- **Duplicate webhook delivery.** Use `Kick-Event-Message-Id` header as dedup key; keep recent 1000 IDs in an in-memory LRU cache. Duplicates return 200 OK without re-processing.
- **Kick API returns 410 Gone for a subscription** (sub was auto-unsubscribed). Delete local row; next health check creates a fresh sub.
- **Channel renamed / slug changed.** Stored `broadcaster_user_id` is stable, so subscription keeps working; only `/list` display name is stale until admin re-links.
- **Kick API down.** `/link` returns transient error to user; existing subscriptions keep receiving events (the subscription is server-side state on Kick's end, independent of our ability to list/manage).

## Migration story

- **Prod DB (as of 2026-04-20):** zero Kick rows in `streamer_platforms`. Clean slate.
- The migration is purely additive (`CREATE TABLE IF NOT EXISTS kick_subscriptions`) and safe to run on a live DB.
- Re-enabling `Kick` in the three command `addChoices` arrays requires `npm run deploy-commands` to update Discord's cached schemas.

## Estimated size

~350 lines of new code across the three new files and modifications listed. Smaller than YouTube because no Atom parsing, no lease renewal, no offline polling. The novel piece is RSA-SHA256 signature verification (~30 lines), which is a well-documented standard pattern.
