const { TIERS } = require('../utils/constants');
const { getActiveEntitlement, getStreamerCount, getTikTokCount } = require('../db/database');

function getGuildTier(guildId) {
  const entitlement = getActiveEntitlement(guildId);
  if (!entitlement) return TIERS.FREE;

  // Match SKU ID to tier
  for (const tier of Object.values(TIERS)) {
    if (tier.skuId && tier.skuId === entitlement.sku_id) {
      return tier;
    }
  }
  return TIERS.FREE;
}

function canAddStreamer(guildId) {
  const tier = getGuildTier(guildId);
  const count = getStreamerCount(guildId);
  return {
    allowed: count < tier.maxStreamers,
    current: count,
    max: tier.maxStreamers,
    tier: tier.name
  };
}

function canAddTikTok(guildId) {
  const tier = getGuildTier(guildId);
  if (tier.maxTikTok === 0) {
    return { allowed: false, current: 0, max: 0, tier: tier.name, requiresUpgrade: true };
  }
  const count = getTikTokCount(guildId);
  return {
    allowed: count < tier.maxTikTok,
    current: count,
    max: tier.maxTikTok,
    tier: tier.name,
    requiresUpgrade: false
  };
}

module.exports = { getGuildTier, canAddStreamer, canAddTikTok };
