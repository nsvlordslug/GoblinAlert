const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { unlinkPlatform, getDb, countStreamersByYoutubeChannel, countStreamersByKickChannel } = require('../db/database');
const { PLATFORM_LABELS } = require('../utils/constants');
const youtubePubSub = require('../platforms/youtubePubSub');
const kickEvents = require('../platforms/kickEvents');
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
          { name: 'Kick', value: 'kick' }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const name = interaction.options.getString('name');
    const platform = interaction.options.getString('platform');

    let youtubeChannelIdToCheck = null;
    let kickChannelIdToCheck = null;
    if (platform === 'youtube') {
      const row = getDb().prepare(`
        SELECT sp.platform_user_id FROM streamer_platforms sp
        JOIN streamers s ON sp.streamer_id = s.id
        WHERE s.guild_id = ? AND s.display_name = ? COLLATE NOCASE AND sp.platform = 'youtube'
      `).get(interaction.guildId, name);
      youtubeChannelIdToCheck = row?.platform_user_id;
    } else if (platform === 'kick') {
      const row = getDb().prepare(`
        SELECT sp.platform_user_id FROM streamer_platforms sp
        JOIN streamers s ON sp.streamer_id = s.id
        WHERE s.guild_id = ? AND s.display_name = ? COLLATE NOCASE AND sp.platform = 'kick'
      `).get(interaction.guildId, name);
      kickChannelIdToCheck = row?.platform_user_id;
    }

    try {
      unlinkPlatform(interaction.guildId, name, platform);
      logger.info(`Guild ${interaction.guildId}: unlinked ${platform} from ${name}`);
      await interaction.reply(`Unlinked **${PLATFORM_LABELS[platform]}** from **${name}**.`);
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
      return;
    }

    if (youtubeChannelIdToCheck && countStreamersByYoutubeChannel(youtubeChannelIdToCheck) === 0) {
      try {
        await youtubePubSub.unsubscribe(youtubeChannelIdToCheck);
      } catch (err) {
        logger.warn(`Failed to unsubscribe from YouTube channel ${youtubeChannelIdToCheck}: ${err.message}`);
      }
    }

    if (kickChannelIdToCheck && countStreamersByKickChannel(kickChannelIdToCheck) === 0) {
      try {
        await kickEvents.unsubscribe(kickChannelIdToCheck);
      } catch (err) {
        logger.warn(`Failed to unsubscribe from Kick channel ${kickChannelIdToCheck}: ${err.message}`);
      }
    }
  }
};
