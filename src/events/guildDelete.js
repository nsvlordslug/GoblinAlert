const { removeGuild } = require('../db/database');
const logger = require('../utils/logger');

module.exports = {
  name: 'guildDelete',
  execute(guild) {
    removeGuild(guild.id);
    logger.info(`Removed from server: ${guild.name} (${guild.id})`);
  }
};
