const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { unlinkPlatform } = require('../db/database');
const { PLATFORM_LABELS } = require('../utils/constants');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Remove a platform from a streamer (keeps other platforms)')
    .addStringOption(option =>
      option.setName('name').setDescription('Display name of the streamer').setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('platform')
        .setDescription('Platform to remove')
        .setRequired(true)
        .addChoices(
          { name: 'Twitch', value: 'twitch' },
          { name: 'YouTube', value: 'youtube' },
          { name: 'Kick', value: 'kick' },
          { name: 'TikTok', value: 'tiktok' }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const name = interaction.options.getString('name');
    const platform = interaction.options.getString('platform');

    try {
      unlinkPlatform(interaction.guildId, name, platform);
      logger.info(`Guild ${interaction.guildId}: unlinked ${platform} from ${name}`);
      await interaction.reply(`Unlinked **${PLATFORM_LABELS[platform]}** from **${name}**.`);
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  }
};
