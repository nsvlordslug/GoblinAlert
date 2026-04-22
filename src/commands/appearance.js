const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const logger = require('../utils/logger');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function urlToDataUri(url, label) {
  let response;
  try {
    response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      maxContentLength: MAX_IMAGE_BYTES + 1,
      validateStatus: s => s >= 200 && s < 300
    });
  } catch (err) {
    const status = err.response?.status;
    if (status) throw new Error(`Couldn't download ${label}: HTTP ${status} from that URL.`);
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') throw new Error(`Couldn't resolve ${label} URL — check the domain.`);
    if (err.message?.includes('maxContentLength')) throw new Error(`${label} image is over 10 MB. Discord's limit is 10 MB.`);
    throw new Error(`Couldn't download ${label}: ${err.message}`);
  }

  const contentType = (response.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error(`That ${label} URL doesn't return an image (got Content-Type: ${contentType || 'unknown'}).`);
  }
  if (response.data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`${label} image is over 10 MB. Discord's limit is 10 MB.`);
  }

  const base64 = Buffer.from(response.data).toString('base64');
  return `data:${contentType};base64,${base64}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('appearance')
    .setDescription('Customize the bot\'s avatar and banner for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub
        .setName('set')
        .setDescription('Set a custom avatar and/or banner for this server')
        .addStringOption(opt =>
          opt.setName('avatar')
            .setDescription('URL of an image (PNG/JPG/GIF, 10 MB max) to use as the avatar in this server')
            .setRequired(false))
        .addStringOption(opt =>
          opt.setName('banner')
            .setDescription('URL of an image (PNG/JPG/GIF, 10 MB max) to use as the banner in this server')
            .setRequired(false))
    )
    .addSubcommand(sub =>
      sub
        .setName('reset')
        .setDescription('Reset the bot\'s avatar and banner to default for this server')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const me = interaction.guild?.members?.me;
    if (!me) {
      return interaction.reply({
        content: ':x: I couldn\'t locate my own member record in this guild.',
        ephemeral: true
      });
    }

    const rest = interaction.client.rest;
    const route = `/guilds/${interaction.guildId}/members/@me`;

    if (sub === 'reset') {
      await interaction.deferReply({ ephemeral: true });
      try {
        await rest.patch(route, { body: { avatar: null, banner: null } });
        logger.info(`Guild ${interaction.guildId}: appearance reset to default`);
        await interaction.editReply('Reset. My avatar and banner are back to the default in this server. It may take a minute for Discord to refresh the cache on every client.');
      } catch (err) {
        logger.warn(`Guild ${interaction.guildId}: appearance reset failed — ${err.message}`);
        await interaction.editReply(`:x: Couldn't reset appearance: ${err.message}`);
      }
      return;
    }

    // sub === 'set'
    const avatarUrl = interaction.options.getString('avatar');
    const bannerUrl = interaction.options.getString('banner');

    if (!avatarUrl && !bannerUrl) {
      return interaction.reply({
        content: 'Provide at least one of `avatar` or `banner`. Use `/appearance reset` to clear both.',
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const payload = {};
      if (avatarUrl) payload.avatar = await urlToDataUri(avatarUrl, 'avatar');
      if (bannerUrl) payload.banner = await urlToDataUri(bannerUrl, 'banner');

      await rest.patch(route, { body: payload });

      const changes = [];
      if (avatarUrl) changes.push('avatar');
      if (bannerUrl) changes.push('banner');
      logger.info(`Guild ${interaction.guildId}: appearance set (${changes.join(', ')})`);

      await interaction.editReply(
        `Updated. My ${changes.join(' and ')} in this server ${changes.length > 1 ? 'have' : 'has'} been changed. It may take a minute for Discord to refresh the cache on every client.`
      );
    } catch (err) {
      logger.warn(`Guild ${interaction.guildId}: appearance set failed — ${err.message}`, err.rawError || err);
      let hint = '';
      if (err.code === 50013 || err.status === 403) {
        hint = '\n\nI\'m missing permission to edit my own profile in this server.';
      } else if (err.message?.includes('Invalid Form Body') || err.status === 400) {
        hint = '\n\nDiscord rejected the image. Check that the URL points directly to a PNG/JPG/GIF (not a page that contains an image) and is under 10 MB.';
      }
      await interaction.editReply(`:x: Couldn't update appearance: ${err.message}${hint}`);
    }
  }
};
