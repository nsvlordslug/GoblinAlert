const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { setAnnouncementChannel, ensureGuild } = require('../db/database');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Set the channel for go-live announcements')
    .addChannelOption(option =>
      option
        .setName('channel')
        .setDescription('The channel to post go-live alerts in')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel');

    try {
      await channel.send({
        content: `:white_check_mark: **GoblinAlert setup test** — I can post in ${channel}. Go-live announcements will appear here. You can delete this message.`
      });
    } catch (error) {
      const reason = error?.code === 50001
        ? 'I don\'t have access to that channel (Missing Access). Check that my role has `View Channel` on it.'
        : error?.code === 50013
        ? 'I\'m missing permissions on that channel. I need `View Channel`, `Send Messages`, and `Embed Links`.'
        : `Discord API error: ${error?.message || 'unknown'}.`;
      logger.warn(`Guild ${interaction.guildId}: setup test failed for #${channel.name} — ${error?.message}`);
      await interaction.reply({
        content:
          `:x: I can't post in ${channel}.\n\n` +
          `**Reason:** ${reason}\n\n` +
          `Fix the permissions or pick a different channel, then run \`/setup\` again. Your existing configuration was **not** changed.`,
        ephemeral: true
      });
      return;
    }

    ensureGuild(interaction.guildId);
    setAnnouncementChannel(interaction.guildId, channel.id);
    logger.info(`Guild ${interaction.guildId}: announcement channel set to #${channel.name} (${channel.id})`);
    await interaction.reply(`Go-live announcements will be posted in ${channel}. You're all set — start adding streamers with \`/add\`. (Test message posted above; you can delete it.)`);
  }
};
