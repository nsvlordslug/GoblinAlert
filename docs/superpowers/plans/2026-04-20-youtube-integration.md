# YouTube Live Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when tracked YouTube channels go live and post a GoblinAlert announcement in each subscribing guild, matching the existing Twitch UX (rich embed, role ping, auto-update to "ended" on offline, custom `/message` support).

**Architecture:** Hybrid push+poll design. PubSubHubbub pushes (free, near-instant) tell the bot when any new content is published on a tracked channel; the bot filters for actual live streams via `videos.list`. A short polling loop detects when live streams end. All existing multi-platform code (announcer, liveTracker dispatch, embed combining) is reused; only the YouTube-specific ingestion is new.

**Tech Stack:** Node.js 22, Express (existing webhook server), axios (existing HTTP client), better-sqlite3, discord.js. No new npm dependencies.

**Reference:** [docs/superpowers/specs/2026-04-20-youtube-integration-design.md](../specs/2026-04-20-youtube-integration-design.md)

**Verification approach:** No test suite exists. Each task verifies with syntax checks (`node --check`) and isolated module loads (`node -e`). End-to-end verification happens after Task 9's deploy (no way to exercise PubSubHubbub subscription locally without a public webhook URL).

---

## File Structure

**Created:**
- `src/platforms/youtubeApi.js` — Thin wrapper over YouTube Data API v3. Channel identifier resolution, channel info fetch, video info fetch (including live status).
- `src/platforms/youtubePubSub.js` — PubSubHubbub subscription lifecycle (subscribe / unsubscribe / renew), Atom XML parsing, HMAC signature verification.
- `src/services/youtubeLivePoller.js` — Offline detection. Scans `streamer_platforms` for currently-live YouTube streams, checks each via `videos.list`, hands off to `handleStreamOffline` when the stream ends.

**Modified:**
- `src/db/database.js` — Two new migrations (`youtube_subscriptions` table + `current_video_id` column on `streamer_platforms`). Helpers for subscription CRUD and live-video tracking.
- `src/web/webhookServer.js` — `GET /webhooks/youtube` (subscription verification) and `POST /webhooks/youtube` (content notifications).
- `src/services/liveTracker.js` — `handleStreamOnline` dispatches `getStreamInfo` by platform (was Twitch-hardcoded). Persists `current_video_id` for YouTube. `handleStreamOffline` clears it.
- `src/commands/link.js`, `src/commands/add.js` — Resolve YouTube channel identifier to canonical ID on input. Ensure PubSubHubbub subscription exists for that channel.
- `src/commands/unlink.js`, `src/commands/remove.js` — After delete, unsubscribe from PubSubHubbub if no remaining streamers reference the channel.
- `src/index.js` — Start two `setInterval` timers on boot (subscription renewal every 6 hours; offline polling every 2 minutes). Both guarded by `YOUTUBE_API_KEY` + `YOUTUBE_WEBHOOK_SECRET` presence.

---

## Task 1: DB migrations and helpers for YouTube subscriptions

**Files:**
- Modify: `src/db/database.js` (migration function + new helpers)

**Rationale:** Foundation. All later tasks depend on the new table and column existing. Existing `runMigrations()` pattern already handles idempotency.

- [ ] **Step 1: Extend `runMigrations()` with two new migrations**

In `src/db/database.js`, modify the existing `runMigrations` function (added in the prior plan) to add the two new migrations after the existing `custom_message` migration:

```javascript
function runMigrations() {
  const streamerCols = db.prepare('PRAGMA table_info(streamers)').all();
  if (!streamerCols.some(c => c.name === 'custom_message')) {
    db.exec('ALTER TABLE streamers ADD COLUMN custom_message TEXT');
    logger.info('Migration: added streamers.custom_message column');
  }

  const streamerPlatformCols = db.prepare('PRAGMA table_info(streamer_platforms)').all();
  if (!streamerPlatformCols.some(c => c.name === 'current_video_id')) {
    db.exec('ALTER TABLE streamer_platforms ADD COLUMN current_video_id TEXT');
    logger.info('Migration: added streamer_platforms.current_video_id column');
  }

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='youtube_subscriptions'").all();
  if (tables.length === 0) {
    db.exec(`
      CREATE TABLE youtube_subscriptions (
        channel_id TEXT PRIMARY KEY,
        topic_url TEXT NOT NULL,
        hub_url TEXT NOT NULL DEFAULT 'https://pubsubhubbub.appspot.com/subscribe',
        subscribed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        verified_at TEXT
      );
    `);
    logger.info('Migration: created youtube_subscriptions table');
  }
}
```

- [ ] **Step 2: Add YouTube subscription helpers**

In `src/db/database.js`, after the `clearCustomMessage` function (from the prior plan), add these helpers:

```javascript
function getYoutubeSubscription(channelId) {
  return getDb().prepare('SELECT * FROM youtube_subscriptions WHERE channel_id = ?').get(channelId);
}

function upsertYoutubeSubscription(channelId, topicUrl, expiresAt) {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO youtube_subscriptions (channel_id, topic_url, subscribed_at, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      topic_url = excluded.topic_url,
      subscribed_at = excluded.subscribed_at,
      expires_at = excluded.expires_at
  `).run(channelId, topicUrl, now, expiresAt);
}

function markYoutubeSubscriptionVerified(channelId, expiresAt) {
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE youtube_subscriptions
    SET verified_at = ?, expires_at = ?
    WHERE channel_id = ?
  `).run(now, expiresAt, channelId);
}

function removeYoutubeSubscription(channelId) {
  getDb().prepare('DELETE FROM youtube_subscriptions WHERE channel_id = ?').run(channelId);
}

function listExpiringYoutubeSubscriptions(withinHours) {
  const cutoff = new Date(Date.now() + withinHours * 3600 * 1000).toISOString();
  return getDb().prepare('SELECT * FROM youtube_subscriptions WHERE expires_at < ?').all(cutoff);
}

function countStreamersByYoutubeChannel(channelId) {
  return getDb().prepare(`
    SELECT COUNT(*) as n FROM streamer_platforms
    WHERE platform = 'youtube' AND platform_user_id = ?
  `).get(channelId).n;
}

function setCurrentVideoId(streamerPlatformId, videoId) {
  getDb().prepare('UPDATE streamer_platforms SET current_video_id = ? WHERE id = ?').run(videoId, streamerPlatformId);
}

function clearCurrentVideoId(streamerPlatformId) {
  getDb().prepare('UPDATE streamer_platforms SET current_video_id = NULL WHERE id = ?').run(streamerPlatformId);
}

function listLiveYoutubeStreamerPlatforms() {
  return getDb().prepare(`
    SELECT sp.*, s.display_name, s.guild_id, s.custom_message
    FROM streamer_platforms sp
    JOIN streamers s ON sp.streamer_id = s.id
    WHERE sp.platform = 'youtube' AND sp.is_live = 1 AND sp.current_video_id IS NOT NULL
  `).all();
}
```

- [ ] **Step 3: Export new helpers**

Modify the `module.exports` block at the bottom of `src/db/database.js` (the current export list from the prior plan) to add the new names:

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
  listLiveYoutubeStreamerPlatforms
};
```

- [ ] **Step 4: Verify migrations and helpers locally**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/db/database.js && echo "SYNTAX OK"
node -e "const d = require('./src/db/database'); d.getDb(); const cols = require('better-sqlite3')('goblinalert.db').prepare('PRAGMA table_info(streamer_platforms)').all(); console.log('streamer_platforms cols:', cols.map(c => c.name).join(',')); const tables = require('better-sqlite3')('goblinalert.db').prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all(); console.log('tables:', tables.map(t => t.name).join(','));"
```

Expected:
- `SYNTAX OK`
- Two migration log lines on first run: `Migration: added streamer_platforms.current_video_id column` and `Migration: created youtube_subscriptions table`
- `streamer_platforms cols: id,streamer_id,platform,platform_username,platform_user_id,is_live,last_live_at,announce_enabled,current_video_id`
- `tables: announcements,entitlements,guilds,streamer_platforms,streamers,youtube_subscriptions`

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
git add src/db/database.js
git commit -m "feat: add youtube_subscriptions table and current_video_id column with helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: YouTube Data API wrapper

**Files:**
- Create: `src/platforms/youtubeApi.js`

**Rationale:** Thin HTTP wrapper. Isolates key management and error handling. Used by commands (for channel resolution), webhook handler (for video info), and offline poller.

- [ ] **Step 1: Create youtubeApi.js**

Create `src/platforms/youtubeApi.js` with this content:

```javascript
const axios = require('axios');
const logger = require('../utils/logger');

const API_BASE = 'https://www.googleapis.com/youtube/v3';

function isConfigured() {
  return Boolean(process.env.YOUTUBE_API_KEY);
}

async function youtubeGet(path, params) {
  if (!isConfigured()) {
    throw new Error('YOUTUBE_API_KEY is not set');
  }
  const response = await axios.get(`${API_BASE}${path}`, {
    params: { ...params, key: process.env.YOUTUBE_API_KEY },
    timeout: 10000
  });
  return response.data;
}

/**
 * Resolve any YouTube channel identifier (handle, URL, or channel ID) to a canonical channel ID.
 * Returns { channelId, title, handle } on success, null if not found.
 */
async function resolveChannelId(input) {
  if (!input) return null;
  const trimmed = input.trim();

  let channelId = null;
  let handle = null;

  if (/^UC[\w-]{22}$/.test(trimmed)) {
    channelId = trimmed;
  } else {
    const urlChannelMatch = trimmed.match(/youtube\.com\/channel\/(UC[\w-]{22})/i);
    if (urlChannelMatch) {
      channelId = urlChannelMatch[1];
    } else {
      const urlHandleMatch = trimmed.match(/youtube\.com\/@([^/?#\s]+)/i);
      if (urlHandleMatch) {
        handle = urlHandleMatch[1];
      } else if (trimmed.startsWith('@')) {
        handle = trimmed.slice(1);
      } else {
        handle = trimmed;
      }
    }
  }

  try {
    if (channelId) {
      const data = await youtubeGet('/channels', {
        id: channelId,
        part: 'snippet'
      });
      const item = data.items?.[0];
      if (!item) return null;
      return {
        channelId: item.id,
        title: item.snippet.title,
        handle: item.snippet.customUrl?.replace(/^@/, '') || null
      };
    }

    const data = await youtubeGet('/channels', {
      forHandle: `@${handle}`,
      part: 'snippet'
    });
    const item = data.items?.[0];
    if (!item) return null;
    return {
      channelId: item.id,
      title: item.snippet.title,
      handle: item.snippet.customUrl?.replace(/^@/, '') || handle
    };
  } catch (err) {
    logger.error(`YouTube channel resolution failed for "${input}":`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Fetch live/metadata info for a specific video ID.
 * Returns { id, title, thumbnailUrl, liveBroadcastContent, viewerCount, startedAt, channelId, channelTitle } or null.
 */
async function getVideoInfo(videoId) {
  try {
    const data = await youtubeGet('/videos', {
      id: videoId,
      part: 'snippet,liveStreamingDetails'
    });
    const item = data.items?.[0];
    if (!item) return null;

    const snippet = item.snippet;
    const live = item.liveStreamingDetails || {};
    const thumb = snippet.thumbnails?.maxres?.url
      || snippet.thumbnails?.standard?.url
      || snippet.thumbnails?.high?.url
      || snippet.thumbnails?.default?.url
      || null;

    return {
      id: item.id,
      title: snippet.title,
      thumbnailUrl: thumb,
      liveBroadcastContent: snippet.liveBroadcastContent,
      viewerCount: live.concurrentViewers ? Number(live.concurrentViewers) : 0,
      startedAt: live.actualStartTime || null,
      channelId: snippet.channelId,
      channelTitle: snippet.channelTitle
    };
  } catch (err) {
    logger.error(`YouTube video lookup failed for videoId "${videoId}":`, err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  isConfigured,
  resolveChannelId,
  getVideoInfo
};
```

- [ ] **Step 2: Verify syntax and graceful no-op without key**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/platforms/youtubeApi.js && echo "SYNTAX OK"
node -e "process.env.YOUTUBE_API_KEY=''; const y = require('./src/platforms/youtubeApi'); console.log('isConfigured (empty key):', y.isConfigured()); y.resolveChannelId('@foo').then(r => { console.log('resolveChannelId without key → expect error logged, null returned:', r); }).catch(e => console.error('unexpected throw:', e.message));"
```

Expected:
- `SYNTAX OK`
- `isConfigured (empty key): false`
- An error log like `YouTube channel resolution failed for "@foo": YOUTUBE_API_KEY is not set`
- `resolveChannelId without key → expect error logged, null returned: null`

- [ ] **Step 3: Commit**

```bash
git add src/platforms/youtubeApi.js
git commit -m "feat: add YouTube Data API v3 wrapper with graceful no-op when unconfigured

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: PubSubHubbub subscription manager

**Files:**
- Create: `src/platforms/youtubePubSub.js`

**Rationale:** Encapsulates all hub interactions (subscribe, unsubscribe, renew), Atom XML parsing, and HMAC signature verification. Consumers (commands, webhook handler, renewal loop) don't need to know the protocol details.

- [ ] **Step 1: Create youtubePubSub.js**

Create `src/platforms/youtubePubSub.js` with this content:

```javascript
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const {
  getYoutubeSubscription,
  upsertYoutubeSubscription,
  removeYoutubeSubscription,
  listExpiringYoutubeSubscriptions
} = require('../db/database');

const HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';
const LEASE_SECONDS = 864000;
const CALLBACK_URL = 'https://goblinalert.com/webhooks/youtube';

function isConfigured() {
  return Boolean(process.env.YOUTUBE_WEBHOOK_SECRET);
}

function topicUrlFor(channelId) {
  return `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
}

async function postToHub(params) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) form.append(k, String(v));
  return axios.post(HUB_URL, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
    validateStatus: status => status >= 200 && status < 300
  });
}

/**
 * Subscribe to a YouTube channel's Atom feed via PubSubHubbub.
 * Persists a row in youtube_subscriptions with an initial expires_at based on lease seconds requested
 * (actual lease may be shorter; the verification GET will update it).
 * Throws on hub error; caller decides how to handle.
 */
async function subscribe(channelId) {
  if (!isConfigured()) throw new Error('YOUTUBE_WEBHOOK_SECRET is not set');
  const topicUrl = topicUrlFor(channelId);

  await postToHub({
    'hub.callback': CALLBACK_URL,
    'hub.topic': topicUrl,
    'hub.verify': 'async',
    'hub.mode': 'subscribe',
    'hub.secret': process.env.YOUTUBE_WEBHOOK_SECRET,
    'hub.lease_seconds': LEASE_SECONDS
  });

  const expiresAt = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
  upsertYoutubeSubscription(channelId, topicUrl, expiresAt);
  logger.info(`PubSubHubbub subscribe requested for channel ${channelId}`);
}

async function unsubscribe(channelId) {
  if (!isConfigured()) throw new Error('YOUTUBE_WEBHOOK_SECRET is not set');
  const topicUrl = topicUrlFor(channelId);

  try {
    await postToHub({
      'hub.callback': CALLBACK_URL,
      'hub.topic': topicUrl,
      'hub.verify': 'async',
      'hub.mode': 'unsubscribe',
      'hub.secret': process.env.YOUTUBE_WEBHOOK_SECRET
    });
    logger.info(`PubSubHubbub unsubscribe requested for channel ${channelId}`);
  } catch (err) {
    logger.warn(`PubSubHubbub unsubscribe failed for channel ${channelId}: ${err.message} — deleting local row anyway`);
  }
  removeYoutubeSubscription(channelId);
}

/**
 * Check for subscriptions expiring within 24h and re-subscribe.
 * Called by a setInterval running every 6 hours.
 */
async function renewExpiringSubscriptions() {
  if (!isConfigured()) return;
  const expiring = listExpiringYoutubeSubscriptions(24);
  if (expiring.length === 0) return;
  logger.info(`PubSubHubbub: renewing ${expiring.length} expiring subscription(s)`);
  for (const sub of expiring) {
    try {
      await subscribe(sub.channel_id);
    } catch (err) {
      logger.warn(`PubSubHubbub renewal failed for channel ${sub.channel_id}: ${err.message}`);
    }
  }
}

/**
 * Verify the X-Hub-Signature header against the raw body using HMAC-SHA1.
 * Expected header format: "sha1=<hex>"
 */
function verifyHubSignature(rawBody, signatureHeader) {
  if (!isConfigured() || !signatureHeader) return false;
  const [algo, hex] = signatureHeader.split('=');
  if (algo !== 'sha1' || !hex) return false;
  const expected = crypto
    .createHmac('sha1', process.env.YOUTUBE_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hex, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Extract video+channel entries from a YouTube Atom feed push body.
 * Returns [{ videoId, channelId, publishedAt }]; may be empty if the push contains only <at:deleted-entry>.
 */
function parseAtomEntries(xml) {
  const entries = [];
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const body = match[1];
    const videoId = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const channelId = body.match(/<yt:channelId>([^<]+)<\/yt:channelId>/)?.[1];
    const publishedAt = body.match(/<published>([^<]+)<\/published>/)?.[1];
    if (videoId && channelId) {
      entries.push({ videoId, channelId, publishedAt });
    }
  }
  return entries;
}

module.exports = {
  isConfigured,
  subscribe,
  unsubscribe,
  renewExpiringSubscriptions,
  verifyHubSignature,
  parseAtomEntries,
  topicUrlFor,
  HUB_URL,
  LEASE_SECONDS,
  CALLBACK_URL
};
```

- [ ] **Step 2: Verify syntax and Atom parser with sample data**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/platforms/youtubePubSub.js && echo "SYNTAX OK"
node -e "const p = require('./src/platforms/youtubePubSub'); const sample = '<?xml version=\"1.0\"?><feed xmlns:yt=\"http://www.youtube.com/xml/schemas/2015\"><entry><id>yt:video:abc123</id><yt:videoId>abc123</yt:videoId><yt:channelId>UCxyzxyzxyzxyzxyzxyzxy</yt:channelId><published>2026-04-20T10:00:00Z</published><title>Going live!</title></entry></feed>'; console.log('parsed entries:', p.parseAtomEntries(sample));"
node -e "process.env.YOUTUBE_WEBHOOK_SECRET='s3cr3t'; const p = require('./src/platforms/youtubePubSub'); const body = 'hello world'; const crypto = require('crypto'); const sig = 'sha1=' + crypto.createHmac('sha1', 's3cr3t').update(body).digest('hex'); console.log('verify valid sig:', p.verifyHubSignature(body, sig)); console.log('verify bad sig:', p.verifyHubSignature(body, 'sha1=deadbeef'));"
```

Expected:
- `SYNTAX OK`
- `parsed entries: [ { videoId: 'abc123', channelId: 'UCxyzxyzxyzxyzxyzxyzxy', publishedAt: '2026-04-20T10:00:00Z' } ]`
- `verify valid sig: true`
- `verify bad sig: false`

- [ ] **Step 3: Commit**

```bash
git add src/platforms/youtubePubSub.js
git commit -m "feat: add PubSubHubbub subscription manager with HMAC verification and Atom parsing

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Webhook routes for /webhooks/youtube

**Files:**
- Modify: `src/web/webhookServer.js`

**Rationale:** Express handlers for PubSubHubbub subscription verification (GET) and content notifications (POST). The POST handler does HMAC verification on the raw body before parsing.

- [ ] **Step 1: Read current webhookServer.js to understand the Express app setup**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
head -50 src/web/webhookServer.js
```

Note the pattern used for Twitch routes. In particular, note how the raw body is captured for HMAC verification (likely `express.raw()` or a custom verify function on `express.json()`). The YouTube handler needs the same raw-body access.

- [ ] **Step 2: Add YouTube routes**

In `src/web/webhookServer.js`, add the following routes. The exact insertion point is after the existing Twitch route registrations but before `return app;` (or the module's equivalent final line). Adjust as needed based on the file's actual structure:

```javascript
const youtubePubSub = require('../platforms/youtubePubSub');
const youtubeApi = require('../platforms/youtubeApi');
const { markYoutubeSubscriptionVerified } = require('../db/database');

// GET /webhooks/youtube — PubSubHubbub subscription verification
app.get('/webhooks/youtube', (req, res) => {
  const mode = req.query['hub.mode'];
  const topic = req.query['hub.topic'];
  const challenge = req.query['hub.challenge'];
  const leaseSeconds = Number(req.query['hub.lease_seconds']) || youtubePubSub.LEASE_SECONDS;

  if (!mode || !topic || !challenge) {
    logger.warn('YouTube verification GET missing required params');
    return res.status(400).send('missing params');
  }

  const channelIdMatch = topic.match(/channel_id=(UC[\w-]{22})/);
  const channelId = channelIdMatch?.[1];
  if (!channelId) {
    logger.warn(`YouTube verification GET with unrecognized topic: ${topic}`);
    return res.status(404).send('unknown topic');
  }

  if (mode === 'subscribe') {
    const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    markYoutubeSubscriptionVerified(channelId, expiresAt);
    logger.info(`YouTube subscription verified: channel ${channelId}, expires ${expiresAt}`);
  } else if (mode === 'unsubscribe') {
    logger.info(`YouTube unsubscription verified: channel ${channelId}`);
  }
  res.status(200).send(challenge);
});

// POST /webhooks/youtube — PubSubHubbub content notification
app.post('/webhooks/youtube',
  express.raw({ type: ['application/atom+xml', 'application/xml', 'text/xml'], limit: '1mb' }),
  async (req, res) => {
    const signatureHeader = req.get('X-Hub-Signature');
    const rawBody = req.body;

    if (!youtubePubSub.verifyHubSignature(rawBody, signatureHeader)) {
      logger.warn(`YouTube webhook signature verification failed (sig: ${signatureHeader})`);
      return res.status(401).send('bad signature');
    }

    res.status(202).send('accepted');

    try {
      const xml = rawBody.toString('utf8');
      const entries = youtubePubSub.parseAtomEntries(xml);
      if (entries.length === 0) {
        logger.debug('YouTube webhook: no entries in push');
        return;
      }

      const { handleStreamOnline } = require('../services/liveTracker');

      for (const entry of entries) {
        const info = await youtubeApi.getVideoInfo(entry.videoId);
        if (!info) {
          logger.debug(`YouTube webhook: no info returned for video ${entry.videoId}, skipping`);
          continue;
        }
        if (info.liveBroadcastContent !== 'live') {
          logger.debug(`YouTube webhook: video ${entry.videoId} is ${info.liveBroadcastContent}, skipping (non-premiere mode)`);
          continue;
        }
        const streamDetails = {
          title: info.title,
          thumbnailUrl: info.thumbnailUrl,
          viewerCount: info.viewerCount,
          startedAt: info.startedAt,
          videoId: info.id
        };
        await handleStreamOnline('youtube', entry.channelId, info.channelTitle, discordClient, streamDetails);
      }
    } catch (err) {
      logger.error('YouTube webhook processing error:', err);
    }
  }
);
```

Note: this assumes `discordClient` is already available in the webhook server's scope (via the `createWebhookServer(client)` factory). Verify this pattern matches the Twitch route; if `discordClient` is named differently (e.g. `client`), use that name instead.

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
git commit -m "feat: add /webhooks/youtube GET (verify) and POST (content) routes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Platform-dispatched stream info in liveTracker.js

**Files:**
- Modify: `src/services/liveTracker.js`

**Rationale:** Currently hardcodes Twitch's `getStreamInfo`. Needs to accept pre-fetched stream details (from the YouTube webhook, avoiding a duplicate API call) or dispatch to a platform-specific lookup.

- [ ] **Step 1: Update handleStreamOnline signature and body**

In `src/services/liveTracker.js`, replace the `handleStreamOnline` function. The change adds a 5th optional parameter `preFetchedStreamDetails` and adds platform dispatch for fetching stream info and for persisting `current_video_id`. The full new function body:

```javascript
async function handleStreamOnline(platform, platformUserId, platformUsername, discordClient, preFetchedStreamDetails = null) {
  const db = getDb();

  const platformEntries = db.prepare(`
    SELECT sp.*, s.id as streamer_id, s.display_name, s.guild_id, s.custom_message
    FROM streamer_platforms sp
    JOIN streamers s ON sp.streamer_id = s.id
    WHERE sp.platform = ? AND (sp.platform_user_id = ? OR sp.platform_username = ? COLLATE NOCASE)
    AND sp.announce_enabled = 1
  `).all(platform, platformUserId, platformUsername);

  if (platformEntries.length === 0) {
    logger.debug(`No tracked streamers found for ${platform}/${platformUsername}`);
    return;
  }

  for (const entry of platformEntries) {
    try {
      if (!entry.platform_user_id && platformUserId) {
        db.prepare('UPDATE streamer_platforms SET platform_user_id = ? WHERE id = ?').run(platformUserId, entry.id);
      }

      const updates = ['is_live = 1', 'last_live_at = CURRENT_TIMESTAMP'];
      const params = [];
      if (platform === 'youtube' && preFetchedStreamDetails?.videoId) {
        updates.push('current_video_id = ?');
        params.push(preFetchedStreamDetails.videoId);
      }
      params.push(entry.id);
      db.prepare(`UPDATE streamer_platforms SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      let streamDetails = preFetchedStreamDetails;
      if (!streamDetails) {
        if (platform === 'twitch') {
          streamDetails = await getStreamInfo(platformUserId);
        } else if (platform === 'youtube') {
          logger.warn(`YouTube handleStreamOnline called without preFetchedStreamDetails for channel ${platformUserId}; no fallback lookup available`);
        }
      }

      const guild = db.prepare('SELECT * FROM guilds WHERE guild_id = ?').get(entry.guild_id);
      if (!guild || !guild.announcement_channel_id) {
        logger.warn(`Guild ${entry.guild_id} has no announcement channel configured`);
        continue;
      }

      const existingAnnouncement = db.prepare(
        'SELECT * FROM announcements WHERE guild_id = ? AND streamer_id = ?'
      ).get(entry.guild_id, entry.streamer_id);

      const livePlatforms = db.prepare(`
        SELECT * FROM streamer_platforms
        WHERE streamer_id = ? AND is_live = 1
      `).all(entry.streamer_id);

      if (existingAnnouncement && guild.combine_multi_platform) {
        await updateAnnouncement(
          discordClient,
          existingAnnouncement,
          entry,
          livePlatforms,
          streamDetails,
          guild
        );
        logger.info(`Updated announcement for ${entry.display_name} in guild ${entry.guild_id} (added ${platform})`);
      } else if (!existingAnnouncement) {
        const result = await sendAnnouncement(
          discordClient,
          entry,
          livePlatforms,
          streamDetails,
          guild
        );
        if (result.ok) {
          logger.info(`Sent announcement for ${entry.display_name} in guild ${entry.guild_id} (${platform})`);
        } else {
          logger.warn(`Announcement not sent for ${entry.display_name} in guild ${entry.guild_id} — ${result.error?.message}`);
          await notifyOwnerOfFailure(discordClient, entry.guild_id, entry, result.error);
        }
      }
    } catch (error) {
      logger.error(`Error handling stream.online for ${entry.display_name} in guild ${entry.guild_id}:`, error);
    }
  }
}
```

- [ ] **Step 2: Update handleStreamOffline to clear current_video_id for YouTube**

In the same file, modify `handleStreamOffline`. Find the line that marks the platform as offline:

```javascript
      db.prepare('UPDATE streamer_platforms SET is_live = 0 WHERE id = ?').run(entry.id);
```

Replace with:

```javascript
      if (platform === 'youtube') {
        db.prepare('UPDATE streamer_platforms SET is_live = 0, current_video_id = NULL WHERE id = ?').run(entry.id);
      } else {
        db.prepare('UPDATE streamer_platforms SET is_live = 0 WHERE id = ?').run(entry.id);
      }
```

- [ ] **Step 3: Verify syntax**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/services/liveTracker.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 4: Commit**

```bash
git add src/services/liveTracker.js
git commit -m "feat: liveTracker accepts preFetched streamDetails and tracks YouTube current_video_id

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Update /link and /add commands for YouTube

**Files:**
- Modify: `src/commands/link.js`
- Modify: `src/commands/add.js`

**Rationale:** When platform=youtube, resolve the user input to a canonical channel ID before storing, and ensure a PubSubHubbub subscription exists for that channel.

- [ ] **Step 1: Read current link.js and add.js to understand their structure**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
cat src/commands/link.js
```

Note: the current implementation likely does not call `resolveChannelId` or handle YouTube subscriptions — it treats all platforms uniformly.

- [ ] **Step 2: Add YouTube handling helper**

The pattern of "if platform is youtube, resolve channel ID and ensure subscription" is shared between `/add` and `/link`. Add the helper at the top of each file (or a shared helper module if that's cleaner — for this plan, inline it in each command for directness).

In `src/commands/link.js`, near the top of the file after the existing `require` statements, add:

```javascript
const youtubeApi = require('../platforms/youtubeApi');
const youtubePubSub = require('../platforms/youtubePubSub');
const { getYoutubeSubscription } = require('../db/database');

/**
 * Preprocess a YouTube platform input: resolve to canonical channel ID, ensure subscription.
 * Returns { resolvedUsername, resolvedUserId } on success; throws with user-friendly message on failure.
 */
async function prepareYouTubePlatform(userInput) {
  if (!youtubeApi.isConfigured() || !youtubePubSub.isConfigured()) {
    throw new Error('YouTube integration isn\'t configured on this bot. Please contact the bot operator.');
  }
  const resolved = await youtubeApi.resolveChannelId(userInput);
  if (!resolved) {
    throw new Error(`Could not find YouTube channel "${userInput}". Check the handle, URL, or channel ID and try again.`);
  }
  const existing = getYoutubeSubscription(resolved.channelId);
  if (!existing) {
    await youtubePubSub.subscribe(resolved.channelId);
  }
  return {
    resolvedUsername: resolved.handle || resolved.title,
    resolvedUserId: resolved.channelId
  };
}
```

Then find the section of the command's `execute` function that extracts the `platform` and `username` options and persists them. Before the DB write (the `linkPlatform(...)` call), insert the YouTube branch:

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

Then adjust the existing `linkPlatform(guildId, displayName, platform, platformUsername)` call. Its signature stores only username, not ID. Since `addStreamer` and `linkPlatform` in `database.js` currently accept only `(guildId, displayName, platform, platformUsername)`, we need a post-insert update to set `platform_user_id`.

Immediately after the `linkPlatform` call on success, add:

```javascript
    if (platform === 'youtube' && finalUserId) {
      const { getDb } = require('../db/database');
      getDb().prepare(`
        UPDATE streamer_platforms SET platform_user_id = ?
        WHERE streamer_id = (SELECT id FROM streamers WHERE guild_id = ? AND display_name = ? COLLATE NOCASE)
          AND platform = ?
      `).run(finalUserId, interaction.guildId, displayName, platform);
    }
```

Also pass `finalUsername` (not the original `username`) into `linkPlatform`. Find the existing call (pattern: `linkPlatform(interaction.guildId, displayName, platform, username)`) and change the last arg to `finalUsername`.

- [ ] **Step 3: Apply the same changes to add.js**

Repeat the same steps in `src/commands/add.js`. The add command likely calls `addStreamer` instead of `linkPlatform`; the logic is structurally identical — `finalUsername` goes into the call, `finalUserId` is backfilled into the row afterward.

- [ ] **Step 4: Verify syntax**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/commands/link.js && node --check src/commands/add.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/link.js src/commands/add.js
git commit -m "feat: /link and /add resolve YouTube channels and ensure PubSubHubbub subscription

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Update /unlink and /remove to clean up orphaned YouTube subscriptions

**Files:**
- Modify: `src/commands/unlink.js`
- Modify: `src/commands/remove.js`

**Rationale:** When the last streamer tracking a YouTube channel is removed, the bot should unsubscribe from PubSubHubbub (stops Google from sending notifications nobody cares about and keeps the subscriptions table clean).

- [ ] **Step 1: Read current unlink.js and remove.js**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
cat src/commands/unlink.js
cat src/commands/remove.js
```

- [ ] **Step 2: Add YouTube unsubscribe helper to unlink.js**

In `src/commands/unlink.js`, near the top after existing requires, add:

```javascript
const youtubePubSub = require('../platforms/youtubePubSub');
const { countStreamersByYoutubeChannel, getYoutubeSubscription } = require('../db/database');
```

Before calling `unlinkPlatform(...)`, capture the platform_user_id of the row that's about to be deleted (so we can decide whether to unsubscribe after). The `unlinkPlatform` helper in database.js returns a streamer object but not the platform_user_id; fetch it manually first:

```javascript
    let youtubeChannelIdToCheck = null;
    if (platform === 'youtube') {
      const { getDb } = require('../db/database');
      const row = getDb().prepare(`
        SELECT sp.platform_user_id FROM streamer_platforms sp
        JOIN streamers s ON sp.streamer_id = s.id
        WHERE s.guild_id = ? AND s.display_name = ? COLLATE NOCASE AND sp.platform = 'youtube'
      `).get(interaction.guildId, displayName);
      youtubeChannelIdToCheck = row?.platform_user_id;
    }
```

After the `unlinkPlatform(...)` call succeeds (i.e. after the existing success reply logic), add:

```javascript
    if (youtubeChannelIdToCheck && countStreamersByYoutubeChannel(youtubeChannelIdToCheck) === 0) {
      try {
        await youtubePubSub.unsubscribe(youtubeChannelIdToCheck);
      } catch (err) {
        logger.warn(`Failed to unsubscribe from YouTube channel ${youtubeChannelIdToCheck}: ${err.message}`);
      }
    }
```

(Note: `unsubscribe` already deletes the local row and logs warnings on hub errors, so the outer try/catch is belt-and-suspenders — but safe.)

- [ ] **Step 3: Apply equivalent changes to remove.js**

In `src/commands/remove.js`, the situation is different: `/remove` deletes the streamer entirely, which cascades all platform rows. So capture ALL YouTube channel IDs the streamer had BEFORE the delete, then check each one after:

Add at the top:

```javascript
const youtubePubSub = require('../platforms/youtubePubSub');
const { countStreamersByYoutubeChannel } = require('../db/database');
```

Before `removeStreamer(...)` is called, capture the YouTube channel IDs:

```javascript
    let youtubeChannelIdsToCheck = [];
    const { getDb } = require('../db/database');
    const youtubeRows = getDb().prepare(`
      SELECT DISTINCT sp.platform_user_id FROM streamer_platforms sp
      JOIN streamers s ON sp.streamer_id = s.id
      WHERE s.guild_id = ? AND s.display_name = ? COLLATE NOCASE AND sp.platform = 'youtube'
        AND sp.platform_user_id IS NOT NULL
    `).all(interaction.guildId, displayName);
    youtubeChannelIdsToCheck = youtubeRows.map(r => r.platform_user_id);
```

After `removeStreamer(...)` succeeds, for each channel ID, check if any streamer still references it and unsubscribe if not:

```javascript
    for (const channelId of youtubeChannelIdsToCheck) {
      if (countStreamersByYoutubeChannel(channelId) === 0) {
        try {
          await youtubePubSub.unsubscribe(channelId);
        } catch (err) {
          logger.warn(`Failed to unsubscribe from YouTube channel ${channelId}: ${err.message}`);
        }
      }
    }
```

- [ ] **Step 4: Verify syntax**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/commands/unlink.js && node --check src/commands/remove.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/unlink.js src/commands/remove.js
git commit -m "feat: /unlink and /remove unsubscribe from YouTube hub when last streamer goes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Offline poller service

**Files:**
- Create: `src/services/youtubeLivePoller.js`

**Rationale:** YouTube doesn't push stream.offline events. A short polling loop on currently-live streams is how we detect ends. Runs every 2 minutes via `setInterval`.

- [ ] **Step 1: Create youtubeLivePoller.js**

Create `src/services/youtubeLivePoller.js`:

```javascript
const logger = require('../utils/logger');
const { listLiveYoutubeStreamerPlatforms } = require('../db/database');
const youtubeApi = require('../platforms/youtubeApi');

/**
 * One poll cycle: check all currently-live YouTube streams and fire offline when ended.
 */
async function pollOnce(discordClient) {
  if (!youtubeApi.isConfigured()) return;

  const liveRows = listLiveYoutubeStreamerPlatforms();
  if (liveRows.length === 0) return;

  const seenVideos = new Set();
  const { handleStreamOffline } = require('./liveTracker');

  for (const row of liveRows) {
    if (!row.current_video_id || seenVideos.has(row.current_video_id)) {
      continue;
    }
    seenVideos.add(row.current_video_id);

    const info = await youtubeApi.getVideoInfo(row.current_video_id);
    const stillLive = info && info.liveBroadcastContent === 'live';
    if (!stillLive) {
      logger.info(`YouTube offline detected: video ${row.current_video_id} (channel ${row.platform_user_id})`);
      try {
        await handleStreamOffline('youtube', row.platform_user_id, row.platform_username, discordClient);
      } catch (err) {
        logger.error(`handleStreamOffline failed for YouTube channel ${row.platform_user_id}: ${err.message}`);
      }
    }
  }
}

module.exports = { pollOnce };
```

Note: `handleStreamOffline` in the current codebase takes `(platform, platformUserId, platformUsername, discordClient)`. Verify this signature matches by reading `src/services/liveTracker.js` line ~90 before committing.

- [ ] **Step 2: Verify syntax**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/services/youtubeLivePoller.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 3: Commit**

```bash
git add src/services/youtubeLivePoller.js
git commit -m "feat: YouTube offline poller service

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Wire up renewal and polling timers in index.js

**Files:**
- Modify: `src/index.js`

**Rationale:** Start the two `setInterval` timers on boot, only if both YouTube env vars are present. Twitch keeps working regardless.

- [ ] **Step 1: Add YouTube timers after client.once('ready', ...)**

In `src/index.js`, find the `client.once('ready', ...)` block (around line 50). Directly after it (still inside the same file scope), add:

```javascript
const youtubeApi = require('./platforms/youtubeApi');
const youtubePubSub = require('./platforms/youtubePubSub');
const youtubeLivePoller = require('./services/youtubeLivePoller');

if (youtubeApi.isConfigured() && youtubePubSub.isConfigured()) {
  logger.info('YouTube integration enabled — starting renewal and offline-poll timers');

  setInterval(() => {
    youtubePubSub.renewExpiringSubscriptions().catch(err => {
      logger.error('YouTube subscription renewal tick failed:', err);
    });
  }, 6 * 60 * 60 * 1000);

  client.once('ready', () => {
    setInterval(() => {
      youtubeLivePoller.pollOnce(client).catch(err => {
        logger.error('YouTube offline poll tick failed:', err);
      });
    }, 2 * 60 * 1000);
  });

  youtubePubSub.renewExpiringSubscriptions().catch(err => {
    logger.error('Initial YouTube subscription renewal failed:', err);
  });
} else {
  logger.info('YouTube integration disabled (YOUTUBE_API_KEY and/or YOUTUBE_WEBHOOK_SECRET not set)');
}
```

Note: the renewal timer doesn't need the Discord client; the offline poller does. The offline-poll `setInterval` is nested in a `client.once('ready', ...)` to guarantee the client is ready before the first poll. The renewal is fine to run pre-ready since it only hits Google's hub and the DB.

- [ ] **Step 2: Verify syntax and boot**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node --check src/index.js && echo "SYNTAX OK"
node -e "process.env.YOUTUBE_API_KEY=''; process.env.YOUTUBE_WEBHOOK_SECRET=''; require('./src/platforms/youtubeApi'); require('./src/platforms/youtubePubSub'); require('./src/services/youtubeLivePoller'); console.log('modules load cleanly without YouTube env vars');"
```

Expected:
- `SYNTAX OK`
- `modules load cleanly without YouTube env vars`

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat: start YouTube renewal and offline-poll timers at boot when configured

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Deploy and verify in production

**Files:** None (deployment-only).

**Rationale:** All code is in; now we need env vars on the server and a restart. This is where the user has to paste the API key and webhook secret they generated earlier. Order matters — the env vars must exist before the bot restarts and the renewal/poll timers fire.

- [ ] **Step 1: User — add env vars to local .env**

Open `C:\Users\cereb\Desktop\Claude projects\GoblinAlert\.env` and append these two lines (replace the `<...>` placeholders with the actual values you saved):

```
YOUTUBE_API_KEY=<your API key from GCP>
YOUTUBE_WEBHOOK_SECRET=<your hex secret>
```

- [ ] **Step 2: User — verify local env vars load**

Run:

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
node -e "require('dotenv').config(); const {isConfigured: apiOk} = require('./src/platforms/youtubeApi'); const {isConfigured: pubsubOk} = require('./src/platforms/youtubePubSub'); console.log('YouTube API configured:', apiOk()); console.log('PubSub configured:', pubsubOk());"
```

Expected:
- `YouTube API configured: true`
- `PubSub configured: true`

- [ ] **Step 3: Push to GitHub**

```bash
cd "C:\Users\cereb\Desktop\Claude projects\GoblinAlert"
git push origin main
```

- [ ] **Step 4: SSH to Hetzner and add env vars**

```bash
ssh -i "C:\Users\cereb\.ssh\hetzner_key" root@5.78.133.249
```

On the server, edit `/root/goblinalert/.env` to add the two lines. Use nano:

```bash
nano /root/goblinalert/.env
```

Add at the bottom:

```
YOUTUBE_API_KEY=<your API key from GCP>
YOUTUBE_WEBHOOK_SECRET=<your hex secret>
```

Save (Ctrl+O, Enter, Ctrl+X).

- [ ] **Step 5: Pull, install, restart on Hetzner**

Still on the server:

```bash
cd /root/goblinalert && git pull && npm install && pm2 restart goblinalert --update-env
```

- [ ] **Step 6: Tail logs and verify boot**

On the server:

```bash
pm2 logs goblinalert --lines 40 --nostream
```

Expected log lines on this boot:
- `Migration: added streamer_platforms.current_video_id column`
- `Migration: created youtube_subscriptions table`
- `Database connected: /root/goblinalert/goblinalert.db`
- All 11 commands loaded (including `/message` from the prior plan)
- `YouTube integration enabled — starting renewal and offline-poll timers`
- `GoblinAlert online as GoblinAlert#1480`
- `Webhook server listening on port 3500`

No stack traces.

- [ ] **Step 7: Verify schema in prod**

On the server:

```bash
node -e "const d = require('better-sqlite3')('/root/goblinalert/goblinalert.db'); const spCols = d.prepare('PRAGMA table_info(streamer_platforms)').all(); console.log('streamer_platforms has current_video_id:', spCols.some(c => c.name === 'current_video_id')); const tables = d.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='youtube_subscriptions'\").all(); console.log('youtube_subscriptions exists:', tables.length > 0);"
```

Expected:
- `streamer_platforms has current_video_id: true`
- `youtube_subscriptions exists: true`

Disconnect SSH once satisfied.

---

## Task 11: End-to-end test with a real YouTube channel

**Files:** None (user acceptance).

**Rationale:** Up to this point, no real YouTube traffic has hit the bot. Now we verify the full flow end to end with a real channel.

- [ ] **Step 1: User — link a YouTube channel in a test guild**

In a Discord server the bot is in, run:

```
/link streamer:<some existing streamer name> platform:youtube username:<their YouTube handle or URL>
```

Pick a streamer who actually has a YouTube channel, and use any of the accepted formats (`@handle`, `youtube.com/@handle`, or `UCxxxx...`).

**Expected reply:** an ephemeral success message confirming the link.

**On the server (optional — tail logs during):** `pm2 logs goblinalert --lines 10 --nostream`

Expected log lines:
- Something like: `PubSubHubbub subscribe requested for channel UCxxx...`
- Within ~1-10 seconds: `YouTube subscription verified: channel UCxxx..., expires 2026-04-30T...`

The "verified" line confirms Google's hub GET arrived at our webhook and we handled it correctly.

- [ ] **Step 2: User — trigger or wait for a go-live**

Wait for that streamer to actually go live on YouTube, or ask them to start a quick test stream. When they go live, within ~1 minute:

Expected log lines on the server:
- `Announcement sent: <snowflake> for <streamer> in guild <id>`
- `Sent announcement for <streamer> in guild <id> (youtube)`

Expected in Discord: a normal GoblinAlert announcement embed in the guild's configured channel, with a "Watch on YouTube" button.

- [ ] **Step 3: User — wait for the stream to end**

When the streamer ends the broadcast, within 2 minutes:

Expected log lines:
- `YouTube offline detected: video <videoId> (channel <channelId>)`
- `Marked announcement as ended for <streamer> in guild <id>`

Expected in Discord: the embed updates to the grey "Stream ended" state.

- [ ] **Step 4: User — verify custom message works**

Set a custom message for this streamer:

```
/message streamer:<name> text:Shit's popping off — {streamer} is live on YouTube!
```

Next time they go live, expect the custom text (with role ping if configured) instead of the default.

- [ ] **Step 5: User — clean up if this was a test**

If the YouTube link was only for testing, unlink:

```
/unlink streamer:<name> platform:youtube
```

Expected log line on the server: `PubSubHubbub unsubscribe requested for channel UCxxx...`

The row should be gone from `youtube_subscriptions` — verify on the server:

```bash
node -e "const d = require('better-sqlite3')('/root/goblinalert/goblinalert.db'); console.log(d.prepare('SELECT * FROM youtube_subscriptions').all());"
```

Expected: empty array (if no other YouTube channels are linked anywhere).

---

## Self-Review

**Spec coverage check:**
- User experience (admin runs `/link platform:youtube`, gets announcement on go-live) — Tasks 6, 10, 11.
- PubSubHubbub subscription manager (subscribe / verify / renew / unsubscribe) — Tasks 3, 4, 6, 7, 9.
- Webhook handler at `/webhooks/youtube` — Task 4.
- Offline polling loop — Tasks 8, 9.
- Required `liveTracker.js` change (platform dispatch) — Task 5.
- Data model (new table + new column) — Task 1.
- External setup (API key + webhook secret) — Task 10 (user paste step).
- Scope-in items (multi-platform combining, custom message support, graceful degradation) — handled because the announcer and liveTracker are reused unchanged.
- Scope-out items (premieres, Game field, renamed-channel reconciliation, quota increase, VOD-aware offline) — not implemented, as specified.
- Edge cases (missing key, verification GET for unknown topic, HMAC mismatch, quota exhaustion, duplicate pushes, deleted entries) — handled in Tasks 2, 3, 4 with explicit branches or logged no-ops.
- Migration story (zero prod YouTube rows, idempotent migrations) — Task 1 migrations are idempotent; Task 10 verifies on prod.

**Placeholder scan:** No "TBD" / "TODO" markers. Every step contains real code, exact commands, and expected output.

**Type/name consistency:**
- `resolveChannelId` returns `{ channelId, title, handle }` — used identically in Task 6 (`prepareYouTubePlatform`).
- `getVideoInfo` returns `{ id, title, thumbnailUrl, liveBroadcastContent, viewerCount, startedAt, channelId, channelTitle } | null` — used in Task 4 (webhook POST) and Task 8 (poller).
- `subscribe(channelId)` / `unsubscribe(channelId)` — used consistently in Tasks 3, 6, 7, 9.
- `countStreamersByYoutubeChannel` used in both `/unlink` (Task 7) and `/remove` (Task 7) with the same semantics.
- `handleStreamOnline` signature expanded to 5 params with 5th optional in Task 5; called with 5 args from the webhook in Task 4.
- `current_video_id` column set in Task 5 (liveTracker during online), cleared in Task 5 (liveTracker during offline), queried by Task 8 (poller) via `listLiveYoutubeStreamerPlatforms`.
- `YOUTUBE_API_KEY` and `YOUTUBE_WEBHOOK_SECRET` referenced consistently in Tasks 2, 3, 9, 10.

**Task ordering:** All 11 tasks strictly depend on the prior ones. Task 1 (DB) before Task 2 (API wrapper imports nothing DB yet, but lives in the same package). Task 3 (PubSub) depends on Task 1's helpers. Task 4 (webhooks) depends on Tasks 2 and 3. Task 5 (liveTracker dispatch) depends on nothing new but is required before Task 4 can handoff. Task 6 (commands add/link) depends on Tasks 2 and 3. Task 7 (commands unlink/remove) depends on Task 3. Task 8 (poller) depends on Task 2 (API). Task 9 (index.js) wires up Tasks 3 and 8. Task 10 deploys it all. Task 11 verifies end-to-end.
