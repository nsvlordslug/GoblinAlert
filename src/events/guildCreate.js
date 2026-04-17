const { ensureGuild } = require('../db/database');
const logger = require('../utils/logger');

module.exports = {
  name: 'guildCreate',
  execute(guild) {
    ensureGuild(guild.id);
    logger.info(`Joined new server: ${guild.name} (${guild.id})`);
  }
};
