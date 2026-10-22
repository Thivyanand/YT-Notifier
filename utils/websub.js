const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const Parser = require('rss-parser');
const { db } = require('./db');
const config = require('../config');

// ─── WebSub (PubSubHubbub) push notifications ─────────────────────────
//
// Instead of polling every channel's RSS feed every 30s, we subscribe once
// per unique YouTube channel to https://pubsubhubbub.appspot.com/subscribe.
// YouTube's hub then POSTs to our callback URL the moment a video is
// published or edited — near-zero latency, near-zero polling load.
//
// RSS/Data-API polling in checker.js is NOT removed — it keeps running as
// a fallback safety net in case a push is dropped, the hub has an outage,
// or a subscription lapses before it's renewed. WebSub is additive.
//
// Requires config.websub.enabled = true and config.websub.callbackBaseUrl
// to be a real public HTTPS URL that reaches this process. If either is
// missing, everything in this file becomes a safe no-op and the bot just
// keeps polling as it always has — see README-WEBSUB.md.

const HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';
const TOPIC_BASE = 'https://www.youtube.com/xml/feeds/videos.xml?channel_id=';
const LEASE_SECONDS = 432000; // 5 days — YouTube's hub caps grants around here regardless of what's requested
const RENEW_MARGIN_MS = 24 * 60 * 60 * 1000; // renew if less than 24h remains on the lease
const HUB_REQUEST_TIMEOUT_MS = 15_000;

// ─── Schema ────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS websub_subscriptions (
    youtube_channel_id TEXT PRIMARY KEY,
    secret              TEXT NOT NULL,
    lease_expires_at    INTEGER NOT NULL,
    subscribed_at       INTEGER NOT NULL
  );
`);

// Separate parser instance for push payloads — no custom headers needed
// since parseString() never makes an HTTP request itself.
const pushParser = new Parser({
  customFields: {
    item: [
      ['yt:videoId', 'ytVideoId'],
      ['yt:channelId', 'ytChannelId'],
    ],
  },
});

// ─── Config helpers ────────────────────────────────────────────────────

function isEnabled() {
  return !!(config.websub && config.websub.enabled && config.websub.callbackBaseUrl);
}

function getCallbackUrl() {
  const base = String(config.websub.callbackBaseUrl).replace(/\/+$/, '');
  return `${base}/websub/callback`;
}

function getPort() {
  return (config.websub && config.websub.port) || 3000;
}

// ─── DB helpers ────────────────────────────────────────────────────────

function getSubscriptionRow(channelId) {
  return db.prepare('SELECT * FROM websub_subscriptions WHERE youtube_channel_id = ?').get(channelId);
}

function getAllSubscriptionRows() {
  return db.prepare('SELECT * FROM websub_subscriptions').all();
}

function upsertSubscriptionRow(channelId, secret, leaseSeconds) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO websub_subscriptions (youtube_channel_id, secret, lease_expires_at, subscribed_at)
    VALUES (@channelId, @secret, @leaseExpiresAt, @subscribedAt)
    ON CONFLICT(youtube_channel_id) DO UPDATE SET
      secret = excluded.secret,
      lease_expires_at = excluded.lease_expires_at,
      subscribed_at = excluded.subscribed_at
  `).run({
    channelId,
    secret,
    leaseExpiresAt: now + leaseSeconds * 1000,
    subscribedAt: now,
  });
}

function deleteSubscriptionRow(channelId) {
  db.prepare('DELETE FROM websub_subscriptions WHERE youtube_channel_id = ?').run(channelId);
}

// ─── Hub communication ─────────────────────────────────────────────────

function postToHub(params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const url = new URL(HUB_URL);

    const req = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: HUB_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          // A valid subscribe/unsubscribe request gets 202 Accepted — actual
          // (un)subscription confirmation arrives later via our GET callback.
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Hub responded ${res.statusCode}: ${raw.slice(0, 300)}`));
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('Hub request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function subscribeChannel(channelId) {
  if (!isEnabled()) return false;

  const secret = crypto.randomBytes(24).toString('hex');
  const params = {
    'hub.mode': 'subscribe',
    'hub.topic': `${TOPIC_BASE}${channelId}`,
    'hub.callback': getCallbackUrl(),
    'hub.verify': 'async',
    'hub.lease_seconds': String(LEASE_SECONDS),
    'hub.secret': secret,
  };

  try {
    await postToHub(params);
    // Store the secret now so the verification GET (which arrives shortly
    // after) can find it. If verification never arrives, this row's lease
    // simply won't get extended, and the next reconcile pass retries it.
    upsertSubscriptionRow(channelId, secret, LEASE_SECONDS);
    console.log(`[WebSub] 📡 Subscribe request sent for channel ${channelId} (awaiting hub verification).`);
    return true;
  } catch (err) {
    console.error(`[WebSub] ❌ Subscribe request failed for ${channelId}:`, err.message);
    return false;
  }
}

async function unsubscribeChannel(channelId) {
  if (!isEnabled()) return false;

  const row = getSubscriptionRow(channelId);
  const secret = row?.secret || crypto.randomBytes(24).toString('hex');
  const params = {
    'hub.mode': 'unsubscribe',
    'hub.topic': `${TOPIC_BASE}${channelId}`,
    'hub.callback': getCallbackUrl(),
    'hub.verify': 'async',
    'hub.secret': secret,
  };

  try {
    await postToHub(params);
    deleteSubscriptionRow(channelId);
    console.log(`[WebSub] 📴 Unsubscribe request sent for channel ${channelId}.`);
    return true;
  } catch (err) {
    console.error(`[WebSub] ❌ Unsubscribe request failed for ${channelId}:`, err.message);
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ensure every currently-tracked unique YouTube channel has a live WebSub
 * subscription, renew any within RENEW_MARGIN_MS of expiring, and
 * unsubscribe any channel no longer tracked by anyone. Safe to call
 * repeatedly (e.g. once per poll cycle) — re-subscribing before expiry
 * just extends the lease rather than creating a duplicate.
 */
async function reconcileSubscriptions(uniqueChannelIds) {
  if (!isEnabled()) return;

  const existing = new Map(getAllSubscriptionRows().map((r) => [r.youtube_channel_id, r]));
  const now = Date.now();

  for (const channelId of uniqueChannelIds) {
    const row = existing.get(channelId);
    const needsSubscribe = !row || row.lease_expires_at - now < RENEW_MARGIN_MS;
    if (needsSubscribe) {
      await subscribeChannel(channelId);
      await sleep(500); // be gentle with the hub
    }
  }

  const stillTracked = new Set(uniqueChannelIds);
  for (const channelId of existing.keys()) {
    if (!stillTracked.has(channelId)) {
      await unsubscribeChannel(channelId);
      await sleep(500);
    }
  }
}

// ─── HTTP callback server ──────────────────────────────────────────────

function extractChannelIdFromTopic(topic) {
  try {
    return new URL(topic).searchParams.get('channel_id');
  } catch {
    return null;
  }
}

function handleVerification(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const mode = url.searchParams.get('hub.mode');
  const topic = url.searchParams.get('hub.topic');
  const challenge = url.searchParams.get('hub.challenge');
  const leaseSeconds = url.searchParams.get('hub.lease_seconds');

  if (!mode || !topic || !challenge) {
    res.writeHead(400).end('Missing required hub.* params');
    return;
  }

  const channelId = extractChannelIdFromTopic(topic);

  if (mode === 'subscribe') {
    const row = channelId ? getSubscriptionRow(channelId) : null;
    if (!row) {
      console.warn(`[WebSub] Rejected verification for unrecognized topic: ${topic}`);
      res.writeHead(404).end('Not subscribed');
      return;
    }
    const lease = parseInt(leaseSeconds, 10) || LEASE_SECONDS;
    upsertSubscriptionRow(channelId, row.secret, lease);
    console.log(`[WebSub] ✅ Subscription verified for channel ${channelId} (lease ${lease}s).`);
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(challenge);
    return;
  }

  if (mode === 'unsubscribe') {
    console.log(`[WebSub] ✅ Unsubscribe confirmed for topic ${topic}.`);
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(challenge);
    return;
  }

  res.writeHead(400).end('Unsupported hub.mode');
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX_BYTES = 1024 * 1024; // 1MB is very generous for a single Atom entry
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const [algo, providedHex] = signatureHeader.split('=');
  if (!algo || !providedHex) return false;

  let computed;
  try {
    computed = crypto.createHmac(algo.toLowerCase(), secret).update(rawBody).digest('hex');
  } catch {
    return false; // unsupported algo name — treat as invalid rather than crash
  }

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(providedHex, 'hex');
  if (a.length !== b.length) return false; // guards timingSafeEqual's length requirement
  return crypto.timingSafeEqual(a, b);
}

/**
 * Handle an incoming push notification. Verifies the HMAC signature against
 * the secret stored for that channel at subscribe time, parses the Atom
 * payload, and calls onNewVideo(channelId, video) for each entry — video
 * shape matches fetchLatestVideos()'s items: { id, title, link, published, author }.
 */
async function handlePush(req, res, onNewVideo) {
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    res.writeHead(413).end();
    return;
  }

  const bodyStr = rawBody.toString('utf8');

  // A deleted/privated video arrives as <at:deleted-entry> instead of a
  // normal <entry> — nothing to notify, just acknowledge.
  if (bodyStr.includes('deleted-entry')) {
    res.writeHead(200).end();
    return;
  }

  const channelIdMatch = bodyStr.match(/<yt:channelId>([^<]+)<\/yt:channelId>/);
  const channelId = channelIdMatch ? channelIdMatch[1] : null;

  if (!channelId) {
    console.warn('[WebSub] Push payload had no yt:channelId, ignoring.');
    res.writeHead(200).end(); // 200 so the hub doesn't keep retrying malformed content
    return;
  }

  const row = getSubscriptionRow(channelId);
  if (!row) {
    console.warn(`[WebSub] Push for untracked channel ${channelId}, ignoring.`);
    res.writeHead(200).end();
    return;
  }

  const signatureHeader = req.headers['x-hub-signature'];
  if (!verifySignature(rawBody, signatureHeader, row.secret)) {
    console.warn(`[WebSub] ⚠ Invalid signature on push for channel ${channelId} — discarding (possible spoof attempt).`);
    res.writeHead(403).end();
    return;
  }

  // Acknowledge immediately once verified — the hub expects a fast 2xx and
  // may retry aggressively otherwise. Processing happens after the response.
  res.writeHead(200).end();

  let feed;
  try {
    feed = await pushParser.parseString(bodyStr);
  } catch (err) {
    console.error(`[WebSub] Failed to parse push payload for ${channelId}:`, err.message);
    return;
  }

  for (const item of feed.items || []) {
    const videoId = item.ytVideoId || item.id?.split(':').pop();
    if (!videoId) continue;

    const video = {
      id: videoId,
      title: item.title || 'Untitled',
      link: item.link || `https://www.youtube.com/watch?v=${videoId}`,
      published: new Date(item.pubDate || item.isoDate || Date.now()),
      author: item.author || '',
    };

    try {
      await onNewVideo(channelId, video);
    } catch (err) {
      console.error(`[WebSub] onNewVideo handler threw for ${channelId}/${videoId}:`, err.message);
    }
  }
}

let server = null;

/**
 * Start the callback HTTP server. No-op (returns null) if WebSub isn't
 * configured — the bot just keeps polling in that case.
 * @param {(channelId: string, video: object) => Promise<void>} onNewVideo
 */
function startWebSubServer(onNewVideo) {
  if (!isEnabled()) {
    console.log(
      '[WebSub] Disabled — set config.websub.enabled = true and config.websub.callbackBaseUrl ' +
      'to a public HTTPS URL to turn on push notifications. Falling back to RSS/Data API polling only.'
    );
    return null;
  }

  const port = getPort();

  server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (url.pathname !== '/websub/callback') {
      res.writeHead(404).end();
      return;
    }

    if (req.method === 'GET') {
      handleVerification(req, res);
    } else if (req.method === 'POST') {
      handlePush(req, res, onNewVideo).catch((err) => {
        console.error('[WebSub] Unhandled error processing push:', err.message);
        if (!res.headersSent) res.writeHead(500).end();
      });
    } else {
      res.writeHead(405).end();
    }
  });

  server.on('error', (err) => {
    console.error('[WebSub] ❌ HTTP server error:', err.message);
  });

  server.listen(port, () => {
    console.log(`[WebSub] 🌐 Callback server listening on port ${port} → ${getCallbackUrl()}`);
  });

  return server;
}

function stopWebSubServer() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = {
  isEnabled,
  subscribeChannel,
  unsubscribeChannel,
  reconcileSubscriptions,
  startWebSubServer,
  stopWebSubServer,
};
