const { Innertube, Log } = require('youtubei.js');
const Parser = require('rss-parser');
const https = require('node:https');
const config = require('../config');

// Suppress non-fatal youtubei.js parser noise by replacing its internal
// warn logger. The library's log_map captures console.warn at load time,
// so patching console.warn after the fact has no effect. Instead we use
// the Log module's own level system and override its internal warn handler.
//
// Suppressed messages (harmless — YouTube API returned a newer type):
//   • "ParsingError: Type mismatch, got ThumbnailView expected CollectionThumbnailView"
//   • "Unable to find matching run for style run"
(function suppressYouTubeJSNoise() {
  try {
    // Log.setLevel controls which levels are active. Level values: NONE=0, ERROR=1, WARNING=2, INFO=3, DEBUG=4
    // We keep ERROR (1) active so real errors still show, but silence WARNING (2).
    Log.setLevel(Log.Level.ERROR);
  } catch {
    // Fallback: if the API isn't available, filter via console.warn
    const _orig = console.warn.bind(console);
    console.warn = (...args) => {
      const msg = String(args[0] ?? '');
      if (msg.includes('ParsingError') || msg.includes('Unable to find matching run')) return;
      _orig(...args);
    };
  }
})();

/**
 * Safely extract a plain string from a youtubei.js Text object or a regular string.
 * youtubei.js wraps text fields in Text objects with a .text property.
 */
function getText(value) {
  if (!value) return null;
  if (typeof value === 'string') return value || null;
  if (typeof value.text === 'string') return value.text || null;
  const str = String(value);
  return str && str !== 'undefined' && str !== 'null' ? str : null;
}

// YouTube's RSS endpoint silently 404s requests that don't look like they
// came from a real browser — rss-parser's default User-Agent is literally
// the string "rss-parser", which YouTube blocks (especially from datacenter/
// hosting IPs). Without this, EVERY channel fails identically with a 404,
// even ones that are perfectly valid. Match the header set already used by
// resolveViaHttp() elsewhere in this file, which works fine.
const rssParser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  customFields: {
    item: [
      ['media:group', 'mediaGroup'],
      ['yt:videoId', 'ytVideoId'],
      ['yt:channelId', 'ytChannelId'],
    ],
  },
});

let innertube = null;

// Track channel IDs that returned 404 so we only warn once per session.
const notFoundChannels = new Set();

/**
 * Get or create the Innertube instance (singleton).
 */
async function getInnertube() {
  if (!innertube) {
    innertube = await Innertube.create({
      lang: 'en',
      location: 'US',
      retrieve_player: false,
    });
  }
  return innertube;
}

// ─── Channel Resolution ──────────────────────────────────────────────

/**
 * Resolve a YouTube channel identifier to a { id, name, handle, avatar } object.
 * Accepts:
 *   - @handle        (e.g. @MrBeast)
 *   - UC channel ID  (e.g. UCX6OQ3DkcsbYNE6H8uQQuVA)
 *   - YouTube URL    (e.g. https://youtube.com/@MrBeast, /channel/UCxxx, /c/name)
 */
async function resolveChannel(input) {
  const trimmed = input.trim();

  // ── Direct UC channel ID ──
  if (/^UC[\w-]{22}$/.test(trimmed)) {
    return await fetchChannelById(trimmed);
  }

  // ── @handle ──
  if (trimmed.startsWith('@')) {
    return await resolveHandle(trimmed);
  }

  // ── YouTube URL ──
  const urlPatterns = [
    { regex: /youtube\.com\/channel\/(UC[\w-]{22})/, type: 'id' },
    { regex: /youtube\.com\/@([\w.-]+)/, type: 'handle' },
    { regex: /youtube\.com\/c\/([\w.-]+)/, type: 'handle' },
    { regex: /youtube\.com\/user\/([\w.-]+)/, type: 'handle' },
  ];

  for (const { regex, type } of urlPatterns) {
    const match = trimmed.match(regex);
    if (match) {
      if (type === 'id') {
        return await fetchChannelById(match[1]);
      }
      return await resolveHandle(`@${match[1]}`);
    }
  }

  throw new Error(
    `Invalid YouTube channel identifier: "${trimmed}".\n` +
    'Use **@handle**, a **YouTube channel URL**, or a **UC channel ID**.'
  );
}

/**
 * Fetch channel info by UC channel ID.
 */
async function fetchChannelById(channelId) {
  const yt = await getInnertube();

  try {
    const channel = await yt.getChannel(channelId);
    return {
      id: channelId,
      name: channel.metadata?.title || channel.title || 'Unknown Channel',
      handle: channel.metadata?.vanity_url
        ? channel.metadata.vanity_url.split('/').pop()
        : null,
      avatar: extractAvatar(channel),
    };
  } catch (err) {
    // Fallback: try RSS feed for channel name
    try {
      const feed = await rssParser.parseURL(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
      );
      return {
        id: channelId,
        name: feed.title || 'Unknown Channel',
        handle: null,
        avatar: null,
      };
    } catch {
      // Last resort: try HTTP page scrape
      try {
        return await resolveViaHttp(channelId);
      } catch {
        throw new Error(`Could not fetch channel info for ID: ${channelId}`);
      }
    }
  }
}

/**
 * Resolve an @handle to channel info via Innertube resolveURL.
 */
async function resolveHandle(handle) {
  const yt = await getInnertube();
  const cleanHandle = handle.startsWith('@') ? handle : `@${handle}`;

  try {
    const resolved = await yt.resolveURL(`https://www.youtube.com/${cleanHandle}`);
    const browseId =
      resolved?.payload?.browseId ||
      resolved?.endpoint?.payload?.browseId;

    if (browseId && browseId.startsWith('UC')) {
      const channel = await yt.getChannel(browseId);
      return {
        id: browseId,
        name: channel.metadata?.title || channel.title || cleanHandle,
        handle: cleanHandle,
        avatar: extractAvatar(channel),
      };
    }
  } catch {
    // Fall through to search
  }

  // Fallback: search for the channel
  try {
    const results = await yt.search(cleanHandle, { type: 'channel' });
    const channels =
      results.results?.filter(
        (r) => r.type === 'Channel' || r.type === 'GridChannel'
      ) || [];

    for (const ch of channels) {
      const chHandle = ch.author?.url?.split('/').pop();
      if (chHandle?.toLowerCase() === cleanHandle.toLowerCase()) {
        return {
          id: ch.author.id,
          name: ch.author.name,
          handle: cleanHandle,
          avatar: ch.author.best_thumbnail?.url || null,
        };
      }
    }

    // If exact match not found, use first result
    if (channels.length > 0) {
      const first = channels[0];
      return {
        id: first.author?.id || first.id,
        name: first.author?.name || first.name || cleanHandle,
        handle: cleanHandle,
        avatar: first.author?.best_thumbnail?.url || null,
      };
    }
  } catch {
    // Fall through to HTTP scrape
  }

  // Last resort: HTTP scrape (works when Innertube is blocked by YouTube on the server IP)
  try {
    return await resolveViaHttp(cleanHandle);
  } catch {
    // All methods exhausted
  }

  throw new Error(
    `Could not resolve YouTube channel for handle: ${cleanHandle}\n` +
    'YouTube may be blocking Innertube on this server IP. Try using the UC channel ID directly instead of the @handle.'
  );
}

/**
 * Extract avatar URL from a channel object.
 */
function extractAvatar(channel) {
  return (
    channel.metadata?.avatar?.[0]?.url ||
    channel.metadata?.thumbnail?.[0]?.url ||
    null
  );
}

/**
 * Last-resort channel resolver: fetch the YouTube channel page over plain HTTPS
 * and extract the UC channel ID + name from the embedded page data.
 *
 * Works even when Innertube is blocked by YouTube on the server IP.
 * Accepts a @handle, a UC channel ID, or a full YouTube URL.
 */
function resolveViaHttp(input) {
  const trimmed = String(input).trim();

  // Build the URL to fetch
  let pageUrl;
  if (/^UC[\w-]{22}$/.test(trimmed)) {
    pageUrl = `https://www.youtube.com/channel/${trimmed}`;
  } else if (trimmed.startsWith('@')) {
    pageUrl = `https://www.youtube.com/${trimmed}`;
  } else if (trimmed.startsWith('http')) {
    pageUrl = trimmed;
  } else {
    pageUrl = `https://www.youtube.com/@${trimmed}`;
  }

  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };

    https.get(pageUrl, options, (res) => {
      // Follow redirects (YouTube redirects handles to /channel/UC...)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolveViaHttp(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${pageUrl}`));
      }

      let html = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { html += chunk; });
      res.on('end', () => {
        // Extract UC channel ID
        const idMatch =
          html.match(/"externalId"\s*:\s*"(UC[\w-]{22})"/) ||
          html.match(/"channelId"\s*:\s*"(UC[\w-]{22})"/) ||
          html.match(/channel\/(UC[\w-]{22})/);

        if (!idMatch) {
          return reject(new Error(`Could not extract channel ID from page: ${pageUrl}`));
        }

        const channelId = idMatch[1];

        // Extract channel name
        const nameMatch =
          html.match(/"title"\s*:\s*"([^"]{1,100})"/) ||
          html.match(/<title>([^<]+)<\/title>/);
        const rawName = nameMatch ? nameMatch[1].replace(/ - YouTube$/, '').trim() : 'Unknown Channel';

        // Extract avatar (best effort)
        const avatarMatch = html.match(/"thumbnails":\[\{"url":"(https:\/\/yt3[^"]+)"/)
          || html.match(/"avatar":\{"thumbnails":\[\{"url":"(https:\/\/yt3[^"]+)"/);
        const avatar = avatarMatch ? avatarMatch[1] : null;

        resolve({ id: channelId, name: rawName, handle: trimmed.startsWith('@') ? trimmed : null, avatar });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Video Fetching ──────────────────────────────────────────────────

// ─── Shared HTTPS JSON helper (used by the Data API calls below) ────

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${parsed?.error?.message || raw}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch the latest uploads for a channel via YouTube Data API v3, using the
 * "uploads" playlist trick (swap the UC prefix for UU — every channel has
 * this playlist automatically). Costs 1 quota unit regardless of maxResults.
 *
 * Used as a fallback when the RSS feed fails — YouTube's RSS endpoint is a
 * well-documented, ongoing source of flaky 404/500s even for valid, active
 * channels (see e.g. github.com/FreshRSS/FreshRSS/issues/8808), whereas the
 * Data API is the officially supported, reliable source.
 *
 * Returns [] silently if no API key is configured, so this is a no-op
 * fallback rather than a hard requirement.
 */
async function fetchLatestVideosViaDataAPI(channelId, count = 5) {
  const apiKey = config.youtubeApiKey;
  if (!apiKey) return [];

  const uploadsPlaylistId = `UU${channelId.slice(2)}`;
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${count}&key=${apiKey}`;

  try {
    const data = await httpGetJson(url);
    return (data.items || [])
      .map((item) => {
        const s = item.snippet;
        const videoId = s?.resourceId?.videoId;
        if (!videoId) return null;
        return {
          id: videoId,
          title: s.title || 'Untitled',
          link: `https://www.youtube.com/watch?v=${videoId}`,
          published: new Date(s.publishedAt || 0),
          author: s.channelTitle || '',
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error(`[DataAPI] playlistItems.list fallback failed for ${channelId}:`, err.message);
    return [];
  }
}

/**
 * Fetch the latest videos for a channel via RSS feed only.
 *
 * RSS is the authoritative, server-friendly source. It provides reliable
 * exact pubDate timestamps for ALL uploads: videos, Shorts, and past stream VODs.
 * Live stream detection is handled separately in getVideoDetails() via getBasicInfo().
 *
 * Returns an array of { id, title, link, published, author }.
 */
async function fetchLatestVideos(channelId, count = 5) {
  const items = [];
  let rssFailed = false;

  // RSS feed — reliable exact timestamps, works on any server IP
  try {
    const feed = await rssParser.parseURL(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
    );
    for (const item of feed.items) {
      const id = item.ytVideoId || item.id?.split(':').pop() || '';
      if (!id) continue;
      items.push({
        id,
        title: item.title || 'Untitled',
        link: item.link || `https://www.youtube.com/watch?v=${id}`,
        published: new Date(item.pubDate || item.isoDate || 0),
        author: feed.title || '',
      });
    }
  } catch (error) {
    rssFailed = true;

    // Classify the error and decide how noisy to be.
    const msg = error.message || '';
    const isNotFound = msg.includes('Status code 404') || msg.includes('404');
    const isTransient =
      msg.includes('Status code 500') ||
      msg.includes('500') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('fetch failed') ||
      msg.includes('network');

    if (isNotFound) {
      // Warn only once per session to avoid per-cycle spam
      if (!notFoundChannels.has(channelId)) {
        notFoundChannels.add(channelId);
        console.warn(`[RSS] Feed not found for channel ${channelId} (404) — YouTube's RSS endpoint is known to be unreliable; falling back to Data API if configured. If this channel is genuinely gone, use /yt remove to clean it up.`);
      }
    } else if (!isTransient) {
      // Unexpected error — log at error level
      console.error(`[RSS] Error fetching feed for ${channelId}:`, msg);
    }
    // Transient (500, network) errors are silently swallowed — they resolve on the next cycle
  }

  // RSS is known to be intermittently flaky on YouTube's end even for
  // perfectly valid channels. Whenever it fails for any reason, fall back
  // to the Data API v3 (if an API key is configured) so notifications keep
  // working instead of silently going quiet.
  if (rssFailed) {
    const fallbackItems = await fetchLatestVideosViaDataAPI(channelId, count);
    if (fallbackItems.length > 0) {
      items.push(...fallbackItems);
      console.log(`[DataAPI] ✅ Recovered ${fallbackItems.length} video(s) for ${channelId} via Data API fallback (RSS was down).`);
    }
  }


  // Also try to detect currently-active live streams via Innertube.
  // RSS only includes a stream AFTER it ends as a VOD, so this is the only
  // way to catch a stream while it is happening.
  // On some server IPs YouTube may block Innertube — we swallow those errors.
  try {
    const yt = await getInnertube();
    const channel = await yt.getChannel(channelId);
    const liveFeed = await channel.getLiveStreams();
    const liveContents = liveFeed.current_tab?.content?.contents || [];

    for (const item of liveContents) {
      const video = item.content;
      if (!video?.content_id) continue;

      const metadataParts = video.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts || [];
      const texts = metadataParts.map(p => p.text?.text || '').filter(Boolean);

      // Only include streams that are currently active ("X watching")
      const isLive = texts.some(t => /\d+\.?\d*[KMB]?\s*watching/i.test(t));
      if (!isLive) continue;

      items.push({
        id: video.content_id,
        title: getText(video.metadata?.title) || 'Live Stream',
        link: `https://www.youtube.com/watch?v=${video.content_id}`,
        published: new Date(), // currently live → treat as most recent
        author: getText(channel.header?.page_title) || getText(channel.metadata?.title) || '',
        isLiveHint: true, // hint so we don't need an extra getBasicInfo call
      });
    }
  } catch (error) {
    // Swallow expected errors:
    //  • "Tab" / "streams"  — channel has no live tab (normal)
    //  • status 500         — YouTube blocks Innertube on this server IP (non-fatal, RSS is used instead)
    const msg = error.message || '';
    const isExpected =
      msg.includes('Tab') ||
      msg.includes('streams') ||
      msg.includes('status 500') ||
      msg.includes('500') ||
      msg.includes('fetch failed') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('network');
    if (!isExpected) {
      console.error(`[Innertube] Live stream check failed for ${channelId}:`, msg);
    }
  }

  if (items.length === 0) return [];

  // De-duplicate by ID (a stream VOD may appear in both RSS and Innertube)
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      unique.push(item);
    }
  }

  // Sort newest-first and return top count
  unique.sort((a, b) => b.published - a.published);
  return unique.slice(0, count);
}

/**
 * Get detailed video info via youtubei.js.
 *
 * @param {string} videoId       - YouTube video ID
 * @param {string} [fallbackTitle]  - Title from RSS to use when Innertube fails or returns nothing
 * @param {string} [fallbackAuthor] - Channel name from RSS to use as fallback
 * @param {boolean} [liveHint]   - true when the caller already knows this is a live stream
 *
 * Returns { id, title, channelName, channelId, thumbnail, duration,
 *           isLive, isUpcoming, isShort, viewCount, description }.
 * Never returns null — falls back to a minimal object using RSS data so
 * notifications still fire even when Innertube is blocked on the server.
 */
async function getVideoDetails(videoId, fallbackTitle = null, fallbackAuthor = null, liveHint = false) {
  try {
    const yt = await getInnertube();
    const info = await yt.getBasicInfo(videoId);
    const basic = info.basic_info;

    const title = getText(basic.title) || getText(basic.short_title) || fallbackTitle || 'Untitled';
    const isLive = basic.is_live || basic.is_live_content || liveHint || false;
    const isUpcoming = basic.is_upcoming || false;
    const duration = basic.duration || 0;
    const isShort = !isLive && !isUpcoming && duration > 0 && duration <= 60;

    return {
      id: videoId,
      title,
      channelName: getText(basic.channel?.name) || getText(basic.author) || fallbackAuthor || '',
      channelId: basic.channel_id || '',
      thumbnail:
        basic.thumbnail?.[basic.thumbnail.length - 1]?.url ||
        `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      duration,
      isLive,
      isUpcoming,
      isShort,
      viewCount: basic.view_count || 0,
      description: getText(basic.short_description) || '',
    };
  } catch (error) {
    console.error(`[YT] getBasicInfo failed for ${videoId} (server may be rate-limited by YouTube):`, error.message);

    // Return a minimal object using RSS fallback data so the notification still fires.
    return {
      id: videoId,
      title: fallbackTitle || 'Untitled',
      channelName: fallbackAuthor || '',
      channelId: '',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      duration: 0,
      isLive: liveHint || false,
      isUpcoming: false,
      isShort: false,
      viewCount: 0,
      description: '',
    };
  }
}

// ─── Live Stream Detection via YouTube Data API v3 ─────────────────

/**
 * Check if a channel has an active live stream using YouTube Data API v3.
 *
 * Strategy (quota-friendly):
 *   1. Fetch the channel's RSS feed to get recent video IDs (free, no quota).
 *   2. Send a single videos.list request with those IDs (costs 1 unit total).
 *   3. Return any video where liveBroadcastContent === 'live'.
 *
 * @param {string} channelId  – YouTube UC channel ID
 * @returns {Promise<{id, title, channelName, thumbnail, isLive}|null>}
 *   The live video object, or null if nothing is live.
 */
async function checkLiveViaDataAPI(channelId) {
  const apiKey = config.youtubeApiKey;
  if (!apiKey) {
    console.warn('[DataAPI] YOUTUBE_API_KEY is not set — skipping live check.');
    return null;
  }

  // Step 1: get recent video IDs from RSS (free)
  let videoIds = [];
  try {
    const feed = await rssParser.parseURL(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
    );
    videoIds = feed.items
      .map((item) => item.ytVideoId || item.id?.split(':').pop() || '')
      .filter(Boolean)
      .slice(0, 15); // batch up to 15 IDs in one request
  } catch (err) {
    const msg = err.message || '';
    const isNotFound = msg.includes('Status code 404') || msg.includes('404');
    const isTransient =
      msg.includes('Status code 500') ||
      msg.includes('500') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('fetch failed') ||
      msg.includes('network');

    if (isNotFound) {
      // Only log if we haven't already warned from the RSS checker
      if (!notFoundChannels.has(channelId)) {
        notFoundChannels.add(channelId);
        console.warn(`[DataAPI] RSS feed not found for channel ${channelId} (404) — channel may be deleted or ID is wrong. Use /yt remove to clean it up.`);
      }
    } else if (!isTransient) {
      console.error(`[DataAPI] RSS fetch failed for ${channelId}:`, msg);
    }
    // Transient errors (500, network) are silently swallowed
    return null;
  }

  if (videoIds.length === 0) return null;

  // Step 2: call videos.list — costs only 1 unit regardless of ID count
  const idsParam = videoIds.join(',');
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(idsParam)}&key=${apiKey}&fields=items(id,snippet(title,channelTitle,liveBroadcastContent),liveStreamingDetails(concurrentViewers))`;

  try {
    const data = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${parsed?.error?.message || raw}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });

    const liveItem = (data.items || []).find(
      (item) => item.snippet?.liveBroadcastContent === 'live'
    );

    if (!liveItem) return null;

    const viewers = liveItem.liveStreamingDetails?.concurrentViewers
      ? parseInt(liveItem.liveStreamingDetails.concurrentViewers, 10)
      : 0;

    return {
      id: liveItem.id,
      title: liveItem.snippet?.title || 'Live Stream',
      channelName: liveItem.snippet?.channelTitle || '',
      channelId,
      thumbnail: `https://i.ytimg.com/vi/${liveItem.id}/maxresdefault.jpg`,
      duration: 0,
      isLive: true,
      isUpcoming: false,
      isShort: false,
      viewCount: viewers,
      description: '',
    };
  } catch (err) {
    console.error(`[DataAPI] videos.list failed for ${channelId}:`, err.message);
    return null;
  }
}

module.exports = {
  resolveChannel,
  fetchLatestVideos,
  getVideoDetails,
  checkLiveViaDataAPI,
};
