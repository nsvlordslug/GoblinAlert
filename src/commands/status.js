const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getStreamerCount } = require('../db/database');
const { getGuildTier } = require('../services/tierGate');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot status and tier info'),

  async execute(interaction) {
    const tier = getGuildTier(interaction.guildId);
    const streamerCount = getStreamerCount(interaction.guildId);

    const embed = new EmbedBuilder()
      .setTitle('GoblinAlert status')
      .setColor(0x5865F2)
      .addFields(
        { name: 'Current tier', value: tier.name, inline: true },
        { name: 'Streamers', value: `${streamerCount} / ${tier.maxStreamers}`, inline: true }
      )
      .setFooter({ text: 'Use /upgrade to see available plans' });

    await interaction.reply({ embeds: [embed] });
  }
};
