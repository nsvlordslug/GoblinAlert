const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { linkPlatform, getDb, getYoutubeSubscription } = require('../db/database');
const { canAddTikTok } = require('../services/tierGate');
const { PAID_PLATFORMS, PLATFORM_LABELS } = require('../utils/constants');
const youtubeApi = require('../platforms/youtubeApi');
const youtubePubSub = require('../platforms/youtubePubSub');
const logger = require('../utils/logger');

/**
 * Preprocess a YouTube platform input: resolve to canonical channel ID, ensure subscription.
 * Returns { resolvedUsername, resolvedUserId } on success; throws with user-friendly message on failure.
 */
async function prepareYouTubePlatform(userInput) {
  if (!youtubeApi.isConfigured() || !youtubePubSub.isConfigured()) {
    throw new Error('YouTube integration isn\'t configured on this bot. Please contact the bot operator.');
  }
  const resolved = await youtubeApi.resolveChannelId(userInput);
  if (!resolved) {
    throw new Error(`Could not find YouTube channel "${userInput}". Check the handle, URL, or channel ID and try again.`);
  }
  const existing = getYoutubeSubscription(resolved.channelId);
  if (!existing) {
    await youtubePubSub.subscribe(resolved.channelId);
  }
  return {
    resolvedUsername: resolved.handle || resolved.title,
    resolvedUserId: resolved.channelId
  };
}

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

    let finalUsername = username;
    let finalUserId = null;
    if (platform === 'youtube') {
      try {
        const prepared = await prepareYouTubePlatform(username);
        finalUsername = prepared.resolvedUsername;
        finalUserId = prepared.resolvedUserId;
      } catch (err) {
        await interaction.reply({ content: `:x: ${err.message}`, ephemeral: true });
        return;
      }
    }

    try {
      linkPlatform(interaction.guildId, name, platform, finalUsername);
      if (platform === 'youtube' && finalUserId) {
        getDb().prepare(`
          UPDATE streamer_platforms SET platform_user_id = ?
          WHERE streamer_id = (SELECT id FROM streamers WHERE guild_id = ? AND display_name = ? COLLATE NOCASE)
            AND platform = ?
        `).run(finalUserId, interaction.guildId, name, platform);
      }
      logger.info(`Guild ${interaction.guildId}: linked ${platform}/${finalUsername} to ${name}`);
      await interaction.reply(`Linked **${PLATFORM_LABELS[platform]}** (\`${finalUsername}\`) to **${name}**. Announcements will include this platform.`);
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  }
};
