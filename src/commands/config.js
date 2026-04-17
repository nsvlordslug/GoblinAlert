const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getGuild, updateGuildConfig, ensureGuild } = require('../db/database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('View or change announcement settings')
    .addStringOption(option =>
      option
        .setName('setting')
        .setDescription('Setting to change')
        .setRequired(false)
        .addChoices(
          { name: 'Delete alert when stream ends', value: 'delete_on_end' },
          { name: 'Combine multi-platform alerts', value: 'combine_multi_platform' },
          { name: 'Show viewer count', value: 'show_viewer_count' },
          { name: 'Update embed while live', value: 'update_while_live' }
        )
    )
    .addBooleanOption(option =>
      option.setName('value').setDescription('Enable or disable').setRequired(false)
    )
    .addRoleOption(option =>
      option.setName('ping_role').setDescription('Role to ping on go-live').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    ensureGuild(interaction.guildId);

    const setting = interaction.options.getString('setting');
    const value = interaction.options.getBoolean('value');
    const pingRole = interaction.options.getRole('ping_role');

    // Handle updates
    if (pingRole) {
      updateGuildConfig(interaction.guildId, 'ping_role_id', pingRole.id);
    }
    if (setting && value !== null) {
      updateGuildConfig(interaction.guildId, setting, value ? 1 : 0);
    }

    // Show current config
    const guild = getGuild(interaction.guildId);
    const onOff = v => v ? 'On' : 'Off';
    const channel = guild.announcement_channel_id ? `<#${guild.announcement_channel_id}>` : 'Not set';
    const role = guild.ping_role_id ? `<@&${guild.ping_role_id}>` : 'None';

    const embed = new EmbedBuilder()
      .setTitle('GoblinAlert settings')
      .setColor(0x5865F2)
      .setDescription([
        `**Announcement channel:** ${channel}`,
        `**Ping role:** ${role}`,
        `**Delete alert when stream ends:** ${onOff(guild.delete_on_end)}`,
        `**Combine multi-platform alerts:** ${onOff(guild.combine_multi_platform)}`,
        `**Show viewer count:** ${onOff(guild.show_viewer_count)}`,
        `**Update embed while live:** ${onOff(guild.update_while_live)}`
      ].join('\n'));

    const replyText = (setting || pingRole) ? 'Settings updated.' : '';
    await interaction.reply({ content: replyText || undefined, embeds: [embed] });
  }
};
