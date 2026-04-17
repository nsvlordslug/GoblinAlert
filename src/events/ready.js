const logger = require('../utils/logger');

module.exports = {
  name: 'ready',
  once: true,
  execute(client) {
    logger.info(`GoblinAlert online as ${client.user.tag}`);
    logger.info(`Serving ${client.guilds.cache.size} servers`);
    client.user.setActivity('for live streams', { type: 3 }); // WATCHING
  }
};
