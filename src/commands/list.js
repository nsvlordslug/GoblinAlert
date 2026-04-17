const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getStreamers, getGuild } = require('../db/database');
const { getGuildTier } = require('../services/tierGate');
const { PLATFORM_LABELS } = require('../utils/constants');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('list')
    .setDescription('Show all tracked streamers and their status'),

  async execute(interaction) {
    const streamers = getStreamers(interaction.guildId);
    const tier = getGuildTier(interaction.guildId);

    if (streamers.length === 0) {
      return interaction.reply({ content: 'No streamers tracked yet. Use `/add` to get started.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('Tracked streamers')
      .setColor(0x5865F2)
      .setFooter({ text: `${streamers.length}/${tier.maxStreamers} slots used · ${tier.name} tier` });

    const lines = streamers.map(s => {
      const platformTags = s.platforms.map(p => {
        const status = p.is_live ? '🟢' : '⚫';
        return `${status} ${PLATFORM_LABELS[p.platform]} (\`${p.platform_username}\`)`;
      }).join('\n    ');
      return `**${s.display_name}**\n    ${platformTags}`;
    });

    embed.setDescription(lines.join('\n\n'));
    await interaction.reply({ embeds: [embed] });
  }
};
