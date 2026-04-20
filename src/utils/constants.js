const TIERS = {
  FREE: {
    name: 'Free',
    maxStreamers: 25,
    maxTikTok: 0,
    skuId: null
  },
  PLUS: {
    name: 'Plus',
    maxStreamers: 50,
    maxTikTok: 0,
    skuId: 'PLUS_SKU_ID_HERE'  // Replace with actual SKU ID after creating in Discord Dev Portal
  },
  TIKTOK: {
    name: 'TikTok',
    maxStreamers: 25,
    maxTikTok: 5,
    skuId: 'TIKTOK_SKU_ID_HERE'
  },
  PRO: {
    name: 'Pro',
    maxStreamers: 50,
    maxTikTok: 5,
    skuId: 'PRO_SKU_ID_HERE'
  }
};

const PLATFORMS = {
  TWITCH: 'twitch',
  YOUTUBE: 'youtube',
  KICK: 'kick',
  TIKTOK: 'tiktok'
};

const PLATFORM_COLORS = {
  twitch: 0x9146FF,
  youtube: 0xFF0000,
  kick: 0x53FC18,
  tiktok: 0x010101
};

const PLATFORM_LABELS = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  kick: 'Kick',
  tiktok: 'TikTok'
};

const PLATFORM_EMOJIS = {
  twitch: { id: '1495701020678951013', name: 'twitchlogo' },
  youtube: { id: '1495700890110132336', name: 'ytlogo' },
  kick: { id: '1495701146671513600', name: 'kicklogo' },
  tiktok: { id: '1495701092783100005', name: 'tiktoklogo' }
};

// Free platforms (no tier needed)
const FREE_PLATFORMS = ['twitch', 'youtube', 'kick'];

// Paid platforms (require specific tier)
const PAID_PLATFORMS = ['tiktok'];

module.exports = { TIERS, PLATFORMS, PLATFORM_COLORS, PLATFORM_LABELS, PLATFORM_EMOJIS, FREE_PLATFORMS, PAID_PLATFORMS };
