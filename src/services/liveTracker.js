const logger = require('../utils/logger');
const { getDb } = require('../db/database');
const { getStreamInfo } = require('../platforms/twitchEventSub');
const { sendAnnouncement, updateAnnouncement, deleteAnnouncement } = require('./announcer');

/**
 * Handle a streamer going live on a platform
 */
async function handleStreamOnline(platform, platformUserId, platformUsername, discordClient) {
  const db = getDb();

  // Find all streamer_platforms entries matching this platform + user
  const platformEntries = db.prepare(`
    SELECT sp.*, s.id as streamer_id, s.display_name, s.guild_id
    FROM streamer_platforms sp
    JOIN streamers s ON sp.streamer_id = s.id
    WHERE sp.platform = ? AND (sp.platform_user_id = ? OR sp.platform_username = ? COLLATE NOCASE)
    AND sp.announce_enabled = 1
  `).all(platform, platformUserId, platformUsername);

  if (platformEntries.length === 0) {
    logger.debug(`No tracked streamers found for ${platform}/${platformUsername}`);
    return;
  }

  for (const entry of platformEntries) {
    try {
      // Update platform_user_id if we didn't have it
      if (!entry.platform_user_id && platformUserId) {
        db.prepare('UPDATE streamer_platforms SET platform_user_id = ? WHERE id = ?').run(platformUserId, entry.id);
      }

      // Mark as live
      db.prepare('UPDATE streamer_platforms SET is_live = 1, last_live_at = CURRENT_TIMESTAMP WHERE id = ?').run(entry.id);

      // Get stream details
      let streamDetails = null;
      if (platform === 'twitch') {
        streamDetails = await getStreamInfo(platformUserId);
      }

      // Get guild config
      const guild = db.prepare('SELECT * FROM guilds WHERE guild_id = ?').get(entry.guild_id);
      if (!guild || !guild.announcement_channel_id) {
        logger.warn(`Guild ${entry.guild_id} has no announcement channel configured`);
        continue;
      }

      // Check if there's already an active announcement for this streamer in this guild
      const existingAnnouncement = db.prepare(
        'SELECT * FROM announcements WHERE guild_id = ? AND streamer_id = ?'
      ).get(entry.guild_id, entry.streamer_id);

      // Get all live platforms for this streamer
      const livePlatforms = db.prepare(`
        SELECT * FROM streamer_platforms
        WHERE streamer_id = ? AND is_live = 1
      `).all(entry.streamer_id);

      if (existingAnnouncement && guild.combine_multi_platform) {
        // Update existing announcement with new platform
        await updateAnnouncement(
          discordClient,
          existingAnnouncement,
          entry,
          livePlatforms,
          streamDetails,
          guild
        );
        logger.info(`Updated announcement for ${entry.display_name} in guild ${entry.guild_id} (added ${platform})`);
      } else if (!existingAnnouncement) {
        // Send new announcement
        await sendAnnouncement(
          discordClient,
          entry,
          livePlatforms,
          streamDetails,
          guild
        );
        logger.info(`Sent announcement for ${entry.display_name} in guild ${entry.guild_id} (${platform})`);
      }
    } catch (error) {
      logger.error(`Error handling stream.online for ${entry.display_name} in guild ${entry.guild_id}:`, error);
    }
  }
}

/**
 * Handle a streamer going offline on a platform
 */
async function handleStreamOffline(platform, platformUserId, platformUsername, discordClient) {
  const db = getDb();

  const platformEntries = db.prepare(`
    SELECT sp.*, s.id as streamer_id, s.display_name, s.guild_id
    FROM streamer_platforms sp
    JOIN streamers s ON sp.streamer_id = s.id
    WHERE sp.platform = ? AND (sp.platform_user_id = ? OR sp.platform_username = ? COLLATE NOCASE)
  `).all(platform, platformUserId, platformUsername);

  if (platformEntries.length === 0) return;

  for (const entry of platformEntries) {
    try {
      // Mark as offline
      db.prepare('UPDATE streamer_platforms SET is_live = 0 WHERE id = ?').run(entry.id);

      // Get guild config
      const guild = db.prepare('SELECT * FROM guilds WHERE guild_id = ?').get(entry.guild_id);
      if (!guild) continue;

      // Check remaining live platforms for this streamer
      const livePlatforms = db.prepare(`
        SELECT * FROM streamer_platforms
        WHERE streamer_id = ? AND is_live = 1
      `).all(entry.streamer_id);

      // Get existing announcement
      const existingAnnouncement = db.prepare(
        'SELECT * FROM announcements WHERE guild_id = ? AND streamer_id = ?'
      ).get(entry.guild_id, entry.streamer_id);

      if (!existingAnnouncement) continue;

      if (livePlatforms.length === 0) {
        // All platforms offline
        if (guild.delete_on_end) {
          await deleteAnnouncement(discordClient, existingAnnouncement);
          logger.info(`Deleted announcement for ${entry.display_name} in guild ${entry.guild_id} (all platforms offline)`);
        } else {
          // Update embed to show "Stream ended"
          await updateAnnouncement(
            discordClient,
            existingAnnouncement,
            entry,
            [],
            null,
            guild,
            true // ended
          );
          logger.info(`Marked announcement as ended for ${entry.display_name} in guild ${entry.guild_id}`);
        }
      } else if (guild.combine_multi_platform && guild.update_while_live) {
        // Some platforms still live — update the embed to remove this platform's button
        await updateAnnouncement(
          discordClient,
          existingAnnouncement,
          entry,
          livePlatforms,
          null,
          guild
        );
        logger.info(`Updated announcement for ${entry.display_name} in guild ${entry.guild_id} (removed ${platform})`);
      }
    } catch (error) {
      logger.error(`Error handling stream.offline for ${entry.display_name} in guild ${entry.guild_id}:`, error);
    }
  }
}

module.exports = { handleStreamOnline, handleStreamOffline };
