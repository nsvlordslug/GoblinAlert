const { twitchApiRequest } = require('./twitchAuth');
const logger = require('../utils/logger');

/**
 * Get the Twitch user ID from a username
 */
async function getTwitchUserId(username) {
  try {
    const response = await twitchApiRequest('get', `/users?login=${username}`);
    const user = response.data.data[0];
    if (!user) throw new Error(`Twitch user "${username}" not found`);
    return { id: user.id, login: user.login, display_name: user.display_name, profile_image_url: user.profile_image_url };
  } catch (error) {
    logger.error(`Failed to get Twitch user ID for ${username}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Subscribe to stream.online and stream.offline events for a Twitch user
 */
async function subscribeToStreamEvents(twitchUserId) {
  const callbackUrl = process.env.TWITCH_WEBHOOK_CALLBACK_URL;
  const secret = process.env.TWITCH_WEBHOOK_SECRET;

  if (!callbackUrl || !secret) {
    logger.error('TWITCH_WEBHOOK_CALLBACK_URL and TWITCH_WEBHOOK_SECRET must be set in .env');
    return;
  }

  const eventTypes = ['stream.online', 'stream.offline'];

  for (const type of eventTypes) {
    try {
      await twitchApiRequest('post', '/eventsub/subscriptions', {
        type,
        version: '1',
        condition: { broadcaster_user_id: twitchUserId },
        transport: {
          method: 'webhook',
          callback: callbackUrl,
          secret: secret
        }
      });
      logger.info(`Subscribed to ${type} for Twitch user ${twitchUserId}`);
    } catch (error) {
      // 409 = already subscribed, that's fine
      if (error.response?.status === 409) {
        logger.debug(`Already subscribed to ${type} for ${twitchUserId}`);
      } else {
        logger.error(`Failed to subscribe to ${type} for ${twitchUserId}:`, error.response?.data || error.message);
      }
    }
  }
}

/**
 * Unsubscribe from all EventSub subscriptions for a Twitch user
 */
async function unsubscribeFromStreamEvents(twitchUserId) {
  try {
    // List all subscriptions
    const response = await twitchApiRequest('get', '/eventsub/subscriptions');
    const subs = response.data.data.filter(
      s => s.condition.broadcaster_user_id === twitchUserId
    );

    for (const sub of subs) {
      await twitchApiRequest('delete', `/eventsub/subscriptions?id=${sub.id}`);
      logger.info(`Unsubscribed from ${sub.type} for Twitch user ${twitchUserId}`);
    }
  } catch (error) {
    logger.error(`Failed to unsubscribe for ${twitchUserId}:`, error.response?.data || error.message);
  }
}

/**
 * Get current stream info for a Twitch user
 */
async function getStreamInfo(twitchUserId) {
  try {
    const response = await twitchApiRequest('get', `/streams?user_id=${twitchUserId}`);
    const stream = response.data.data[0];
    if (!stream) return null;

    return {
      title: stream.title,
      game: stream.game_name,
      viewerCount: stream.viewer_count,
      thumbnailUrl: stream.thumbnail_url
        .replace('{width}', '440')
        .replace('{height}', '248'),
      startedAt: stream.started_at
    };
  } catch (error) {
    logger.error(`Failed to get stream info for ${twitchUserId}:`, error.response?.data || error.message);
    return null;
  }
}

/**
 * List all current EventSub subscriptions (for debugging)
 */
async function listSubscriptions() {
  try {
    const response = await twitchApiRequest('get', '/eventsub/subscriptions');
    return response.data;
  } catch (error) {
    logger.error('Failed to list EventSub subscriptions:', error.response?.data || error.message);
    return null;
  }
}

module.exports = {
  getTwitchUserId,
  subscribeToStreamEvents,
  unsubscribeFromStreamEvents,
  getStreamInfo,
  listSubscriptions
};
