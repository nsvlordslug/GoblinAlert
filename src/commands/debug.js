const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { listSubscriptions } = require('../platforms/twitchEventSub');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('debug')
    .setDescription('Show Twitch EventSub subscription status (dev only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const subs = await listSubscriptions();
    if (!subs) {
      return interaction.editReply('Failed to fetch EventSub subscriptions.');
    }

    const lines = subs.data.map(s =>
      `**${s.type}** → ${s.condition.broadcaster_user_id} (${s.status})`
    );

    const response = lines.length > 0
      ? `**EventSub Subscriptions (${subs.total}):**\n${lines.join('\n')}`
      : 'No active EventSub subscriptions.';

    await interaction.editReply(response.substring(0, 2000));
  }
};
