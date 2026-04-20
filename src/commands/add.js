const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { addStreamer, ensureGuild, getDb, getYoutubeSubscription } = require('../db/database');
const { canAddStreamer, canAddTikTok } = require('../services/tierGate');
const { PAID_PLATFORMS, PLATFORM_LABELS } = require('../utils/constants');
const { getTwitchUserId, subscribeToStreamEvents } = require('../platforms/twitchEventSub');
const youtubeApi = require('../platforms/youtubeApi');
const youtubePubSub = require('../platforms/youtubePubSub');
const logger = require('../utils/logger');

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
    .setName('add')
    .setDescription('Add a streamer to the watchlist')
    .addStringOption(option =>
      option
        .setName('platform')
        .setDescription('Streaming platform')
        .setRequired(true)
        .addChoices(
          { name: 'Twitch', value: 'twitch' },
          { name: 'YouTube', value: 'youtube' },
          { name: 'Kick', value: 'kick' },
          { name: 'TikTok', value: 'tiktok' }
        )
    )
    .addStringOption(option =>
      option
        .setName('username')
        .setDescription('Streamer username on that platform')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('display_name')
        .setDescription('Display name for grouping (defaults to username)')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const platform = interaction.options.getString('platform');
    const username = interaction.options.getString('username');
    const displayName = interaction.options.getString('display_name') || username;

    ensureGuild(interaction.guildId);

    // Check TikTok tier gate
    if (PAID_PLATFORMS.includes(platform)) {
      const tikTokCheck = canAddTikTok(interaction.guildId);
      if (tikTokCheck.requiresUpgrade) {
        return interaction.reply({
          content: `TikTok live detection requires a paid tier. Use \`/upgrade\` to see available plans.`,
          ephemeral: true
        });
      }
      if (!tikTokCheck.allowed) {
        return interaction.reply({
          content: `You've reached your TikTok streamer limit (${tikTokCheck.current}/${tikTokCheck.max}). Upgrade your plan for more slots.`,
          ephemeral: true
        });
      }
    }

    // Check streamer slot limit
    const streamerCheck = canAddStreamer(interaction.guildId);
    if (!streamerCheck.allowed) {
      return interaction.reply({
        content: `You've reached your streamer limit (${streamerCheck.current}/${streamerCheck.max} on ${streamerCheck.tier} tier). Use \`/upgrade\` to get more slots.`,
        ephemeral: true
      });
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
      addStreamer(interaction.guildId, displayName, platform, finalUsername);
      logger.info(`Guild ${interaction.guildId}: added ${displayName} on ${platform} (${finalUsername})`);

      if (platform === 'youtube' && finalUserId) {
        getDb().prepare(`
          UPDATE streamer_platforms SET platform_user_id = ?
          WHERE streamer_id = (SELECT id FROM streamers WHERE guild_id = ? AND display_name = ? COLLATE NOCASE)
            AND platform = 'youtube'
        `).run(finalUserId, interaction.guildId, displayName);
      }

      // If platform is Twitch, resolve user ID and subscribe to EventSub
      if (platform === 'twitch') {
        try {
          const twitchUser = await getTwitchUserId(finalUsername);
          // Save the Twitch user ID to the platform entry
          const db = getDb();
          db.prepare(`
            UPDATE streamer_platforms SET platform_user_id = ?
            WHERE streamer_id = (
              SELECT id FROM streamers WHERE guild_id = ? AND display_name = ? COLLATE NOCASE
            ) AND platform = 'twitch'
          `).run(twitchUser.id, interaction.guildId, displayName);

          // Subscribe to EventSub events
          await subscribeToStreamEvents(twitchUser.id);
        } catch (twitchError) {
          logger.warn(`Could not set up Twitch EventSub for ${finalUsername}: ${twitchError.message}`);
          // Don't fail the whole add — the streamer is saved, EventSub can be retried
        }
      }

      await interaction.reply(`Added **${displayName}** on ${PLATFORM_LABELS[platform]} (\`${finalUsername}\`). I'll announce when they go live.`);
    } catch (err) {
      await interaction.reply({ content: err.message, ephemeral: true });
    }
  }
};
