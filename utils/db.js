const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// ─── Paths ───────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'bot.db');
const OLD_CHANNELS_PATH = path.join(__dirname, '..', 'channels.json');
const OLD_LAST_VIDEO_PATH = path.join(DATA_DIR, 'lastVideo.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Connection ──────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // safe concurrent reads while writing, and
                                  // crash-safe: a partial write can never
                                  // corrupt the database like a raw
                                  // fs.writeFileSync to a JSON file could.

db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    guild_id           TEXT NOT NULL,
    name               TEXT NOT NULL,
    youtube_channel_id TEXT NOT NULL,
    data               TEXT NOT NULL, -- full config object, JSON-encoded
    PRIMARY KEY (guild_id, name)
  );

  CREATE INDEX IF NOT EXISTS idx_subscriptions_youtube_channel_id
    ON subscriptions (youtube_channel_id);

  CREATE TABLE IF NOT EXISTS last_videos (
    guild_id  TEXT NOT NULL,
    name      TEXT NOT NULL,
    video_ids TEXT NOT NULL, -- JSON array of recent video IDs, newest first
    PRIMARY KEY (guild_id, name)
  );

  CREATE TABLE IF NOT EXISTS logs (
    guild_id          TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    action            TEXT NOT NULL,
    subscription_name TEXT,
    channel_name      TEXT,
    youtube_channel_id TEXT,
    discord_channel_id TEXT,
    role_id           TEXT,
    actor_id          TEXT,
    actor_tag         TEXT,
    details           TEXT,
    PRIMARY KEY (guild_id, created_at)
  );
`);

// ─── One-time migration from the old channels.json / lastVideo.json ──

function migrateFromJsonIfNeeded() {
  const alreadyHasData = db.prepare('SELECT COUNT(*) AS c FROM subscriptions').get().c > 0;
  if (alreadyHasData) return;

  let oldChannels = {};
  let oldLastVideos = {};

  try {
    if (fs.existsSync(OLD_CHANNELS_PATH)) {
      oldChannels = JSON.parse(fs.readFileSync(OLD_CHANNELS_PATH, 'utf8'));
    }
  } catch (err) {
    console.warn('[DB] Could not parse legacy channels.json, skipping migration of it:', err.message);
  }

  try {
    if (fs.existsSync(OLD_LAST_VIDEO_PATH)) {
      oldLastVideos = JSON.parse(fs.readFileSync(OLD_LAST_VIDEO_PATH, 'utf8'));
    }
  } catch (err) {
    console.warn('[DB] Could not parse legacy lastVideo.json, skipping migration of it:', err.message);
  }

  const guildIds = Object.keys(oldChannels);
  if (guildIds.length === 0) return; // nothing to migrate

  console.log('[DB] Migrating legacy JSON storage into SQLite (data/bot.db)...');

  const insertSub = db.prepare(`
    INSERT OR REPLACE INTO subscriptions (guild_id, name, youtube_channel_id, data)
    VALUES (@guildId, @name, @youtubeChannelId, @data)
  `);
  const insertLastVideo = db.prepare(`
    INSERT OR REPLACE INTO last_videos (guild_id, name, video_ids)
    VALUES (@guildId, @name, @videoIds)
  `);

  const migrate = db.transaction(() => {
    let subCount = 0;
    for (const guildId of guildIds) {
      const guildSubs = oldChannels[guildId];
      if (!guildSubs || typeof guildSubs !== 'object') continue;

      for (const [name, config] of Object.entries(guildSubs)) {
        insertSub.run({
          guildId,
          name,
          youtubeChannelId: config.youtubeChannelId || '',
          data: JSON.stringify(config),
        });
        subCount++;
      }

      const guildLastVideos = oldLastVideos[guildId];
      if (guildLastVideos && typeof guildLastVideos === 'object') {
        for (const [name, ids] of Object.entries(guildLastVideos)) {
          const arr = Array.isArray(ids) ? ids : typeof ids === 'string' ? [ids] : [];
          insertLastVideo.run({ guildId, name, videoIds: JSON.stringify(arr) });
        }
      }
    }
    return subCount;
  });

  const migratedCount = migrate();
  console.log(`[DB] ✅ Migrated ${migratedCount} subscription(s) across ${guildIds.length} guild(s).`);

  // Back up and remove the old files so we don't re-migrate / accidentally
  // read stale data from them again.
  try {
    if (fs.existsSync(OLD_CHANNELS_PATH)) {
      fs.renameSync(OLD_CHANNELS_PATH, `${OLD_CHANNELS_PATH}.migrated-backup`);
    }
    if (fs.existsSync(OLD_LAST_VIDEO_PATH)) {
      fs.renameSync(OLD_LAST_VIDEO_PATH, `${OLD_LAST_VIDEO_PATH}.migrated-backup`);
    }
    console.log('[DB] Legacy JSON files renamed to *.migrated-backup (safe to delete once you\'ve verified the bot works).');
  } catch (err) {
    console.warn('[DB] Could not rename legacy JSON files after migration:', err.message);
  }
}

migrateFromJsonIfNeeded();

// ─── Compatibility API ─────────────────────────────────────────────────
// These four functions intentionally mirror the exact shape of the old
// fs-based helpers in checker.js ({ guildId: { name: config } } / { guildId:
// { name: [videoIds] } }) so nothing else in the codebase has to change.

function loadChannels() {
  const rows = db.prepare('SELECT guild_id, name, data FROM subscriptions').all();
  const result = {};
  for (const row of rows) {
    if (!result[row.guild_id]) result[row.guild_id] = {};
    try {
      result[row.guild_id][row.name] = JSON.parse(row.data);
    } catch {
      // skip corrupt row rather than crash the whole load
    }
  }
  return result;
}

function saveChannels(data) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO subscriptions (guild_id, name, youtube_channel_id, data)
    VALUES (@guildId, @name, @youtubeChannelId, @data)
  `);
  const deleteAll = db.prepare('DELETE FROM subscriptions');

  const tx = db.transaction((data) => {
    deleteAll.run();
    for (const [guildId, guildSubs] of Object.entries(data)) {
      if (!guildSubs || typeof guildSubs !== 'object') continue;
      for (const [name, config] of Object.entries(guildSubs)) {
        insert.run({
          guildId,
          name,
          youtubeChannelId: config.youtubeChannelId || '',
          data: JSON.stringify(config),
        });
      }
    }
  });

  tx(data); // atomic: either the whole write lands, or none of it does
}

function loadLastVideos() {
  const rows = db.prepare('SELECT guild_id, name, video_ids FROM last_videos').all();
  const result = {};
  for (const row of rows) {
    if (!result[row.guild_id]) result[row.guild_id] = {};
    try {
      result[row.guild_id][row.name] = JSON.parse(row.video_ids);
    } catch {
      result[row.guild_id][row.name] = [];
    }
  }
  return result;
}

function saveLastVideos(data) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO last_videos (guild_id, name, video_ids)
    VALUES (@guildId, @name, @videoIds)
  `);
  const deleteAll = db.prepare('DELETE FROM last_videos');

  const tx = db.transaction((data) => {
    deleteAll.run();
    for (const [guildId, guildEntries] of Object.entries(data)) {
      if (!guildEntries || typeof guildEntries !== 'object') continue;
      for (const [name, ids] of Object.entries(guildEntries)) {
        const arr = Array.isArray(ids) ? ids : typeof ids === 'string' ? [ids] : [];
        insert.run({ guildId, name, videoIds: JSON.stringify(arr) });
      }
    }
  });

  tx(data);
}

module.exports = {
  db, // exposed for future steps (e.g. querying by youtube_channel_id for dedup)
  loadChannels,
  saveChannels,
  loadLastVideos,
  saveLastVideos,
  loadLogs,
  appendLogEntry,
};

function loadLogs() {
  const rows = db.prepare(`SELECT guild_id, created_at, action, subscription_name, channel_name, youtube_channel_id, discord_channel_id, role_id, actor_id, actor_tag, details FROM logs ORDER BY created_at DESC`).all();
  const result = {};
  for (const row of rows) {
    if (!result[row.guild_id]) result[row.guild_id] = [];
    result[row.guild_id].push({
      createdAt: row.created_at,
      action: row.action,
      subscriptionName: row.subscription_name,
      channelName: row.channel_name,
      youtubeChannelId: row.youtube_channel_id,
      discordChannelId: row.discord_channel_id,
      roleId: row.role_id,
      actorId: row.actor_id,
      actorTag: row.actor_tag,
      details: row.details,
    });
  }
  return result;
}

function appendLogEntry(guildId, entry) {
  const insert = db.prepare(`INSERT INTO logs (guild_id, created_at, action, subscription_name, channel_name, youtube_channel_id, discord_channel_id, role_id, actor_id, actor_tag, details) VALUES (@guildId, @createdAt, @action, @subscriptionName, @channelName, @youtubeChannelId, @discordChannelId, @roleId, @actorId, @actorTag, @details)`);
  const createdAt = new Date().toISOString();
  insert.run({
    guildId,
    createdAt,
    action: entry.action || 'update',
    subscriptionName: entry.subscriptionName || entry.subscriptionName || null,
    channelName: entry.channelName || null,
    youtubeChannelId: entry.youtubeChannelId || null,
    discordChannelId: entry.discordChannelId || null,
    roleId: entry.roleId || null,
    actorId: entry.actorId || null,
    actorTag: entry.actorTag || null,
    details: entry.details || null,
  });
}
