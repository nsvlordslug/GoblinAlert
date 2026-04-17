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
    ensureGuild(interaction.guildId);
    setAnnouncementChannel(interaction.guildId, channel.id);
    logger.info(`Guild ${interaction.guildId}: announcement channel set to #${channel.name} (${channel.id})`);
    await interaction.reply(`Go-live announcements will be posted in ${channel}. You're all set — start adding streamers with \`/add\`.`);
  }
};
