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
