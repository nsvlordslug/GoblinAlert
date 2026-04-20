# YouTube Live Detection Design

**Status:** Approved, ready for implementation planning
**Date:** 2026-04-20
**Author:** brainstorm between user and Claude

## Goal

Detect when tracked YouTube channels go live and post a GoblinAlert announcement in each subscribing guild's channel, matching the existing Twitch user experience as closely as possible.

## User experience

Admin adds a YouTube channel the same way they add Twitch:

```
/link streamer:Wynterlovely platform:youtube username:@wynterlovely
```

Acceptable inputs for `username`:
- Handle, e.g. `@wynterlovely`
- Full URL, e.g. `https://youtube.com/@wynterlovely` or `https://youtube.com/channel/UCxxxxx...`
- Canonical channel ID, e.g. `UCxxxxx...`

The bot resolves whatever is given to the canonical channel ID via the YouTube Data API and stores:
- `streamer_platforms.platform_user_id` ← canonical channel ID (`UCxxx...`). This is the stable identifier — used for subscription and for matching incoming pushes.
- `streamer_platforms.platform_username` ← channel handle without the `@` prefix (e.g. `wynterlovely`) if the channel has one; otherwise the channel title as returned by the API. Used for display in `/list` and as a fallback match in `liveTracker` queries.

When the streamer goes live on YouTube, the bot posts the standard announcement in the guild's configured channel: role ping (if set), embed with stream title, thumbnail, "Watch on YouTube" button. If the streamer is also tracked on Twitch and already has a live announcement in the guild (multi-platform combining enabled), the existing embed is updated to add the YouTube button instead of creating a second message.

When the stream ends, the embed updates to the grey "Stream ended" state (or is deleted if the guild has `delete_on_end` enabled), matching Twitch behavior.

Custom alert messages set via `/message` apply unchanged.

## Architecture

Three new subsystems running alongside the existing Twitch pipeline:

### 1. PubSubHubbub subscription manager

YouTube publishes an Atom feed per channel at `https://www.youtube.com/xml/feeds/videos.xml?channel_id=X`. Google operates a free PubSubHubbub hub at `https://pubsubhubbub.appspot.com/subscribe` that pushes a POST to a callback URL whenever a channel adds new content (uploads, shorts, live streams, premieres).

The bot subscribes once per distinct channel ID, regardless of how many guilds track that streamer. Subscription lifecycle:

- **Subscribe** — triggered the first time a streamer is linked to a YouTube channel no other streamer already tracks. POST to the hub with:
  - `hub.callback=https://goblinalert.com/webhooks/youtube`
  - `hub.topic=https://www.youtube.com/xml/feeds/videos.xml?channel_id=X`
  - `hub.verify=async`
  - `hub.mode=subscribe`
  - `hub.secret=<YOUTUBE_WEBHOOK_SECRET>`
  - `hub.lease_seconds=864000` (10 days)
- **Verify** — Google's hub GETs our webhook with `hub.mode=subscribe&hub.topic=...&hub.challenge=...`. We echo the challenge back (200 OK with the challenge as the body) and persist `expires_at = now + 10d` on the row.
- **Renew** — a `setInterval` running once every 6 hours scans `youtube_subscriptions` for rows with `expires_at < now + 24h`, re-sends the subscribe request. Same verification flow as initial subscribe.
- **Unsubscribe** — triggered when the last streamer tracking a given channel is removed. POST to the hub with `hub.mode=unsubscribe`. Delete the row.

### 2. Webhook handler at `/webhooks/youtube`

- **GET** — subscription verification. Respond 200 with `hub.challenge` as the body when `hub.mode=subscribe` or `hub.mode=unsubscribe`. Update the corresponding row's `verified_at`/delete as appropriate.
- **POST** — content notification from the hub.
  1. Verify `X-Hub-Signature` HMAC-SHA1 against the raw request body using `YOUTUBE_WEBHOOK_SECRET`. If mismatch, 401 and log.
  2. Parse the Atom XML body. Extract the `<yt:videoId>` and `<yt:channelId>` from each `<entry>`.
  3. For each entry, call `videos.list?id=<videoId>&part=snippet,liveStreamingDetails` (1 quota unit).
  4. If `liveBroadcastContent === 'live'`: hand off to `handleStreamOnline('youtube', channelId, channelHandle, discordClient)` in `liveTracker.js`, and make sure the `videoId` is stored in `streamer_platforms.current_video_id` as part of the live-mark step. See "Required `liveTracker.js` change" below.
  5. If `liveBroadcastContent === 'upcoming'` or `'none'`: ignore (non-premiere mode per design decision).

**Required `liveTracker.js` change:** The existing `handleStreamOnline(platform, platformUserId, platformUsername, discordClient)` currently calls `getStreamInfo(platformUserId)` via a direct import from `twitchEventSub.js` — that's Twitch-only. This needs to dispatch by platform: when `platform === 'youtube'`, call a new `getYouTubeStreamInfo(videoId)` in `youtubeApi.js` to fetch title, thumbnail, live viewer count, and start time. The webhook can pass pre-fetched details as an optional fifth parameter to avoid a duplicate API call, or `handleStreamOnline` can re-fetch; both are acceptable implementations. Additionally, when `platform === 'youtube'`, the live-mark `UPDATE streamer_platforms` step must also set `current_video_id` so the offline poller has something to watch.

### 3. Offline polling loop

A `setInterval` running every 2 minutes:

- Scans `streamer_platforms WHERE platform='youtube' AND is_live=1`.
- For each row, calls `videos.list` on the stored `current_video_id`.
- If `liveBroadcastContent !== 'live'` or the video is not returned (deleted/privated): hand off to `handleStreamOffline('youtube', channelId, videoId)`, which marks the platform row offline, clears `current_video_id`, and updates/deletes the announcement per guild config.
- If the API call fails (quota, transient error): log and skip; next tick retries.

Quota estimate: assuming 10 tracked YouTube channels averaging 4 hours live per day, offline polling uses 10 × 4hr × 30 polls/hr = 1,200 units/day. PubSubHubbub pushes fire on every new video (uploads, shorts, and lives), say ~10 pushes/day across all channels, each costing one `videos.list` call = 10 units/day. Total: ~1,210 units/day, well under the 10,000/day free quota.

## Data model

### New table `youtube_subscriptions`

```sql
CREATE TABLE IF NOT EXISTS youtube_subscriptions (
  channel_id TEXT PRIMARY KEY,
  topic_url TEXT NOT NULL,
  hub_url TEXT NOT NULL DEFAULT 'https://pubsubhubbub.appspot.com/subscribe',
  subscribed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_at TEXT
);
```

- `channel_id` — YouTube canonical channel ID (`UCxxxxx...`).
- `topic_url` — the Atom feed URL we subscribed to.
- `subscribed_at` / `verified_at` — timestamps of last subscribe request and last successful hub verification.
- `expires_at` — when the current lease ends. Renewal loop checks this.

### New column on `streamer_platforms`

```sql
ALTER TABLE streamer_platforms ADD COLUMN current_video_id TEXT;
```

Holds the YouTube video ID for the currently-live stream. Used only by the offline polling loop. Cleared when the stream ends. Null for all non-YouTube rows and for YouTube rows that aren't currently live.

Both schema changes go through the existing `runMigrations()` function added in the 2026-04-20 announcement-bugs-and-custom-messages work.

## External setup (one-time, by user)

1. Create a Google Cloud project (free, no billing required) at [console.cloud.google.com](https://console.cloud.google.com). Name it "GoblinAlert" or similar.
2. Enable the YouTube Data API v3 from the API Library page.
3. Generate an API key from Credentials. Restrict it to the YouTube Data API for safety.
4. Add to `.env` (both local and `/root/goblinalert/.env` on Hetzner):

   ```
   YOUTUBE_API_KEY=<api key from step 3>
   YOUTUBE_WEBHOOK_SECRET=<32+ char random string>
   ```

5. Add a tunnel route for the YouTube webhook. The existing Cloudflare Tunnel already proxies `goblinalert.com` to port 3500 on the Hetzner box, so no tunnel config changes are needed — the new `/webhooks/youtube` route is served from the same Express app as `/webhooks/twitch`.

## Implementation components

| File | Change | Purpose |
|---|---|---|
| `src/platforms/youtubePubSub.js` | New | Subscription lifecycle (subscribe/renew/unsubscribe), hub HTTP client, Atom XML parser. |
| `src/platforms/youtubeApi.js` | New | Thin wrapper around `videos.list`, `channels.list`, and channel-identifier resolution (handle/URL/ID → canonical channel ID). |
| `src/web/webhookServer.js` | Modify | Register `/webhooks/youtube` GET and POST handlers. |
| `src/services/liveTracker.js` | Modify | Minor — pass `streamDetails` from YouTube (title, thumbnail, viewer count, start time) in the same shape as Twitch. |
| `src/services/announcer.js` | No change | Already platform-agnostic; renders YouTube the same way as Twitch. |
| `src/db/database.js` | Modify | Add the two migrations. Add helpers: `getYoutubeSubscription`, `upsertYoutubeSubscription`, `removeYoutubeSubscription`, `listExpiringSubscriptions`, `setCurrentVideoId`, `clearCurrentVideoId`. |
| `src/commands/link.js` | Modify | When platform=youtube, call the resolver to turn user input into a canonical channel ID before storing. Trigger a new PubSubHubbub subscription if this is the first streamer tracking that channel. |
| `src/commands/unlink.js` / `remove.js` | Modify | Cleanup: after unlinking, check if any other streamer still tracks that channel; if not, unsubscribe and delete the subscription row. |
| `src/commands/add.js` | Modify | Same as `/link` for the YouTube case. |
| `src/index.js` | Modify | On boot, start the subscription-renewal `setInterval` (every 6 hours) and the offline-polling `setInterval` (every 2 minutes). Only if `YOUTUBE_API_KEY` is set. |

## Scope boundaries

### In scope
- Real-time live detection via PubSubHubbub push.
- `videos.list` filter to separate real lives from uploads/shorts/premieres.
- Offline detection via short polling loop over currently-live videos.
- Multi-platform combining: YouTube streams combine into existing Twitch embeds when combine_multi_platform is enabled.
- Custom alert messages (`/message`) apply to YouTube streams unchanged.
- Channel-identifier resolution for `/add` and `/link` — user types handle/URL/ID, bot stores canonical channel ID.
- Subscription lifecycle automation — subscribe on first link, renew daily-cron, unsubscribe on last unlink.
- Graceful degradation when `YOUTUBE_API_KEY` is absent — log warnings, no crashes, Twitch keeps working.

### Out of scope (deferred, not blocked by this work)
- Scheduled premiere / upcoming-broadcast announcements. The infrastructure here supports adding it later: the PubSubHubbub pushes already include premiere notifications; we just filter them out. A future feature can stop filtering and add a scheduled-reminder `setInterval` keyed off `scheduledStartTime` from `videos.list`.
- Game / category field in the YouTube embed. YouTube's `videoCategoryId` is coarse (Gaming, Music, etc.) and the resolution to human-readable names requires an extra API call. Leave the Game field blank for YouTube streams; Twitch rows unaffected.
- Channel-renamed auto-reconciliation. If a YouTube channel changes handle, the stored `platform_user_id` (channel ID) is stable and subscription continues to work; only the display name in `/list` will be stale. Admins re-link manually if they want the updated display name.
- Google Cloud quota increase request. Default 10,000 units/day easily covers up to ~100 tracked channels at the current detection cadence. Revisit only if usage nears the cap.
- VOD-aware "Stream ended" behavior. YouTube keeps the recording at the same URL after the stream ends, so the existing "Watch on YouTube" button in the ended-state embed remains useful. No special handling needed.

## Edge cases and failure modes

- **Missing `YOUTUBE_API_KEY` on boot.** Subscription manager and offline poller don't start. `/link platform:youtube` returns an ephemeral error: "YouTube integration isn't configured. Please contact the bot operator." Twitch keeps working.
- **Subscription verification GET from an unknown hub / topic mismatch.** Respond 404. Log at debug level.
- **HMAC mismatch on POST.** Respond 401. Log at warn level with the channel ID we would have processed, in case it's a legitimate message with a misconfigured secret.
- **`videos.list` returns no items for a pushed video ID.** Treat as not-live, ignore.
- **Hub returns 409 on subscribe (pending verification).** Treat as success; verification GET will arrive shortly.
- **Subscription renewal fails at hub (network, hub outage).** Log. Next 6h cron tick retries. If the sub actually expires between retries, Google simply stops pushing until next renewal succeeds — we accept the gap.
- **Quota exhausted mid-day.** `videos.list` calls start returning 403. Log warn. Online/offline detection stops until quota resets at midnight Pacific. Existing Twitch announcements continue unaffected. (Also a strong signal we should raise the quota limit.)
- **Atom feed contains a `<at:deleted-entry>`** (video deleted). Safely ignore — if we were tracking it as live, the offline poller will catch it on next tick.
- **Streamer goes live on YouTube seconds before PubSubHubbub push arrives.** Normal case. Latency is typically under a minute.
- **Google sends a duplicate push for the same video.** `videos.list` still returns live; `handleStreamOnline` checks for existing announcement in `liveTracker.js` and updates rather than double-posting. Already handled by existing logic.

## Migration story

- **Prod DB (as of 2026-04-20):** zero rows in `streamer_platforms` where `platform='youtube'`. Clean slate.
- **Local DB:** one row (`nsvlordslug`, `platform_user_id=null`). After deploy, user can re-run `/link streamer:<name> platform:youtube username:@nsvlordslug` to re-resolve; the existing row will be kept (the DB helper finds by display name) and `platform_user_id` will be populated.
- **No data-rewriting migration needed.** Both schema changes are additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`) and safe to run on a live DB. The existing `runMigrations()` handles idempotency.

## Estimated size

~450 lines of new code across the two new files and modifications listed above. Implementation effort is comparable to the Twitch EventSub work that's already in the codebase; many of the patterns (webhook HMAC verification, per-guild fan-out via `liveTracker.js`) transfer directly.
