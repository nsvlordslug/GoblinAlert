const express = require('express');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { handleStreamOnline, handleStreamOffline } = require('../services/liveTracker');

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

  return app;
}

module.exports = { createWebhookServer };
