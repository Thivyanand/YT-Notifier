const { fetchLatestVideos, getVideoDetails, checkLiveViaDataAPI } = require('./youtube');
const { buildNotificationEmbed, buildActionRow } = require('./embeds');
const { loadChannels, saveChannels, loadLastVideos, saveLastVideos, loadLogs, appendLogEntry } = require('./db');
const websub = require('./websub');

// Storage now lives in data/bot.db (SQLite) instead of raw channels.json /
// data/lastVideo.json files — see utils/db.js. loadChannels/saveChannels/
// loadLastVideos/saveLastVideos keep the exact same shape as before, so
// everything below (and commands/yt.js) works unmodified. Existing JSON
// data is auto-migrated into SQLite the first time the bot starts.

// ─── Notification Sender ─────────────────────────────────────────────

/**
 * Send a notification embed to the configured Discord channel.
 */
async function sendNotification(client, config, videoDetails) {
  try {
    const channel = await client.channels.fetch(config.discordChannelId);
    if (!channel?.isTextBased()) {
      console.warn(`[Notifier] Channel ${config.discordChannelId} is not text-based, skipping.`);
      return;
    }

    const embed = buildNotificationEmbed(videoDetails, config);
    const row = buildActionRow(videoDetails);

    const messagePayload = {
      embeds: [embed],
      components: [row],
    };

    // Ping role if configured
    if (config.roleId) {
      messagePayload.content = `<@&${config.roleId}>`;
    }

    await channel.send(messagePayload);
    console.log(
      `[Notifier] ✅ Sent notification for "${videoDetails.title}" → #${channel.name}`
    );
  } catch (error) {
    console.error('[Notifier] ❌ Error sending notification:', error.message);
  }
}

// ─── Live Notification Cache ─────────────────────────────────────────

// Tracks live stream video IDs that have already been notified.
// Key: "guildId:subscriptionName:videoId", Value: timestamp when notified.
// Entries expire after 4 hours so a stream that ends and restarts can re-notify.
const liveNotifiedCache = new Map();
const LIVE_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function isLiveAlreadyNotified(key) {
  const ts = liveNotifiedCache.get(key);
  if (!ts) return false;
  if (Date.now() - ts > LIVE_CACHE_TTL_MS) {
    liveNotifiedCache.delete(key);
    return false;
  }
  return true;
}

function markLiveNotified(key) {
  liveNotifiedCache.set(key, Date.now());
}

// ─── Shared: unique-channel → subscribers map ─────────────────────────
//
// Multiple Discord servers (or multiple subscriptions within one server)
// can point at the same YouTube channel. We only ever want to fetch/process
// each unique YouTube channel once per cycle (or once per push) and fan the
// result out to every subscriber of it. Used by polling, the live checker,
// and WebSub push — previously duplicated inline in two places.
function buildChannelToSubscribers(channels) {
  const map = new Map(); // youtubeChannelId -> [{ guildId, name, config }]
  for (const guildId of Object.keys(channels)) {
    const guildSubs = channels[guildId];
    if (!guildSubs || typeof guildSubs !== 'object') continue;

    for (const [name, config] of Object.entries(guildSubs)) {
      if (!config?.youtubeChannelId) continue;
      if (!map.has(config.youtubeChannelId)) {
        map.set(config.youtubeChannelId, []);
      }
      map.get(config.youtubeChannelId).push({ guildId, name, config });
    }
  }
  return map;
}

// ─── Shared: process one "new video" event for every subscriber of a channel ──
//
// This is the single code path used by BOTH the RSS/Data-API poller
// (checkForNewVideos) and the WebSub push callback, so a new upload is
// handled identically no matter which route detected it: same seed-on-first-
// run behavior, same 24h-old skip guard, same per-channel details caching,
// same last-seen-video persistence. Previously this logic only existed
// inline inside the polling loop; extracting it here is what lets WebSub
// push notifications reuse it instead of duplicating (and risking drifting
// from) the polling behavior.
//
// `video` shape: { id, title, link, published, author, isLiveHint? }
async function processNewVideoForSubscribers(client, youtubeChannelId, video) {
  const channels = loadChannels();
  const lastVideos = loadLastVideos();
  const channelToSubscribers = buildChannelToSubscribers(channels);
  const subscribers = channelToSubscribers.get(youtubeChannelId);
  if (!subscribers || subscribers.length === 0) return;

  const latestVideoId = video.id;
  const publishedDate = video.published || new Date();
  const ageMs = Date.now() - publishedDate.getTime();
  const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours

  // Fetch full video details (Innertube) at most once per channel per
  // call, and only if at least one subscriber actually needs it —
  // computed lazily below and cached for reuse across subscribers.
  let cachedDetails = null;
  let detailsFetched = false;
  let changed = false;

  for (const { guildId, name, config } of subscribers) {
    if (!lastVideos[guildId]) {
      lastVideos[guildId] = {};
    }
    let previousVideoIds = lastVideos[guildId][name];
    if (typeof previousVideoIds === 'string') {
      previousVideoIds = [previousVideoIds];
    } else if (!Array.isArray(previousVideoIds)) {
      previousVideoIds = [];
    }

    // Skip if no change (already in recently notified list)
    if (previousVideoIds.includes(latestVideoId)) continue;

    // First run — seed the ID without notifying
    if (previousVideoIds.length === 0) {
      console.log(
        `[Checker] 🌱 Seeded "${name}" for guild ${guildId} with video ${latestVideoId} (no notification)`
      );
      lastVideos[guildId][name] = [latestVideoId];
      changed = true;
      continue;
    }

    // Skip if the video is too old (older than 24 hours) to prevent spamming notifications for old uploads/streams
    if (ageMs > maxAgeMs) {
      console.log(
        `[Checker] ℹ Video ${latestVideoId} for "${name}" is too old (${Math.round(ageMs / 3600000)}h), skipping notification.`
      );
      previousVideoIds.unshift(latestVideoId);
      if (previousVideoIds.length > 10) {
        previousVideoIds = previousVideoIds.slice(0, 10);
      }
      lastVideos[guildId][name] = previousVideoIds;
      changed = true;
      continue;
    }

    // New video detected! Fetch (and cache) details once per channel,
    // not once per subscriber.
    if (!detailsFetched) {
      console.log(`[Checker] 🆕 New video detected for ${youtubeChannelId}: ${latestVideoId} (notifying ${subscribers.length} subscriber(s))`);
      cachedDetails = await getVideoDetails(
        latestVideoId,
        video.title,
        video.author,
        video.isLiveHint || false
      );
      detailsFetched = true;
    }

    if (cachedDetails) {
      await sendNotification(client, config, cachedDetails);
    } else {
      // details will always be set now (getVideoDetails never returns null)
      // but guard defensively just in case
      console.warn(`[Checker] ⚠ Could not get details for video ${latestVideoId}`);
    }

    previousVideoIds.unshift(latestVideoId);
    if (previousVideoIds.length > 10) {
      previousVideoIds = previousVideoIds.slice(0, 10);
    }
    lastVideos[guildId][name] = previousVideoIds;
    changed = true;
  }

  if (changed) {
    saveLastVideos(lastVideos);
  }
}

// ─── Periodic Checker ────────────────────────────────────────────────────

/**
 * Check all subscriptions for new videos and send notifications.
 */
async function checkForNewVideos(client) {
  let channels = loadChannels();
  let lastVideos = loadLastVideos();
  let migrated = false;

  // Migration logic: convert flat structure to guild-scoped structure
  const rootKeys = Object.keys(channels);
  for (const key of rootKeys) {
    if (channels[key] && channels[key].youtubeChannelId) {
      const config = channels[key];
      let guildId = null;
      try {
        const channel = await client.channels.fetch(config.discordChannelId);
        guildId = channel?.guildId;
      } catch (err) {
        console.warn(`[Migration] Could not resolve channel ${config.discordChannelId} for subscription "${key}":`, err.message);
      }

      if (!guildId) {
        console.warn(`[Migration] Skipping migration for "${key}" because its guild ID couldn't be determined.`);
        continue;
      }

      if (!channels[guildId]) {
        channels[guildId] = {};
      }
      channels[guildId][key] = config;
      delete channels[key];

      // Migrate corresponding lastVideo entry
      if (lastVideos[key]) {
        if (!lastVideos[guildId]) {
          lastVideos[guildId] = {};
        }
        lastVideos[guildId][key] = lastVideos[key];
        delete lastVideos[key];
      }

      migrated = true;
    }
  }

  if (migrated) {
    saveChannels(channels);
    saveLastVideos(lastVideos);
    console.log('[Migration] ✅ Successfully migrated flat configurations to guild-scoped database structure.');
  }

  const guildIds = Object.keys(channels);
  if (guildIds.length === 0) return;

  // ── Build a map of unique YouTube channel → all subscribers of it ──
  // Multiple Discord servers (or multiple subscriptions within one server)
  // can point at the same YouTube channel. Previously each subscription was
  // checked independently, so N servers following the same channel meant N
  // RSS/Data-API calls for identical data every cycle — wasteful, and a
  // real quota risk now that RSS failures fall back to the Data API. Now we
  // fetch each unique channel exactly once and fan the result out to every
  // subscriber of it.
  const channelToSubscribers = buildChannelToSubscribers(channels);

  console.log(
    `[Checker] 🔎 Checking ${channelToSubscribers.size} unique YouTube channel(s) ` +
    `covering ${guildIds.reduce((sum, gid) => sum + Object.keys(channels[gid] || {}).length, 0)} subscription(s).`
  );

  for (const [youtubeChannelId, subscribers] of channelToSubscribers) {
    try {
      const videos = await fetchLatestVideos(youtubeChannelId, 1);
      if (videos.length === 0) {
        await sleep(2000);
        continue;
      }

      await processNewVideoForSubscribers(client, youtubeChannelId, videos[0]);
    } catch (error) {
      console.error(`[Checker] ❌ Error checking channel ${youtubeChannelId}:`, error.message);
    }

    // Small delay between unique channels (not per subscription) to avoid rate limits
    await sleep(2000);
  }

  // ── WebSub: make sure every currently-tracked channel has a live push
  // subscription, renew anything close to expiring, and drop subscriptions
  // for channels no longer followed by anyone. No-op if WebSub isn't
  // configured (see utils/websub.js / README-WEBSUB.md) — polling above
  // is unaffected either way, it's the permanent fallback.
  if (websub.isEnabled()) {
    websub.reconcileSubscriptions([...channelToSubscribers.keys()]).catch((err) => {
      console.error('[WebSub] Reconcile pass failed:', err.message);
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Live Stream Checker (every 10 minutes) ───────────────────────────

/**
 * Check all subscriptions for active live streams using YouTube Data API v3.
 * Sends a notification the first time a channel goes live (per stream).
 * Uses liveNotifiedCache to avoid re-notifying the same active stream.
 */
async function checkForLiveStreams(client) {
  const channels = loadChannels();
  const guildIds = Object.keys(channels);
  if (guildIds.length === 0) return;

  // Same dedup as checkForNewVideos: build unique-channel -> subscribers map
  // so a channel followed by 5 servers only costs 1 Data API call, not 5.
  const channelToSubscribers = buildChannelToSubscribers(channels);

  for (const [youtubeChannelId, subscribers] of channelToSubscribers) {
    try {
      const liveVideo = await checkLiveViaDataAPI(youtubeChannelId);
      if (!liveVideo) {
        await sleep(2000);
        continue; // channel is not live
      }

      for (const { guildId, name, config } of subscribers) {
        const cacheKey = `${guildId}:${name}:${liveVideo.id}`;
        if (isLiveAlreadyNotified(cacheKey)) continue; // already notified this stream

        console.log(`[LiveChecker] 🔴 Live stream detected for "${name}" in guild ${guildId}: ${liveVideo.id}`);

        // Enrich with config avatar
        const details = { ...liveVideo, channelId: liveVideo.channelId || youtubeChannelId };
        await sendNotification(client, config, details);
        markLiveNotified(cacheKey);
      }
    } catch (error) {
      console.error(`[LiveChecker] ❌ Error checking channel ${youtubeChannelId}:`, error.message);
    }

    // Small delay between unique channels (not per subscription)
    await sleep(2000);
  }
}

/**
 * Start the periodic checkers.
 * @param {Client} client       – Discord.js client
 * @param {number} intervalMs   – Video check interval in ms (default 30 000)
 * @param {number} liveIntervalMs – Live stream check interval in ms (default 600 000)
 * @returns {{ videoTimer: NodeJS.Timeout, liveTimer: NodeJS.Timeout }}
 */

// ─── Overlap guards ────────────────────────────────────────────────────
// With enough subscriptions (each check has a 2s delay between channels),
// one full cycle can take longer than the check interval itself — e.g. 40
// subscriptions × 2s = 80s+, but the default interval is only 30s. Without
// a guard, setInterval fires a new cycle before the previous one finishes,
// so you get multiple overlapping runs each working from a stale snapshot
// of "last seen video" and stepping on each other's writes — this is what
// was causing subscriptions to get repeatedly re-seeded. These wrappers
// make sure a cycle is skipped (not queued — just skipped) if the previous
// one is still in flight.

let videoCheckRunning = false;
let liveCheckRunning = false;

async function runVideoCheckSafely(client) {
  if (videoCheckRunning) {
    console.log('[Checker] ⏭ Skipping this video-check cycle — the previous one is still running. If you see this often, you likely have enough subscriptions that checks are taking longer than the interval; consider raising the interval or lowering the per-channel delay.');
    return;
  }
  videoCheckRunning = true;
  try {
    await checkForNewVideos(client);
  } catch (err) {
    console.error('[Checker] ❌ Unexpected error in video check cycle:', err);
  } finally {
    videoCheckRunning = false;
  }
}

async function runLiveCheckSafely(client) {
  if (liveCheckRunning) {
    console.log('[LiveChecker] ⏭ Skipping this live-check cycle — the previous one is still running.');
    return;
  }
  liveCheckRunning = true;
  try {
    await checkForLiveStreams(client);
  } catch (err) {
    console.error('[LiveChecker] ❌ Unexpected error in live check cycle:', err);
  } finally {
    liveCheckRunning = false;
  }
}

function startChecker(client, intervalMs = 30_000, liveIntervalMs = 600_000) {
  console.log(`[Checker] 🔄 Starting video checker (every ${intervalMs / 1000}s)`);
  console.log(`[Checker] 🔴 Starting live stream checker (every ${liveIntervalMs / 1000}s via YouTube Data API)`);

  // WebSub push server — no-op if not configured (see README-WEBSUB.md).
  // When a push arrives, it's routed through the exact same
  // processNewVideoForSubscribers() path as polling uses, so behavior
  // (seeding, 24h-old guard, notification format) is identical either way.
  websub.startWebSubServer((youtubeChannelId, video) =>
    processNewVideoForSubscribers(client, youtubeChannelId, video)
  );

  // First video check after a short delay to let the bot fully initialize
  setTimeout(() => runVideoCheckSafely(client), 10_000);

  // First live check after 30 seconds (give bot time to init, not too long)
  setTimeout(() => runLiveCheckSafely(client), 30_000);

  const videoTimer = setInterval(() => runVideoCheckSafely(client), intervalMs);
  const liveTimer = setInterval(() => runLiveCheckSafely(client), liveIntervalMs);

  return { videoTimer, liveTimer };
}

module.exports = {
  loadChannels,
  saveChannels,
  loadLastVideos,
  saveLastVideos,
  loadLogs,
  appendLogEntry,
  sendNotification,
  checkForNewVideos,
  checkForLiveStreams,
  processNewVideoForSubscribers,
  startChecker,
};
