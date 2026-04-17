const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { PLATFORM_COLORS, PLATFORM_LABELS } = require('../utils/constants');
const { getDb } = require('../db/database');
const logger = require('../utils/logger');

function getPlatformUrl(platform, username) {
  switch (platform) {
    case 'twitch': return `https://twitch.tv/${username}`;
    case 'youtube': return `https://youtube.com/@${username}/live`;
    case 'kick': return `https://kick.com/${username}`;
    case 'tiktok': return `https://tiktok.com/@${username}/live`;
    default: return null;
  }
}

function buildEmbed(streamer, livePlatforms, streamDetails, ended = false) {
  const primaryPlatform = livePlatforms[0]?.platform || 'twitch';

  const embed = new EmbedBuilder()
    .setTimestamp();

  if (ended) {
    embed.setColor(0x808080);
    embed.setAuthor({ name: `${streamer.display_name} was live` });
    embed.setTitle(streamDetails?.title || 'Stream ended');
    embed.setFooter({ text: 'GoblinAlert · Stream ended' });
  } else {
    embed.setColor(PLATFORM_COLORS[primaryPlatform] || 0x5865F2);
    embed.setAuthor({ name: `${streamer.display_name} is live` });
    embed.setTitle(streamDetails?.title || 'Live now!');

    const platformCount = livePlatforms.length;
    const footerParts = ['GoblinAlert'];
    footerParts.push(`Live on ${platformCount} platform${platformCount > 1 ? 's' : ''}`);
    embed.setFooter({ text: footerParts.join(' · ') });
  }

  // Fields
  const fields = [];
  if (streamDetails?.game) {
    fields.push({ name: 'Game', value: streamDetails.game, inline: true });
  }

  if (!ended) {
    const totalViewers = streamDetails?.viewerCount || 0;
    if (totalViewers > 0) {
      fields.push({ name: 'Viewers', value: totalViewers.toLocaleString(), inline: true });
    }
  }

  if (streamDetails?.startedAt) {
    const startTime = Math.floor(new Date(streamDetails.startedAt).getTime() / 1000);
    fields.push({ name: 'Started', value: `<t:${startTime}:R>`, inline: true });
  }

  if (fields.length > 0) embed.addFields(fields);

  // Thumbnail
  if (streamDetails?.thumbnailUrl) {
    // Add cache buster to force Discord to refresh the thumbnail
    embed.setImage(streamDetails.thumbnailUrl + `?cb=${Date.now()}`);
  }

  return embed;
}

function buildButtons(livePlatforms) {
  if (livePlatforms.length === 0) return null;

  const row = new ActionRowBuilder();

  for (const p of livePlatforms) {
    const url = getPlatformUrl(p.platform, p.platform_username);
    if (url) {
      row.addComponents(
        new ButtonBuilder()
          .setLabel(PLATFORM_LABELS[p.platform])
          .setStyle(ButtonStyle.Link)
          .setURL(url)
      );
    }
  }

  return row.components.length > 0 ? row : null;
}

/**
 * Send a new go-live announcement
 */
async function sendAnnouncement(discordClient, streamer, livePlatforms, streamDetails, guild) {
  try {
    const channel = await discordClient.channels.fetch(guild.announcement_channel_id);
    if (!channel) {
      logger.error(`Could not find channel ${guild.announcement_channel_id}`);
      return;
    }

    const embed = buildEmbed(streamer, livePlatforms, streamDetails);
    const buttons = buildButtons(livePlatforms);

    // Build message content (role ping)
    let content = '';
    if (guild.ping_role_id) {
      content = `<@&${guild.ping_role_id}> **${streamer.display_name}** is now live!`;
    } else {
      content = `**${streamer.display_name}** is now live!`;
    }

    const messagePayload = {
      content,
      embeds: [embed]
    };
    if (buttons) messagePayload.components = [buttons];

    const message = await channel.send(messagePayload);

    // Store the announcement reference
    const db = getDb();
    db.prepare(`
      INSERT INTO announcements (guild_id, streamer_id, message_id, channel_id)
      VALUES (?, ?, ?, ?)
    `).run(guild.guild_id, streamer.streamer_id, message.id, channel.id);

    logger.info(`Announcement sent: ${message.id} for ${streamer.display_name} in guild ${guild.guild_id}`);
  } catch (error) {
    logger.error(`Failed to send announcement for ${streamer.display_name}:`, error);
  }
}

/**
 * Update an existing announcement (add/remove platforms, update viewer count, or mark ended)
 */
async function updateAnnouncement(discordClient, announcement, streamer, livePlatforms, streamDetails, guild, ended = false) {
  try {
    const channel = await discordClient.channels.fetch(announcement.channel_id);
    if (!channel) return;

    const message = await channel.messages.fetch(announcement.message_id);
    if (!message) return;

    const embed = buildEmbed(streamer, livePlatforms, streamDetails, ended);
    const buttons = buildButtons(livePlatforms);

    const editPayload = { embeds: [embed] };
    if (buttons) {
      editPayload.components = [buttons];
    } else {
      editPayload.components = [];
    }

    await message.edit(editPayload);

    // If ended and not deleting, remove the announcement record so future streams create a new one
    if (ended) {
      const db = getDb();
      db.prepare('DELETE FROM announcements WHERE id = ?').run(announcement.id);
    }

    logger.info(`Announcement updated: ${announcement.message_id} for ${streamer.display_name}`);
  } catch (error) {
    // Message might have been deleted manually
    if (error.code === 10008) {
      const db = getDb();
      db.prepare('DELETE FROM announcements WHERE id = ?').run(announcement.id);
      logger.warn(`Announcement message ${announcement.message_id} was already deleted`);
    } else {
      logger.error(`Failed to update announcement ${announcement.message_id}:`, error);
    }
  }
}

/**
 * Delete an announcement message (when delete_on_end is enabled)
 */
async function deleteAnnouncement(discordClient, announcement) {
  try {
    const channel = await discordClient.channels.fetch(announcement.channel_id);
    if (!channel) return;

    const message = await channel.messages.fetch(announcement.message_id);
    if (message) await message.delete();

    const db = getDb();
    db.prepare('DELETE FROM announcements WHERE id = ?').run(announcement.id);

    logger.info(`Announcement deleted: ${announcement.message_id}`);
  } catch (error) {
    if (error.code === 10008) {
      const db = getDb();
      db.prepare('DELETE FROM announcements WHERE id = ?').run(announcement.id);
    } else {
      logger.error(`Failed to delete announcement ${announcement.message_id}:`, error);
    }
  }
}

module.exports = { sendAnnouncement, updateAnnouncement, deleteAnnouncement, buildEmbed, buildButtons, getPlatformUrl };
