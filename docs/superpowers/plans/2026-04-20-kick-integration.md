# Kick Live Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when tracked Kick channels go live and post a GoblinAlert announcement in each subscribing guild, matching the UX of the existing Twitch and YouTube integrations.

**Architecture:** OAuth 2.1 Client Credentials flow → subscribe per-channel via Kick's `/public/v1/events/subscriptions` → receive webhooks at `/webhooks/kick` → RSA-SHA256 signature verification → single event `livestream.status.updated` routes to `handleStreamOnline` or `handleStreamOffline` based on `is_live` payload. Persistent subscriptions (no lease renewal) with a 6h health-check loop for defensive re-sync.

**Tech Stack:** Node.js 22, axios (existing HTTP client), Node crypto (RSA signature verification), Express (existing webhook server), better-sqlite3, discord.js. No new npm dependencies.

**Reference:** [docs/superpowers/specs/2026-04-20-kick-integration-design.md](../specs/2026-04-20-kick-integration-design.md)

**Verification approach:** No test suite exists in this repo. Each task verifies with syntax checks (`node --check`) and isolated module loads (`node -e`). End-to-end verification happens after Task 11's deploy (no way to exercise Kick OAuth or webhook subscription locally without pre-registered webhook URL and valid credentials).

---

## File Structure

**Created:**
- `src/platforms/kickAuth.js` — OAuth 2.1 Client Credentials flow with in-memory token caching.
- `src/platforms/kickApi.js` — Wrapper over `https://api.kick.com/public/v1/`. Channel resolution (slug/URL/ID → canonical), `getStreamInfo` for live details.
- `src/platforms/kickEvents.js` — Event subscription lifecycle (subscribe/unsubscribe/list/health-check), RSA-SHA256 signature verification, Atom-free payload parsing, in-memory message-ID dedup.

**Modified:**
- `src/db/database.js` — New `kick_subscriptions` table migration + helpers.
- `src/web/webhookServer.js` — Add `POST /webhooks/kick`.
- `src/services/liveTracker.js` — Add Kick fallback path to the platform dispatch for stream info.
- `src/commands/add.js`, `src/commands/link.js` — Re-add Kick to `addChoices`. Resolve Kick slug on input, ensure subscription exists.
- `src/commands/unlink.js`, `src/commands/remove.js` — Re-add Kick to `addChoices`. On last unlink, unsubscribe from Kick events.
- `src/commands/upgrade.js` — Restore "Twitch + YouTube + Kick" in Free and Plus tier descriptions.
- `src/index.js` — On boot, run initial Kick health check and start a 6h `setInterval`. Guarded by `kickEvents.isConfigured()`.

---

## Task 1: DB migration and helpers for kick_subscriptions

**Files:**
- Modify: `src/db/database.js`

- [ ] **Step 1: Add migration to `runMigrations()`**

In `src/db/database.js`, at the end of the existing `runMigrations` function (which currently has the `custom_message`, `current_video_id`, and `youtube_subscriptions` migrations), append:

```javascript
  const kickTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kick_subscriptions'").all();
  if (kickTables.length === 0) {
    db.exec(`
      CREATE TABLE kick_subscriptions (
        broadcaster_user_id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    logger.info('Migration: created kick_subscriptions table');
  }
```

- [ ] **Step 2: Add Kick subscription helpers**

In `src/db/database.js`, after the last YouTube helper (`listLiveYoutubeStreamerPlatforms`), add:

```javascript
function getKickSubscription(broadcasterUserId) {
  return getDb().prepare('SELECT * FROM kick_subscriptions WHERE broadcaster_user_id = ?').get(broadcasterUserId);
}

function upsertKickSubscription(broadcasterUserId, subscriptionId) {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO kick_subscriptions (broadcaster_user_id, subscription_id, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(broadcaster_user_id) DO UPDATE SET
      subscription_id = excluded.subscription_id,
      created_at = excluded.created_at
  `).run(broadcasterUserId, subscriptionId, now);
}

function removeKickSubscription(broadcasterUserId) {
  getDb().prepare('DELETE FROM kick_subscriptions WHERE broadcaster_user_id = ?').run(broadcasterUserId);
}

function listKickSubscriptions() {
  return getDb().prepare('SELECT * FROM kick_subscriptions').all();
}

function countStreamersByKickChannel(broadcasterUserId) {
  return getDb().prepare(`
    SELECT COUNT(*) as n FROM streamer_platforms
    WHERE platform = 'kick' AND platform_user_id = ?
  `).get(broadcasterUserId).n;
}
```

- [ ] **Step 3: Export the new helpers**

In `src/db/database.js`, update the `module.exports` block to include the five new helpers. The updated block:

```javascript
module.exports = {
  getDb,
  ensureGuild,
  getGuild,
  setAnnouncementChannel,
  updateGuildConfig,
  removeGuild,
  addStreamer,
  removeStreamer,
  linkPlatform,
  unlinkPlatform,
  setCustomMessage,
  clearCustomMessage,
  getStreamers,
  getStreamerCount,
  getTikTokCount,
  getActiveEntitlement,
  upsertEntitlement,
  getYoutubeSubscription,
  upsertYoutubeSubscription,
  markYoutubeSubscriptionVerified,
  removeYoutubeSubscription,
  listExpiringYoutubeSubscriptions,
  countStreamersByYoutubeChannel,
  setCurrentVideoId,
  clearCurrentVideoId,
  listLiveYoutubeStreamerPlatforms,
  getKickSubscription,
  upsertKickSubscription,
  removeKickSubscription,
  listKickSubscriptions,
  countStreamersByKickChannel
};
```

- [ ] **Step 4: Verify syntax and migration**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/db/database.js && echo "SYNTAX OK"
node -e "const d = require('./src/db/database'); d.getDb(); const tables = require('better-sqlite3')('goblinalert.db').prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all(); console.log('tables:', tables.map(t => t.name).join(','));"
```

Expected:
- `SYNTAX OK`
- First run: `Migration: created kick_subscriptions table` log line
- `tables:` output includes `kick_subscriptions`

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
git add src/db/database.js
git commit -m "feat: add kick_subscriptions table and helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Kick OAuth 2.1 Client Credentials wrapper

**Files:**
- Create: `src/platforms/kickAuth.js`

- [ ] **Step 1: Create kickAuth.js**

Create `src/platforms/kickAuth.js` with:

```javascript
const axios = require('axios');
const logger = require('../utils/logger');

const TOKEN_URL = 'https://id.kick.com/oauth/token';
const SCOPES = 'events:subscribe user:read channel:read';

let cachedToken = null;
let cachedExpiresAt = 0;

function isConfigured() {
  return Boolean(process.env.KICK_CLIENT_ID && process.env.KICK_CLIENT_SECRET);
}

/**
 * Get a valid app access token using the Client Credentials flow.
 * Caches the token in memory until 60s before expiry.
 */
async function getAppToken() {
  if (!isConfigured()) {
    throw new Error('KICK_CLIENT_ID and/or KICK_CLIENT_SECRET are not set');
  }

  const now = Date.now();
  if (cachedToken && now < cachedExpiresAt - 60 * 1000) {
    return cachedToken;
  }

  const form = new URLSearchParams();
  form.append('grant_type', 'client_credentials');
  form.append('client_id', process.env.KICK_CLIENT_ID);
  form.append('client_secret', process.env.KICK_CLIENT_SECRET);
  form.append('scope', SCOPES);

  const response = await axios.post(TOKEN_URL, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000
  });

  const { access_token, expires_in } = response.data;
  cachedToken = access_token;
  cachedExpiresAt = now + (expires_in * 1000);
  logger.info(`Kick OAuth token refreshed, expires in ${expires_in}s`);
  return cachedToken;
}

module.exports = { isConfigured, getAppToken };
```

- [ ] **Step 2: Verify syntax and graceful no-op without credentials**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/platforms/kickAuth.js && echo "SYNTAX OK"
node -e "process.env.KICK_CLIENT_ID=''; process.env.KICK_CLIENT_SECRET=''; const a = require('./src/platforms/kickAuth'); console.log('isConfigured:', a.isConfigured()); a.getAppToken().catch(e => console.log('expected throw:', e.message));"
```

Expected:
- `SYNTAX OK`
- `isConfigured: false`
- `expected throw: KICK_CLIENT_ID and/or KICK_CLIENT_SECRET are not set`

- [ ] **Step 3: Commit**

```bash
git add src/platforms/kickAuth.js
git commit -m "feat: add Kick OAuth 2.1 Client Credentials wrapper with token caching

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Kick API wrapper (channel resolution + stream info)

**Files:**
- Create: `src/platforms/kickApi.js`

- [ ] **Step 1: Create kickApi.js**

Create `src/platforms/kickApi.js` with:

```javascript
const axios = require('axios');
const logger = require('../utils/logger');
const kickAuth = require('./kickAuth');

const API_BASE = 'https://api.kick.com/public/v1';

function isConfigured() {
  return kickAuth.isConfigured();
}

async function kickGet(path, params) {
  const token = await kickAuth.getAppToken();
  const response = await axios.get(`${API_BASE}${path}`, {
    params,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000
  });
  return response.data;
}

function normalizeInput(input) {
  if (!input) return { slug: null, broadcasterUserId: null };
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/kick\.com\/([^/?#\s]+)/i);
  if (urlMatch) return { slug: urlMatch[1], broadcasterUserId: null };
  if (/^\d+$/.test(trimmed)) return { slug: null, broadcasterUserId: trimmed };
  return { slug: trimmed.replace(/^@/, ''), broadcasterUserId: null };
}

function shapeChannel(item) {
  if (!item) return null;
  return {
    broadcasterUserId: String(item.broadcaster_user_id),
    slug: item.slug,
    title: item.stream_title || null,
    category: item.category?.name || null,
    isLive: Boolean(item.stream?.is_live),
    viewerCount: item.stream?.viewer_count || 0,
    thumbnailUrl: item.stream?.thumbnail || null,
    startedAt: item.stream?.start_time || null,
    streamUrl: item.stream?.url || `https://kick.com/${item.slug}`
  };
}

/**
 * Resolve any Kick channel identifier (slug, URL, or broadcaster user ID) to a canonical channel record.
 * Returns the shape above or null if not found.
 */
async function resolveChannel(input) {
  const { slug, broadcasterUserId } = normalizeInput(input);
  if (!slug && !broadcasterUserId) return null;

  try {
    const params = slug ? { slug } : { broadcaster_user_id: broadcasterUserId };
    const data = await kickGet('/channels', params);
    const item = data?.data?.[0];
    return shapeChannel(item);
  } catch (err) {
    logger.error(`Kick channel resolution failed for "${input}":`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Fetch stream info for a known broadcaster user ID. Used by the webhook handler.
 */
async function getStreamInfo(broadcasterUserId) {
  try {
    const data = await kickGet('/channels', { broadcaster_user_id: String(broadcasterUserId) });
    const item = data?.data?.[0];
    return shapeChannel(item);
  } catch (err) {
    logger.error(`Kick stream info lookup failed for broadcasterUserId "${broadcasterUserId}":`, err.response?.data || err.message);
    return null;
  }
}

module.exports = { isConfigured, resolveChannel, getStreamInfo };
```

- [ ] **Step 2: Verify syntax and input normalization**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/platforms/kickApi.js && echo "SYNTAX OK"
node -e "process.env.KICK_CLIENT_ID=''; process.env.KICK_CLIENT_SECRET=''; const a = require('./src/platforms/kickApi'); a.resolveChannel('someuser').then(r => console.log('expect null (no creds):', r));"
```

Expected:
- `SYNTAX OK`
- `expect null (no creds): null` (error logged, function returns null gracefully)

- [ ] **Step 3: Commit**

```bash
git add src/platforms/kickApi.js
git commit -m "feat: add Kick Data API wrapper with channel resolution

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Kick events manager (subscribe, unsubscribe, signature verify)

**Files:**
- Create: `src/platforms/kickEvents.js`

- [ ] **Step 1: Create kickEvents.js**

Create `src/platforms/kickEvents.js` with:

```javascript
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const kickAuth = require('./kickAuth');
const {
  getKickSubscription,
  upsertKickSubscription,
  removeKickSubscription,
  listKickSubscriptions
} = require('../db/database');

const API_BASE = 'https://api.kick.com/public/v1';
const EVENT_NAME = 'livestream.status.updated';
const EVENT_VERSION = 1;

let cachedPublicKey = null;

const recentMessageIds = new Map();
const MAX_MESSAGE_IDS = 1000;
const MESSAGE_TTL_MS = 10 * 60 * 1000;

function isConfigured() {
  return kickAuth.isConfigured();
}

async function kickAuthedRequest(method, path, body) {
  const token = await kickAuth.getAppToken();
  return axios({
    method,
    url: `${API_BASE}${path}`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: body,
    timeout: 10000
  });
}

/**
 * Subscribe to livestream.status.updated for a specific broadcaster.
 * Persists the returned subscription ID so we can unsubscribe later.
 */
async function subscribe(broadcasterUserId) {
  if (!isConfigured()) throw new Error('Kick OAuth credentials are not set');

  const body = {
    events: [{ name: EVENT_NAME, version: EVENT_VERSION }],
    broadcaster_user_id: Number(broadcasterUserId),
    method: 'webhook'
  };

  const response = await kickAuthedRequest('POST', '/events/subscriptions', body);
  const data = response.data?.data?.[0] || response.data;
  const subscriptionId = data?.subscription_id || data?.id;
  if (!subscriptionId) {
    throw new Error(`Kick subscribe returned no subscription_id: ${JSON.stringify(response.data)}`);
  }
  upsertKickSubscription(String(broadcasterUserId), subscriptionId);
  logger.info(`Kick subscribed to livestream.status.updated for broadcaster ${broadcasterUserId} (sub ${subscriptionId})`);
  return subscriptionId;
}

async function unsubscribe(broadcasterUserId) {
  if (!isConfigured()) throw new Error('Kick OAuth credentials are not set');
  const sub = getKickSubscription(String(broadcasterUserId));
  if (!sub) {
    logger.warn(`Kick unsubscribe: no local row for broadcaster ${broadcasterUserId}`);
    return;
  }

  try {
    await kickAuthedRequest('DELETE', `/events/subscriptions/${encodeURIComponent(sub.subscription_id)}`);
    logger.info(`Kick unsubscribed from broadcaster ${broadcasterUserId} (sub ${sub.subscription_id})`);
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 410) {
      logger.info(`Kick subscription ${sub.subscription_id} already gone (${status}); cleaning local row`);
    } else {
      logger.warn(`Kick unsubscribe failed for ${broadcasterUserId}: ${err.message} - deleting local row anyway`);
    }
  }
  removeKickSubscription(String(broadcasterUserId));
}

/**
 * Reconcile local kick_subscriptions rows against Kick's view of active subs.
 * Any local row missing from Kick's list gets re-subscribed. Called on boot and every 6h.
 */
async function healthCheckAndResubscribe() {
  if (!isConfigured()) return;

  const localRows = listKickSubscriptions();
  if (localRows.length === 0) return;

  let kickSubs = [];
  try {
    const response = await kickAuthedRequest('GET', '/events/subscriptions');
    kickSubs = response.data?.data || [];
  } catch (err) {
    logger.warn(`Kick health check: failed to list subscriptions - ${err.message}. Skipping this tick.`);
    return;
  }

  const liveSubIds = new Set(kickSubs.map(s => s.id || s.subscription_id).filter(Boolean));
  let resubscribed = 0;

  for (const row of localRows) {
    if (!liveSubIds.has(row.subscription_id)) {
      try {
        await subscribe(row.broadcaster_user_id);
        resubscribed++;
      } catch (err) {
        logger.error(`Kick health check: failed to resubscribe broadcaster ${row.broadcaster_user_id}: ${err.message}`);
      }
    }
  }

  if (resubscribed > 0) {
    logger.info(`Kick health check: re-subscribed ${resubscribed} broadcaster(s)`);
  }
}

/**
 * Lazy-fetch Kick's RSA public key and cache it. Key is static; fetched once per process.
 */
async function getPublicKey() {
  if (cachedPublicKey) return cachedPublicKey;
  try {
    const response = await kickAuthedRequest('GET', '/public-key');
    const pem = response.data?.data?.public_key || response.data?.public_key;
    if (!pem) {
      throw new Error(`Kick public-key endpoint returned unexpected shape: ${JSON.stringify(response.data)}`);
    }
    cachedPublicKey = pem;
    return cachedPublicKey;
  } catch (err) {
    logger.error(`Kick public-key fetch failed: ${err.message}`);
    throw err;
  }
}

/**
 * Verify an incoming webhook's RSA-SHA256 signature.
 * Signed string format per Kick docs: `messageId + "." + timestamp + "." + rawBody`.
 */
async function verifyEventSignature(rawBody, headers) {
  const signatureHeader = headers['kick-event-signature'];
  const messageId = headers['kick-event-message-id'];
  const timestamp = headers['kick-event-message-timestamp'];
  if (!signatureHeader || !messageId || !timestamp) return false;

  try {
    const publicKey = await getPublicKey();
    const bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
    const signedString = `${messageId}.${timestamp}.${bodyString}`;

    const verifier = crypto.createVerify('SHA256');
    verifier.update(signedString);
    verifier.end();

    const signatureBuffer = Buffer.from(signatureHeader, 'base64');
    return verifier.verify(publicKey, signatureBuffer);
  } catch (err) {
    logger.error(`Kick signature verification error: ${err.message}`);
    return false;
  }
}

/**
 * Extract the broadcaster user ID and is_live boolean from a webhook payload.
 * Handles both flat (`broadcaster_user_id`, `is_live`) and nested (`broadcaster.user_id`, `livestream.is_live`) shapes.
 */
function parseEventPayload(rawBody) {
  const payload = typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString('utf8'));
  const broadcasterUserId =
    payload.broadcaster_user_id ||
    payload.broadcaster?.broadcaster_user_id ||
    payload.broadcaster?.user_id;
  const isLive = typeof payload.is_live === 'boolean'
    ? payload.is_live
    : typeof payload.livestream?.is_live === 'boolean'
      ? payload.livestream.is_live
      : null;
  return {
    broadcasterUserId: broadcasterUserId ? String(broadcasterUserId) : null,
    isLive,
    payload
  };
}

function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  if (!recentMessageIds.has(messageId)) return false;
  return true;
}

function recordMessage(messageId) {
  if (!messageId) return;
  const now = Date.now();
  if (recentMessageIds.size >= MAX_MESSAGE_IDS) {
    const firstKey = recentMessageIds.keys().next().value;
    if (firstKey !== undefined) recentMessageIds.delete(firstKey);
  }
  recentMessageIds.set(messageId, now);
  if (Math.random() < 0.01) {
    for (const [id, ts] of recentMessageIds) {
      if (now - ts > MESSAGE_TTL_MS) recentMessageIds.delete(id);
    }
  }
}

module.exports = {
  isConfigured,
  subscribe,
  unsubscribe,
  healthCheckAndResubscribe,
  verifyEventSignature,
  parseEventPayload,
  isDuplicateMessage,
  recordMessage,
  EVENT_NAME,
  EVENT_VERSION
};
```

- [ ] **Step 2: Verify syntax and payload parser**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/platforms/kickEvents.js && echo "SYNTAX OK"
node -e "const e = require('./src/platforms/kickEvents'); const flat = JSON.stringify({broadcaster_user_id:12345, is_live:true}); console.log('flat:', e.parseEventPayload(flat)); const nested = JSON.stringify({broadcaster:{user_id:67890}, livestream:{is_live:false}}); console.log('nested:', e.parseEventPayload(nested));"
node -e "const e = require('./src/platforms/kickEvents'); console.log('first dup check:', e.isDuplicateMessage('msg1')); e.recordMessage('msg1'); console.log('second dup check:', e.isDuplicateMessage('msg1')); console.log('other id dup check:', e.isDuplicateMessage('msg2'));"
```

Expected:
- `SYNTAX OK`
- `flat: { broadcasterUserId: '12345', isLive: true, payload: {...} }`
- `nested: { broadcasterUserId: '67890', isLive: false, payload: {...} }`
- `first dup check: false`
- `second dup check: true`
- `other id dup check: false`

- [ ] **Step 3: Commit**

```bash
git add src/platforms/kickEvents.js
git commit -m "feat: add Kick event subscription manager with RSA signature verification

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Webhook route for /webhooks/kick

**Files:**
- Modify: `src/web/webhookServer.js`

- [ ] **Step 1: Add requires at the top of webhookServer.js**

In `src/web/webhookServer.js`, after the existing YouTube-related requires at the top, add:

```javascript
const kickEvents = require('../platforms/kickEvents');
const kickApi = require('../platforms/kickApi');
```

- [ ] **Step 2: Add POST /webhooks/kick route**

In `src/web/webhookServer.js`, after the YouTube POST route and before `return app;`, add:

```javascript
  // POST /webhooks/kick — Kick event notification
  app.post('/webhooks/kick',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res) => {
      const rawBody = req.body;
      const headers = req.headers;

      const isValid = await kickEvents.verifyEventSignature(rawBody, headers);
      if (!isValid) {
        logger.warn('Kick webhook signature verification failed');
        return res.status(401).send('bad signature');
      }

      const messageId = headers['kick-event-message-id'];
      if (kickEvents.isDuplicateMessage(messageId)) {
        logger.debug(`Kick duplicate message ${messageId}, acking without processing`);
        return res.status(200).send('duplicate');
      }
      kickEvents.recordMessage(messageId);

      res.status(202).send('accepted');

      try {
        const { broadcasterUserId, isLive, payload } = kickEvents.parseEventPayload(rawBody);
        if (!broadcasterUserId || typeof isLive !== 'boolean') {
          logger.warn(`Kick event payload missing required fields: ${JSON.stringify(payload)}`);
          return;
        }

        if (isLive) {
          const info = await kickApi.getStreamInfo(broadcasterUserId);
          if (!info) {
            logger.warn(`Kick event: could not fetch stream info for broadcaster ${broadcasterUserId}`);
            return;
          }
          const streamDetails = {
            title: info.title,
            thumbnailUrl: info.thumbnailUrl,
            viewerCount: info.viewerCount,
            startedAt: info.startedAt,
            game: info.category
          };
          await handleStreamOnline('kick', broadcasterUserId, info.slug, discordClient, streamDetails);
        } else {
          const { getDb } = require('../db/database');
          const row = getDb().prepare("SELECT platform_username FROM streamer_platforms WHERE platform = 'kick' AND platform_user_id = ? LIMIT 1").get(broadcasterUserId);
          const slug = row?.platform_username || '';
          await handleStreamOffline('kick', broadcasterUserId, slug, discordClient);
        }
      } catch (err) {
        logger.error('Kick webhook processing error:', err);
      }
    }
  );
```

- [ ] **Step 3: Verify syntax**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/web/webhookServer.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 4: Commit**

```bash
git add src/web/webhookServer.js
git commit -m "feat: add /webhooks/kick route with RSA signature verification and dedup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: liveTracker platform dispatch fallback for Kick

**Files:**
- Modify: `src/services/liveTracker.js`

**Rationale:** The Kick webhook always pre-fetches stream info and passes it via `preFetchedStreamDetails`, so the fallback path in `handleStreamOnline` should rarely fire for Kick. But for consistency and defensiveness (e.g., test calls, reruns), add a Kick branch.

- [ ] **Step 1: Add Kick fallback to stream-info dispatch**

In `src/services/liveTracker.js`, find the block inside `handleStreamOnline` that dispatches `getStreamInfo` by platform. It currently reads:

```javascript
      let streamDetails = preFetchedStreamDetails;
      if (!streamDetails) {
        if (platform === 'twitch') {
          streamDetails = await getStreamInfo(platformUserId);
        } else if (platform === 'youtube') {
          logger.warn(`YouTube handleStreamOnline called without preFetchedStreamDetails for channel ${platformUserId}; no fallback lookup available`);
        }
      }
```

Replace with:

```javascript
      let streamDetails = preFetchedStreamDetails;
      if (!streamDetails) {
        if (platform === 'twitch') {
          streamDetails = await getStreamInfo(platformUserId);
        } else if (platform === 'youtube') {
          logger.warn(`YouTube handleStreamOnline called without preFetchedStreamDetails for channel ${platformUserId}; no fallback lookup available`);
        } else if (platform === 'kick') {
          const { getStreamInfo: getKickStreamInfo } = require('../platforms/kickApi');
          const info = await getKickStreamInfo(platformUserId);
          if (info) {
            streamDetails = {
              title: info.title,
              thumbnailUrl: info.thumbnailUrl,
              viewerCount: info.viewerCount,
              startedAt: info.startedAt,
              game: info.category
            };
          }
        }
      }
```

- [ ] **Step 2: Verify syntax**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/services/liveTracker.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 3: Commit**

```bash
git add src/services/liveTracker.js
git commit -m "feat: liveTracker falls back to kickApi.getStreamInfo when no pre-fetched details

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Re-enable Kick in /add and /link, wire subscribe-on-link

**Files:**
- Modify: `src/commands/add.js`
- Modify: `src/commands/link.js`

- [ ] **Step 1: Update link.js requires and add prepareKickPlatform helper**

In `src/commands/link.js`, update the top of the file. After the existing requires (YouTube helpers etc.), add:

```javascript
const kickApi = require('../platforms/kickApi');
const kickEvents = require('../platforms/kickEvents');
const { getKickSubscription } = require('../db/database');

async function prepareKickPlatform(userInput) {
  if (!kickEvents.isConfigured()) {
    throw new Error('Kick integration isn\'t configured on this bot. Please contact the bot operator.');
  }
  const resolved = await kickApi.resolveChannel(userInput);
  if (!resolved) {
    throw new Error(`Could not find Kick channel "${userInput}". Check the username, URL, or broadcaster ID and try again.`);
  }
  const existing = getKickSubscription(resolved.broadcasterUserId);
  if (!existing) {
    await kickEvents.subscribe(resolved.broadcasterUserId);
  }
  return {
    resolvedUsername: resolved.slug,
    resolvedUserId: resolved.broadcasterUserId
  };
}
```

- [ ] **Step 2: Re-add Kick to link.js addChoices**

In `src/commands/link.js`, find the `.addChoices` block on the platform option. Change:

```javascript
        .addChoices(
          { name: 'Twitch', value: 'twitch' },
          { name: 'YouTube', value: 'youtube' }
        )
```

To:

```javascript
        .addChoices(
          { name: 'Twitch', value: 'twitch' },
          { name: 'YouTube', value: 'youtube' },
          { name: 'Kick', value: 'kick' }
        )
```

- [ ] **Step 3: Add Kick handling to link.js execute function**

In `src/commands/link.js`, find the block that handles YouTube preparation before the DB write. It currently reads (roughly):

```javascript
    let finalUsername = username;
    let finalUserId = null;
    if (platform === 'youtube') {
      try {
        const prepared = await prepareYouTubePlatform(username);
        finalUsername = prepared.resolvedUsername;
        finalUserId = prepared.resolvedUserId;
      } catch (err) {
        await interaction.reply({ content: `:x: ${err.message}`, ephemeral: true });
        return;
      }
    }
```

Extend the `if` chain to also handle Kick:

```javascript
    let finalUsername = username;
    let finalUserId = null;
    if (platform === 'youtube') {
      try {
        const prepared = await prepareYouTubePlatform(username);
        finalUsername = prepared.resolvedUsername;
        finalUserId = prepared.resolvedUserId;
      } catch (err) {
        await interaction.reply({ content: `:x: ${err.message}`, ephemeral: true });
        return;
      }
    } else if (platform === 'kick') {
      try {
        const prepared = await prepareKickPlatform(username);
        finalUsername = prepared.resolvedUsername;
        finalUserId = prepared.resolvedUserId;
      } catch (err) {
        await interaction.reply({ content: `:x: ${err.message}`, ephemeral: true });
        return;
      }
    }
```

Now find the block that backfills `platform_user_id` for YouTube after the `linkPlatform` insert. It currently reads:

```javascript
      if (platform === 'youtube' && finalUserId) {
        getDb().prepare(`
          UPDATE streamer_platforms SET platform_user_id = ?
          WHERE streamer_id = (SELECT id FROM streamers WHERE guild_id = ? AND display_name = ? COLLATE NOCASE)
            AND platform = ?
        `).run(finalUserId, interaction.guildId, name, platform);
      }
```

Generalize to cover Kick too:

```javascript
      if ((platform === 'youtube' || platform === 'kick') && finalUserId) {
        getDb().prepare(`
          UPDATE streamer_platforms SET platform_user_id = ?
          WHERE streamer_id = (SELECT id FROM streamers WHERE guild_id = ? AND display_name = ? COLLATE NOCASE)
            AND platform = ?
        `).run(finalUserId, interaction.guildId, name, platform);
      }
```

- [ ] **Step 4: Apply the same three changes to add.js**

In `src/commands/add.js`:
1. Add the same requires + `prepareKickPlatform` helper at the top (see Step 1).
2. Re-add Kick to the `addChoices` block (see Step 2).
3. Extend the `if (platform === 'youtube')` block to also handle Kick, and generalize the `platform_user_id` backfill (see Step 3). Note that in `add.js` the variable name is `displayName` instead of `name`.

For the `add.js` platform preparation block, the equivalent becomes:

```javascript
    let finalUsername = username;
    let finalUserId = null;
    if (platform === 'youtube') {
      try {
        const prepared = await prepareYouTubePlatform(username);
        finalUsername = prepared.resolvedUsername;
        finalUserId = prepared.resolvedUserId;
      } catch (err) {
        await interaction.reply({ content: `:x: ${err.message}`, ephemeral: true });
        return;
      }
    } else if (platform === 'kick') {
      try {
        const prepared = await prepareKickPlatform(username);
        finalUsername = prepared.resolvedUsername;
        finalUserId = prepared.resolvedUserId;
      } catch (err) {
        await interaction.reply({ content: `:x: ${err.message}`, ephemeral: true });
        return;
      }
    }
```

For the backfill block in `add.js` (which currently has the YouTube-specific `if (platform === 'youtube' && finalUserId)` backfill):

```javascript
      if ((platform === 'youtube' || platform === 'kick') && finalUserId) {
        getDb().prepare(`
          UPDATE streamer_platforms SET platform_user_id = ?
          WHERE streamer_id = (SELECT id FROM streamers WHERE guild_id = ? AND display_name = ? COLLATE NOCASE)
            AND platform = ?
        `).run(finalUserId, interaction.guildId, displayName, platform);
      }
```

- [ ] **Step 5: Verify syntax**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/commands/link.js && node --check src/commands/add.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 6: Commit**

```bash
git add src/commands/link.js src/commands/add.js
git commit -m "feat: /link and /add resolve Kick channels and ensure subscription

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Re-enable Kick in /unlink and /remove, unsubscribe on orphan

**Files:**
- Modify: `src/commands/unlink.js`
- Modify: `src/commands/remove.js`

- [ ] **Step 1: Add Kick requires to unlink.js**

In `src/commands/unlink.js`, add after the existing `youtubePubSub` require:

```javascript
const kickEvents = require('../platforms/kickEvents');
const { countStreamersByKickChannel } = require('../db/database');
```

- [ ] **Step 2: Re-add Kick to unlink.js addChoices**

In `src/commands/unlink.js`, change:

```javascript
        .addChoices(
          { name: 'Twitch', value: 'twitch' },
          { name: 'YouTube', value: 'youtube' }
        )
```

To:

```javascript
        .addChoices(
          { name: 'Twitch', value: 'twitch' },
          { name: 'YouTube', value: 'youtube' },
          { name: 'Kick', value: 'kick' }
        )
```

- [ ] **Step 3: Capture and handle Kick channel ID in unlink.js**

In `src/commands/unlink.js`, find the existing YouTube capture block (before `unlinkPlatform` is called). Extend it to capture the Kick channel ID too:

```javascript
    let youtubeChannelIdToCheck = null;
    let kickChannelIdToCheck = null;
    if (platform === 'youtube') {
      const row = getDb().prepare(`
        SELECT sp.platform_user_id FROM streamer_platforms sp
        JOIN streamers s ON sp.streamer_id = s.id
        WHERE s.guild_id = ? AND s.display_name = ? COLLATE NOCASE AND sp.platform = 'youtube'
      `).get(interaction.guildId, name);
      youtubeChannelIdToCheck = row?.platform_user_id;
    } else if (platform === 'kick') {
      const row = getDb().prepare(`
        SELECT sp.platform_user_id FROM streamer_platforms sp
        JOIN streamers s ON sp.streamer_id = s.id
        WHERE s.guild_id = ? AND s.display_name = ? COLLATE NOCASE AND sp.platform = 'kick'
      `).get(interaction.guildId, name);
      kickChannelIdToCheck = row?.platform_user_id;
    }
```

After the existing YouTube unsubscribe block (which runs after successful unlink), add a Kick unsubscribe block:

```javascript
    if (kickChannelIdToCheck && countStreamersByKickChannel(kickChannelIdToCheck) === 0) {
      try {
        await kickEvents.unsubscribe(kickChannelIdToCheck);
      } catch (err) {
        logger.warn(`Failed to unsubscribe from Kick channel ${kickChannelIdToCheck}: ${err.message}`);
      }
    }
```

- [ ] **Step 4: Apply equivalent changes to remove.js**

In `src/commands/remove.js`, add the requires at the top:

```javascript
const kickEvents = require('../platforms/kickEvents');
const { countStreamersByKickChannel } = require('../db/database');
```

Find the existing YouTube orphan-capture block (which runs before `removeStreamer`). It currently looks like:

```javascript
    let youtubeChannelIdsToCheck = [];
    const { getDb } = require('../db/database');
    const youtubeRows = getDb().prepare(
      "SELECT DISTINCT platform_user_id FROM streamer_platforms WHERE streamer_id = ? AND platform = 'youtube' AND platform_user_id IS NOT NULL"
    ).all(streamerRow.id);
    youtubeChannelIdsToCheck = youtubeRows.map(r => r.platform_user_id);
```

Extend to also capture Kick IDs (add after the YouTube block inside the same `if (streamerRow)` scope):

```javascript
    let kickChannelIdsToCheck = [];
    const kickRows = getDb().prepare(
      "SELECT DISTINCT platform_user_id FROM streamer_platforms WHERE streamer_id = ? AND platform = 'kick' AND platform_user_id IS NOT NULL"
    ).all(streamerRow.id);
    kickChannelIdsToCheck = kickRows.map(r => r.platform_user_id);
```

(Note: `kickChannelIdsToCheck` must be declared in the same outer scope as `youtubeChannelIdsToCheck` — typically the function body before the `if (streamerRow)` block. Check the current structure and declare at the top level so both are visible after the block.)

After the existing YouTube orphan-check loop (which runs after `removeStreamer(...)` returns), add the equivalent Kick loop:

```javascript
    for (const channelId of kickChannelIdsToCheck) {
      if (countStreamersByKickChannel(channelId) === 0) {
        try {
          await kickEvents.unsubscribe(channelId);
        } catch (err) {
          logger.warn(`Failed to unsubscribe from Kick channel ${channelId}: ${err.message}`);
        }
      }
    }
```

- [ ] **Step 5: Verify syntax**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/commands/unlink.js && node --check src/commands/remove.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 6: Commit**

```bash
git add src/commands/unlink.js src/commands/remove.js
git commit -m "feat: /unlink and /remove unsubscribe from Kick events when last streamer goes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Restore Kick in /upgrade tier descriptions

**Files:**
- Modify: `src/commands/upgrade.js`

- [ ] **Step 1: Update the tier description strings**

In `src/commands/upgrade.js`, the current `addFields` block is:

```javascript
      .addFields(
        { name: 'Free', value: '25 streamers\nTwitch + YouTube', inline: true },
        { name: 'Plus — $3/mo', value: '50 streamers\nTwitch + YouTube', inline: true }
      )
```

Change to:

```javascript
      .addFields(
        { name: 'Free', value: '25 streamers\nTwitch + YouTube + Kick', inline: true },
        { name: 'Plus — $3/mo', value: '50 streamers\nTwitch + YouTube + Kick', inline: true }
      )
```

(TikTok and Pro tiers remain hidden until TikTok ships.)

- [ ] **Step 2: Verify syntax**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/commands/upgrade.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 3: Commit**

```bash
git add src/commands/upgrade.js
git commit -m "chore: /upgrade tier descriptions now include Kick alongside Twitch and YouTube

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Wire up Kick health-check timer in index.js

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Add Kick timer block**

In `src/index.js`, after the existing YouTube timer block (`if (youtubeApi.isConfigured() && youtubePubSub.isConfigured())`), add:

```javascript
const kickEvents = require('./platforms/kickEvents');

if (kickEvents.isConfigured()) {
  logger.info('Kick integration enabled — starting health-check timer');

  kickEvents.healthCheckAndResubscribe().catch(err => {
    logger.error('Initial Kick health check failed:', err);
  });

  setInterval(() => {
    kickEvents.healthCheckAndResubscribe().catch(err => {
      logger.error('Kick health check tick failed:', err);
    });
  }, 6 * 60 * 60 * 1000);
} else {
  logger.info('Kick integration disabled (KICK_CLIENT_ID and/or KICK_CLIENT_SECRET not set)');
}
```

- [ ] **Step 2: Verify syntax and graceful boot without creds**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/index.js && echo "SYNTAX OK"
node -e "process.env.KICK_CLIENT_ID=''; process.env.KICK_CLIENT_SECRET=''; const e = require('./src/platforms/kickEvents'); console.log('Kick configured (no creds):', e.isConfigured());"
```

Expected:
- `SYNTAX OK`
- `Kick configured (no creds): false`

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat: start Kick health-check timer at boot when configured

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Deploy and verify in production

**Files:** None (deployment + config-only).

- [ ] **Step 1: User — create a Kick developer app**

Go to [kick.com](https://kick.com), log in, click the avatar → **Account Settings** → **Developer** tab.

Click **Create App**:
- App name: `GoblinAlert` (or similar)
- Redirect URI: can leave blank or use `https://goblinalert.com` if required
- Scopes: `events:subscribe`, `user:read`, `channel:read`

Save. Copy the **Client ID** and **Client Secret**.

Under the app's webhook settings, register `https://goblinalert.com/webhooks/kick` as the webhook callback URL.

- [ ] **Step 2: User — add env vars to local `.env`**

Open `C:\Users\cereb\Desktop\Claude projects\GoblinAlert\.env` and add:

```
KICK_CLIENT_ID=<from Step 1>
KICK_CLIENT_SECRET=<from Step 1>
```

The existing placeholder `KICK_WEBHOOK_SECRET=<empty>` can be left as-is or deleted — it is unused (Kick uses RSA public key verification, not a shared secret).

- [ ] **Step 3: Verify local env vars load**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node -e "require('dotenv').config(); const e = require('./src/platforms/kickEvents'); console.log('Kick configured:', e.isConfigured());"
```

Expected: `Kick configured: true`.

- [ ] **Step 4: Push to GitHub**

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
git push origin main
```

- [ ] **Step 5: Append env vars to server `.env` via SSH**

```bash
ssh -i "C:\Users\cereb\.ssh\hetzner_key" -o StrictHostKeyChecking=no root@5.78.133.249 "if ! grep -q '^KICK_CLIENT_ID=' /root/goblinalert/.env || grep -q '^KICK_CLIENT_ID=$' /root/goblinalert/.env; then sed -i 's|^KICK_CLIENT_ID=.*|KICK_CLIENT_ID=<YOUR_KICK_CLIENT_ID>|' /root/goblinalert/.env; fi && if ! grep -q '^KICK_CLIENT_SECRET=' /root/goblinalert/.env || grep -q '^KICK_CLIENT_SECRET=$' /root/goblinalert/.env; then sed -i 's|^KICK_CLIENT_SECRET=.*|KICK_CLIENT_SECRET=<YOUR_KICK_CLIENT_SECRET>|' /root/goblinalert/.env; fi"
```

Replace `<YOUR_KICK_CLIENT_ID>` and `<YOUR_KICK_CLIENT_SECRET>` with the real values. (Or edit the file with `nano` instead.)

Verify:

```bash
ssh -i "C:\Users\cereb\.ssh\hetzner_key" -o StrictHostKeyChecking=no root@5.78.133.249 "grep -E '^KICK' /root/goblinalert/.env | sed 's/=.*/=<SET>/'"
```

Expected output includes `KICK_CLIENT_ID=<SET>` and `KICK_CLIENT_SECRET=<SET>`.

- [ ] **Step 6: Pull, install, deploy-commands, restart**

```bash
ssh -i "C:\Users\cereb\.ssh\hetzner_key" -o StrictHostKeyChecking=no root@5.78.133.249 "cd /root/goblinalert && git pull && npm install && npm run deploy-commands && pm2 restart goblinalert --update-env"
```

Expected:
- `npm run deploy-commands` output: `Deploying 11 slash commands...` (Kick was re-added to existing commands; count is still 11)
- `pm2 restart` shows the bot came back online

- [ ] **Step 7: Tail logs and verify**

```bash
ssh -i "C:\Users\cereb\.ssh\hetzner_key" -o StrictHostKeyChecking=no root@5.78.133.249 "pm2 logs goblinalert --lines 40 --nostream"
```

Expected to see in order:
- `Migration: created kick_subscriptions table`
- `Database connected: /root/goblinalert/goblinalert.db`
- All 11 commands loaded (including `/message`, `/add`, `/link`, etc.)
- `YouTube integration enabled — starting renewal and offline-poll timers` (from earlier work)
- `Kick integration enabled — starting health-check timer` (new)
- `GoblinAlert online as GoblinAlert#1480`
- `Webhook server listening on port 3500`
- No stack traces

- [ ] **Step 8: Verify schema in prod**

```bash
ssh -i "C:\Users\cereb\.ssh\hetzner_key" -o StrictHostKeyChecking=no root@5.78.133.249 "cd /root/goblinalert && node -e \"const d=require('better-sqlite3')('goblinalert.db'); const tables=d.prepare('SELECT name FROM sqlite_master WHERE type=\\'table\\' AND name=\\'kick_subscriptions\\'').all(); console.log('kick_subscriptions exists:', tables.length > 0);\""
```

Expected: `kick_subscriptions exists: true`.

---

## Task 12: End-to-end test with a real Kick channel

**Files:** None (user acceptance).

- [ ] **Step 1: User — link a Kick channel in a test guild**

In a Discord server the bot is in, run:

```
/link name:<existing streamer display name> platform:kick username:<Kick slug, URL, or ID>
```

Expected reply: ephemeral success confirming the link.

- [ ] **Step 2: Watch the server logs for the subscribe event**

In the SSH session:

```bash
ssh -i "C:\Users\cereb\.ssh\hetzner_key" -o StrictHostKeyChecking=no root@5.78.133.249 "pm2 logs goblinalert --lines 20 --nostream | grep Kick"
```

Expected to see:
- `Kick OAuth token refreshed, expires in <N>s`
- `Kick subscribed to livestream.status.updated for broadcaster <id> (sub <sub_id>)`

If both appear, the subscribe round-trip worked.

- [ ] **Step 3: User — trigger or wait for a go-live on that Kick channel**

When the streamer actually goes live on Kick, within ~1 minute Kick should POST to `/webhooks/kick`. Expected log lines:

- (Silent if signature verifies correctly — no info log on successful verify)
- `Announcement sent: <snowflake> for <streamer> in guild <id>`
- `Sent announcement for <streamer> in guild <id> (kick)`

Expected in Discord: a standard GoblinAlert embed with the green Kick accent bar, Kick logo emoji on the "Watch on Kick" button.

- [ ] **Step 4: User — verify offline detection**

When the streamer ends the broadcast, within ~1 minute Kick pushes the same event with `is_live: false`. Expected log lines:

- `Marked announcement as ended for <streamer> in guild <id>`

Expected in Discord: embed updates to grey "Stream ended" state.

- [ ] **Step 5: User — test unlink**

```
/unlink name:<streamer> platform:kick
```

Expected log line on the server:

- `Kick unsubscribed from broadcaster <id> (sub <sub_id>)`

Verify local DB cleanup:

```bash
ssh -i "C:\Users\cereb\.ssh\hetzner_key" -o StrictHostKeyChecking=no root@5.78.133.249 "cd /root/goblinalert && node -e \"const d=require('better-sqlite3')('goblinalert.db'); console.log(d.prepare('SELECT * FROM kick_subscriptions').all());\""
```

Expected: empty array if no other Kick streamers are tracked in any guild.

---

## Self-Review

**Spec coverage check:**
- Kick OAuth 2.1 Client Credentials → Task 2.
- Kick API wrapper (channel resolution, stream info) → Task 3.
- Event subscription lifecycle (subscribe/unsubscribe/health-check) → Task 4.
- Webhook handler with RSA signature verification → Task 5.
- liveTracker platform dispatch → Task 6.
- /add and /link command updates → Task 7.
- /unlink and /remove command updates → Task 8.
- /upgrade tier description update → Task 9.
- index.js timer wiring → Task 10.
- External setup (Kick dev app, webhook URL registration, env vars) → Task 11.
- End-to-end verification → Task 12.
- Data model (kick_subscriptions table, helpers) → Task 1.
- Scope-in items (feature parity, graceful no-op when unconfigured, persistent subscriptions, in-memory dedup) — all covered across Tasks 1-10.
- Scope-out items (polling fallback, Kick chat events, App Verification badge, existing row migration) — not implemented, as specified.
- Edge cases (missing creds, 404/410 on unsubscribe, duplicate webhook, signature mismatch) — handled in Tasks 2, 4, 5.

**Placeholder scan:** No "TBD" / "TODO" tokens in the plan. All code blocks are complete. The only angle-bracket placeholders are real inputs the user must fill (`<YOUR_KICK_CLIENT_ID>`, `<existing streamer display name>`, etc.) — these are intentional and labeled.

**Type/name consistency:**
- `broadcasterUserId` is returned as `String(...)` throughout — consistent between `kickApi.shapeChannel`, `kickEvents.parseEventPayload`, and DB helpers (all expect TEXT).
- `kickEvents.subscribe(broadcasterUserId)` is called with a stringified ID; internally it passes `Number(broadcasterUserId)` to Kick's API (which expects a number).
- `prepareKickPlatform` signature matches `prepareYouTubePlatform`: returns `{ resolvedUsername, resolvedUserId }`. Same call sites in both `add.js` and `link.js`.
- `countStreamersByKickChannel(broadcasterUserId)` used identically in both `/unlink` (Task 8) and `/remove` (Task 8).
- `EVENT_NAME = 'livestream.status.updated'` and `EVENT_VERSION = 1` are centralized in kickEvents.js.
- `current_video_id` column is YouTube-specific and is NOT touched by Kick. Offline state for Kick relies entirely on the `is_live=false` event — no need to persist a "current stream ID" since Kick sends explicit offline events.

**Ordering:**
- Task 1 (DB) is first — everything else depends on the table and helpers.
- Tasks 2-4 (platform modules) are independent of commands and web but depend on DB.
- Task 5 (webhook) depends on kickEvents and kickApi (Tasks 3, 4).
- Task 6 (liveTracker) depends on kickApi (Task 3).
- Tasks 7-8 (commands) depend on kickApi, kickEvents, DB helpers.
- Task 9 (upgrade) is independent text change.
- Task 10 (index.js) depends on kickEvents (Task 4).
- Task 11 deploys everything.
- Task 12 verifies end-to-end.
