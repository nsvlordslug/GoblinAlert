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
