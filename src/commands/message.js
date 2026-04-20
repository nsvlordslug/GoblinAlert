const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { setCustomMessage, clearCustomMessage } = require('../db/database');
const logger = require('../utils/logger');

const MAX_MESSAGE_LENGTH = 500;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('message')
    .setDescription('Set or clear a custom go-live alert message for a streamer')
    .addStringOption(option =>
      option
        .setName('streamer')
        .setDescription('The streamer (display name as added with /add)')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('text')
        .setDescription('The custom message. Use {streamer} for their name. Leave empty to clear.')
        .setMaxLength(MAX_MESSAGE_LENGTH)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const displayName = interaction.options.getString('streamer');
    const text = interaction.options.getString('text');

    try {
      if (text === null || text.trim() === '') {
        clearCustomMessage(interaction.guildId, displayName);
        logger.info(`Guild ${interaction.guildId}: cleared custom message for ${displayName}`);
        await interaction.reply({
          content: `Cleared the custom alert message for **${displayName}**. Default message will be used.`,
          ephemeral: true
        });
        return;
      }

      setCustomMessage(interaction.guildId, displayName, text);
      logger.info(`Guild ${interaction.guildId}: set custom message for ${displayName}`);

      const preview = text.replace(/\{streamer\}/g, `**${displayName}**`);
      await interaction.reply({
        content:
          `Set custom alert message for **${displayName}**.\n\n` +
          `**Preview:** ${preview}\n\n` +
          `(If you have a ping role configured, it will still be auto-prepended when the streamer goes live.)`,
        ephemeral: true
      });
    } catch (error) {
      logger.warn(`Guild ${interaction.guildId}: /message failed — ${error.message}`);
      await interaction.reply({
        content: `:x: ${error.message}`,
        ephemeral: true
      });
    }
  }
};
