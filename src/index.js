require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
const logger = require('./utils/logger');

// Initialize database (creates tables on first run)
require('./db/database').getDb();

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

// Load commands
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
    logger.info(`Loaded command: /${command.data.name}`);
  } else {
    logger.warn(`Command at ${file} is missing "data" or "execute".`);
  }
}

// Load events
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
  const event = require(path.join(eventsPath, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
  logger.info(`Loaded event: ${event.name}`);
}

// Start webhook server for platform callbacks
const { createWebhookServer } = require('./web/webhookServer');

client.once('ready', () => {
  const webhookApp = createWebhookServer(client);
  const port = process.env.WEBHOOK_PORT || 3500;
  webhookApp.listen(port, () => {
    logger.info(`Webhook server listening on port ${port}`);
  });
});

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

// Login
client.login(process.env.DISCORD_TOKEN).catch(err => {
  logger.error('Failed to login:', err.message);
  process.exit(1);
});
