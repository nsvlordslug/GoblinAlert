const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getGuildTier } = require('../services/tierGate');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('upgrade')
    .setDescription('View available subscription tiers'),

  async execute(interaction) {
    const currentTier = getGuildTier(interaction.guildId);

    const embed = new EmbedBuilder()
      .setTitle('GoblinAlert plans')
      .setColor(0x5865F2)
      .setDescription(`You're currently on the **${currentTier.name}** tier.`)
      .addFields(
        { name: 'Free', value: '25 streamers\nTwitch + YouTube + Kick', inline: true },
        { name: 'Plus — $3/mo', value: '50 streamers\nTwitch + YouTube + Kick', inline: true }
      )
      .setFooter({ text: 'More platforms and tiers coming soon. Subscriptions are managed through Discord.' });

    // TODO: Add premium button components once SKUs are created in Discord Dev Portal
    // For now just show the info embed
    await interaction.reply({ embeds: [embed] });
  }
};
