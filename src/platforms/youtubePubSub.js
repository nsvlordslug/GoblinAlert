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
