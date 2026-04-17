const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { linkPlatform } = require('../db/database');
const { canAddTikTok } = require('../services/tierGate');
const { PAID_PLATFORMS, PLATFORM_LABELS } = require('../utils/constants');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link an additional platform to an existing streamer')
    .addStringOption(option =>
      option.setName('name').setDescription('Display name of the existing streamer').setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('platform')
        .setDescription('Platform to add')
        .setRequired(true)
        .addChoices(
          { name: 'Twitch', value: 'twitch' },
          { name: 'YouTube', value: 'youtube' },
          { name: 'Kick', value: 'kick' },
          { name: 'TikTok', value: 'tiktok' }
        )
    )
    .addStringOption(option =>
      option.setName('username').setDescription('Username on that platform').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const name = interaction.options.getString('name');
    const platform = interaction.options.getString('platform');
    const username = interaction.options.getString('username');

    if (PAID_PLATFORMS.includes(platform)) {
      const tikTokCheck = canAddTikTok(interaction.guildId);
      if (tikTokCheck.requiresUpgrade) {
        return interaction.reply({ content: `TikTok requires a paid tier. Use \`/upgrade\` to see plans.`, ephemeral: true });
      }
      if (!tikTokCheck.allowed) {
        return interaction.reply({ content: `TikTok streamer limit reached (${tikTokCheck.current}/${tikTokCheck.max}).`, ephemeral: true });
      }
    }

    try {
      linkPlatform(interaction.guildId, name, platform, username);
      logger.info(`Guild ${interaction.guildId}: linked ${platform}/${username} to ${name}`);
      await interaction.reply(`Linked **${PLATFORM_LABELS[platform]}** (\`${username}\`) to **${name}**. Announcements will include this platform.`);
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  }
};
