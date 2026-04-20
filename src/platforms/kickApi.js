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
