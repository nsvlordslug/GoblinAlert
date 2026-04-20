const express = require('express');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { handleStreamOnline, handleStreamOffline } = require('../services/liveTracker');
const youtubePubSub = require('../platforms/youtubePubSub');
const youtubeApi = require('../platforms/youtubeApi');
const { markYoutubeSubscriptionVerified } = require('../db/database');

const TWITCH_MESSAGE_ID = 'twitch-eventsub-message-id';
const TWITCH_MESSAGE_TIMESTAMP = 'twitch-eventsub-message-timestamp';
const TWITCH_MESSAGE_SIGNATURE = 'twitch-eventsub-message-signature';
const TWITCH_MESSAGE_TYPE = 'twitch-eventsub-message-type';

/**
 * Verify that the webhook request is actually from Twitch
 */
function verifyTwitchSignature(req) {
  const secret = process.env.TWITCH_WEBHOOK_SECRET;
  const messageId = req.headers[TWITCH_MESSAGE_ID];
  const timestamp = req.headers[TWITCH_MESSAGE_TIMESTAMP];
  const body = req.rawBody;

  const message = messageId + timestamp + body;
  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  const actualSignature = req.headers[TWITCH_MESSAGE_SIGNATURE];
  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(actualSignature)
  );
}

function createWebhookServer(discordClient) {
  const app = express();

  // Parse JSON body but keep raw body for signature verification
  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    }
  }));

  // Health check endpoint
  app.get('/', (req, res) => {
    res.json({ status: 'GoblinAlert webhook server running', timestamp: new Date().toISOString() });
  });

  // Twitch EventSub webhook endpoint
  app.post('/webhooks/twitch', async (req, res) => {
    // Verify signature
    try {
      if (!verifyTwitchSignature(req)) {
        logger.warn('Twitch webhook signature verification failed');
        return res.status(403).send('Signature verification failed');
      }
    } catch (error) {
      logger.error('Signature verification error:', error.message);
      return res.status(403).send('Signature verification error');
    }

    const messageType = req.headers[TWITCH_MESSAGE_TYPE];

    // Handle verification challenge
    if (messageType === 'webhook_callback_verification') {
      logger.info('Twitch EventSub verification challenge received');
      return res.status(200).type('text/plain').send(req.body.challenge);
    }

    // Handle revocation
    if (messageType === 'revocation') {
      logger.warn('Twitch EventSub subscription revoked:', req.body.subscription);
      return res.status(204).send();
    }

    // Handle notification
    if (messageType === 'notification') {
      const { subscription, event } = req.body;
      logger.info(`Twitch EventSub notification: ${subscription.type} for ${event.broadcaster_user_login}`);

      // Respond immediately so Twitch doesn't retry
      res.status(204).send();

      // Process the event asynchronously
      try {
        if (subscription.type === 'stream.online') {
          await handleStreamOnline('twitch', event.broadcaster_user_id, event.broadcaster_user_login, discordClient);
        } else if (subscription.type === 'stream.offline') {
          await handleStreamOffline('twitch', event.broadcaster_user_id, event.broadcaster_user_login, discordClient);
        }
      } catch (error) {
        logger.error(`Error processing Twitch event ${subscription.type}:`, error);
      }

      return;
    }

    res.status(204).send();
  });

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

  return app;
}

module.exports = { createWebhookServer };
