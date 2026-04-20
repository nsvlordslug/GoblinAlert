const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { removeStreamer, getDb, countStreamersByYoutubeChannel } = require('../db/database');
const { unsubscribeFromStreamEvents } = require('../platforms/twitchEventSub');
const youtubePubSub = require('../platforms/youtubePubSub');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a streamer from the watchlist entirely')
    .addStringOption(option =>
      option
        .setName('name')
        .setDescription('Display name of the streamer to remove')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const name = interaction.options.getString('name');

    // Get Twitch and YouTube platform entries before removing (need IDs for unsubscribe)
    const db = getDb();
    const streamerRow = db.prepare('SELECT id FROM streamers WHERE guild_id = ? AND display_name = ? COLLATE NOCASE').get(interaction.guildId, name);
    let youtubeChannelIdsToCheck = [];
    if (streamerRow) {
      const twitchPlatforms = db.prepare(
        "SELECT * FROM streamer_platforms WHERE streamer_id = ? AND platform = 'twitch' AND platform_user_id IS NOT NULL"
      ).all(streamerRow.id);

      // Check if any other guilds are tracking the same Twitch user
      for (const tp of twitchPlatforms) {
        const otherGuilds = db.prepare(`
          SELECT COUNT(*) as count FROM streamer_platforms sp
          JOIN streamers s ON sp.streamer_id = s.id
          WHERE sp.platform_user_id = ? AND sp.platform = 'twitch' AND s.guild_id != ?
        `).get(tp.platform_user_id, interaction.guildId);

        // Only unsubscribe if no other guilds are tracking this user
        if (otherGuilds.count === 0) {
          try {
            await unsubscribeFromStreamEvents(tp.platform_user_id);
          } catch (err) {
            logger.warn(`Failed to unsubscribe EventSub for ${tp.platform_username}: ${err.message}`);
          }
        }
      }

      // Capture YouTube channel IDs for post-delete orphan check
      const youtubeRows = db.prepare(
        "SELECT DISTINCT platform_user_id FROM streamer_platforms WHERE streamer_id = ? AND platform = 'youtube' AND platform_user_id IS NOT NULL"
      ).all(streamerRow.id);
      youtubeChannelIdsToCheck = youtubeRows.map(r => r.platform_user_id);
    }

    const removed = removeStreamer(interaction.guildId, name);

    if (!removed) {
      return interaction.reply({ content: `No streamer found with the name "${name}".`, ephemeral: true });
    }

    logger.info(`Guild ${interaction.guildId}: removed streamer ${name}`);
    await interaction.reply(`Removed **${removed.display_name}** and all their platform links from the watchlist.`);

    for (const channelId of youtubeChannelIdsToCheck) {
      if (countStreamersByYoutubeChannel(channelId) === 0) {
        try {
          await youtubePubSub.unsubscribe(channelId);
        } catch (err) {
          logger.warn(`Failed to unsubscribe from YouTube channel ${channelId}: ${err.message}`);
        }
      }
    }
  }
};
