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
