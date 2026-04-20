const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');

const DB_PATH = path.join(__dirname, '..', '..', 'goblinalert.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
    runMigrations();
    logger.info(`Database connected: ${DB_PATH}`);
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY,
      announcement_channel_id TEXT,
      ping_role_id TEXT,
      delete_on_end INTEGER DEFAULT 0,
      combine_multi_platform INTEGER DEFAULT 1,
      show_viewer_count INTEGER DEFAULT 1,
      update_while_live INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS streamers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS streamer_platforms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer_id INTEGER NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('twitch', 'youtube', 'kick', 'tiktok')),
      platform_username TEXT NOT NULL,
      platform_user_id TEXT,
      is_live INTEGER DEFAULT 0,
      last_live_at TEXT,
      announce_enabled INTEGER DEFAULT 1,
      FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE,
      UNIQUE(streamer_id, platform)
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      streamer_id INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id),
      FOREIGN KEY (streamer_id) REFERENCES streamers(id)
    );

    CREATE TABLE IF NOT EXISTS entitlements (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      sku_id TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      starts_at TEXT,
      ends_at TEXT,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
    );
  `);
}

/**
 * Run idempotent schema migrations. Safe to call on every boot.
 * Each migration checks current state with PRAGMA table_info before mutating.
 */
function runMigrations() {
  const streamerCols = db.prepare('PRAGMA table_info(streamers)').all();
  if (!streamerCols.some(c => c.name === 'custom_message')) {
    db.exec('ALTER TABLE streamers ADD COLUMN custom_message TEXT');
    logger.info('Migration: added streamers.custom_message column');
  }
}

// ─── Guild Operations ───

function ensureGuild(guildId) {
  const stmt = db.prepare('INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)');
  stmt.run(guildId);
  return db.prepare('SELECT * FROM guilds WHERE guild_id = ?').get(guildId);
}

function getGuild(guildId) {
  return getDb().prepare('SELECT * FROM guilds WHERE guild_id = ?').get(guildId);
}

function setAnnouncementChannel(guildId, channelId) {
  ensureGuild(guildId);
  getDb().prepare('UPDATE guilds SET announcement_channel_id = ? WHERE guild_id = ?').run(channelId, guildId);
}

function updateGuildConfig(guildId, field, value) {
  const allowedFields = ['ping_role_id', 'delete_on_end', 'combine_multi_platform', 'show_viewer_count', 'update_while_live'];
  if (!allowedFields.includes(field)) throw new Error(`Invalid config field: ${field}`);
  ensureGuild(guildId);
  getDb().prepare(`UPDATE guilds SET ${field} = ? WHERE guild_id = ?`).run(value, guildId);
}

function removeGuild(guildId) {
  getDb().prepare('DELETE FROM guilds WHERE guild_id = ?').run(guildId);
}

// ─── Streamer Operations ───

function addStreamer(guildId, displayName, platform, platformUsername) {
  ensureGuild(guildId);
  const db = getDb();

  // Check if this streamer already exists in this guild (by display name)
  let streamer = db.prepare('SELECT * FROM streamers WHERE guild_id = ? AND display_name = ? COLLATE NOCASE').get(guildId, displayName);

  if (!streamer) {
    const result = db.prepare('INSERT INTO streamers (guild_id, display_name) VALUES (?, ?)').run(guildId, displayName);
    streamer = { id: result.lastInsertRowid, guild_id: guildId, display_name: displayName };
  }

  // Add platform link
  try {
    db.prepare('INSERT INTO streamer_platforms (streamer_id, platform, platform_username) VALUES (?, ?, ?)').run(streamer.id, platform, platformUsername);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      throw new Error(`${displayName} already has a ${platform} link.`);
    }
    throw err;
  }

  return streamer;
}

function removeStreamer(guildId, displayName) {
  const db = getDb();
  const streamer = db.prepare('SELECT * FROM streamers WHERE guild_id = ? AND display_name = ? COLLATE NOCASE').get(guildId, displayName);
  if (!streamer) return null;
  db.prepare('DELETE FROM streamers WHERE id = ?').run(streamer.id);
  return streamer;
}

function linkPlatform(guildId, displayName, platform, platformUsername) {
  const db = getDb();
  const streamer = db.prepare('SELECT * FROM streamers WHERE guild_id = ? AND display_name = ? COLLATE NOCASE').get(guildId, displayName);
  if (!streamer) throw new Error(`Streamer "${displayName}" not found.`);

  try {
    db.prepare('INSERT INTO streamer_platforms (streamer_id, platform, platform_username) VALUES (?, ?, ?)').run(streamer.id, platform, platformUsername);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      throw new Error(`${displayName} already has a ${platform} link.`);
    }
    throw err;
  }
  return streamer;
}

function unlinkPlatform(guildId, displayName, platform) {
  const db = getDb();
  const streamer = db.prepare('SELECT * FROM streamers WHERE guild_id = ? AND display_name = ? COLLATE NOCASE').get(guildId, displayName);
  if (!streamer) throw new Error(`Streamer "${displayName}" not found.`);

  const result = db.prepare('DELETE FROM streamer_platforms WHERE streamer_id = ? AND platform = ?').run(streamer.id, platform);
  if (result.changes === 0) throw new Error(`${displayName} doesn't have a ${platform} link.`);

  // If no platforms left, remove the streamer entirely
  const remaining = db.prepare('SELECT COUNT(*) as count FROM streamer_platforms WHERE streamer_id = ?').get(streamer.id);
  if (remaining.count === 0) {
    db.prepare('DELETE FROM streamers WHERE id = ?').run(streamer.id);
  }

  return streamer;
}

function getStreamers(guildId) {
  const db = getDb();
  const streamers = db.prepare('SELECT * FROM streamers WHERE guild_id = ?').all(guildId);

  return streamers.map(s => {
    const platforms = db.prepare('SELECT * FROM streamer_platforms WHERE streamer_id = ?').all(s.id);
    return { ...s, platforms };
  });
}

function getStreamerCount(guildId) {
  return getDb().prepare('SELECT COUNT(*) as count FROM streamers WHERE guild_id = ?').get(guildId).count;
}

function getTikTokCount(guildId) {
  return getDb().prepare(`
    SELECT COUNT(*) as count FROM streamer_platforms sp
    JOIN streamers s ON sp.streamer_id = s.id
    WHERE s.guild_id = ? AND sp.platform = 'tiktok'
  `).get(guildId).count;
}

// ─── Entitlement Operations ───

function getActiveEntitlement(guildId) {
  return getDb().prepare('SELECT * FROM entitlements WHERE guild_id = ? AND is_active = 1').get(guildId);
}

function upsertEntitlement(id, guildId, skuId, isActive, startsAt, endsAt) {
  getDb().prepare(`
    INSERT INTO entitlements (id, guild_id, sku_id, is_active, starts_at, ends_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET is_active = ?, ends_at = ?
  `).run(id, guildId, skuId, isActive, startsAt, endsAt, isActive, endsAt);
}

module.exports = {
  getDb,
  ensureGuild,
  getGuild,
  setAnnouncementChannel,
  updateGuildConfig,
  removeGuild,
  addStreamer,
  removeStreamer,
  linkPlatform,
  unlinkPlatform,
  getStreamers,
  getStreamerCount,
  getTikTokCount,
  getActiveEntitlement,
  upsertEntitlement
};
