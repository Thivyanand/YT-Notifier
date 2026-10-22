const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../config');
const {
  loadChannels,
  saveChannels,
  loadLastVideos,
  saveLastVideos,
  loadLogs,
  appendLogEntry,
} = require('../utils/db');
const { resolveChannel, fetchLatestVideos } = require('../utils/youtube');

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_AUTH = 'https://discord.com/oauth2';
const SESSION_COOKIE = 'yt_dashboard_session';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const GUILD_CACHE_MS = 30 * 1000;
const MAX_BODY_BYTES = 32 * 1024;
const sessions = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function signingKey() {
  return config.dashboard.sessionSecret;
}

function signatureFor(id) {
  return crypto.createHmac('sha256', signingKey()).update(id).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieValue(id) {
  return `${id}.${signatureFor(id)}`;
}

function cookieOptions(id) {
  const secure = config.dashboard.baseUrl.startsWith('https://');
  return [
    `${SESSION_COOKIE}=${id ? cookieValue(id) : ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${id ? 7 * 24 * 60 * 60 : 0}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function setSessionCookie(res, id) {
  res.setHeader('Set-Cookie', cookieOptions(id));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', cookieOptions(null));
}

function parseCookies(header = '') {
  const result = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      // Ignore malformed cookies rather than failing the whole request.
    }
  }
  return result;
}

function createSession() {
  const id = crypto.randomBytes(32).toString('base64url');
  const session = {
    id,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    csrfToken: crypto.randomBytes(32).toString('base64url'),
    user: null,
    accessToken: null,
    refreshToken: null,
    accessTokenExpiresAt: 0,
    discordGuildCache: null,
    discordGuildsAt: 0,
  };
  sessions.set(id, session);
  return session;
}

function sessionFor(req) {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return null;
  const separator = raw.lastIndexOf('.');
  if (separator < 1) return null;
  const id = raw.slice(0, separator);
  if (!safeEqual(raw.slice(separator + 1), signatureFor(id))) return null;

  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.lastSeenAt > SESSION_MAX_AGE_MS) {
    sessions.delete(id);
    return null;
  }
  session.lastSeenAt = Date.now();
  return session;
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://cdn.discordapp.com; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
  );
}

function requireSession(session) {
  if (!session?.user) throw new HttpError(401, 'Sign in with Discord to continue.');
  return session;
}

function requireCsrf(req, session) {
  if (!session?.user) throw new HttpError(401, 'Your session has expired. Sign in again.');
  const origin = req.headers.origin;
  if (origin && origin !== new URL(config.dashboard.baseUrl).origin) {
    throw new HttpError(403, 'This request did not come from the dashboard.');
  }
  if (!safeEqual(req.headers['x-csrf-token'], session.csrfToken)) {
    throw new HttpError(403, 'The dashboard security token expired. Refresh and try again.');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'The request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Expected a JSON object.');
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'Send a valid JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

function parsePermission(value) {
  try {
    return BigInt(value || '0');
  } catch {
    return 0n;
  }
}

function isServerAdministrator(guild) {
  const permission = parsePermission(guild.permissions);
  return !!guild.owner || (permission & BigInt(PermissionFlagsBits.Administrator)) !== 0n;
}

async function exchangeOAuth(form) {
  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.dashboard.clientSecret,
      ...form,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    console.warn('[Dashboard] Discord OAuth token request was rejected.');
    throw new HttpError(502, 'Discord sign-in could not be completed. Try again.');
  }
  return payload;
}

async function ensureAccessToken(session) {
  if (session.accessToken && session.accessTokenExpiresAt > Date.now() + 30_000) {
    return session.accessToken;
  }
  if (!session.refreshToken) {
    session.user = null;
    throw new HttpError(401, 'Your Discord session expired. Sign in again.');
  }

  const tokens = await exchangeOAuth({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
  });
  session.accessToken = tokens.access_token;
  session.refreshToken = tokens.refresh_token || session.refreshToken;
  session.accessTokenExpiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
  return session.accessToken;
}

async function discordGet(pathname, session) {
  const accessToken = await ensureAccessToken(session);
  let response = await fetch(`${DISCORD_API}${pathname}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 401 && session.refreshToken) {
    session.accessTokenExpiresAt = 0;
    const refreshed = await ensureAccessToken(session);
    response = await fetch(`${DISCORD_API}${pathname}`, {
      headers: { Authorization: `Bearer ${refreshed}` },
    });
  }

  if (!response.ok) {
    if (response.status === 401) {
      session.user = null;
      throw new HttpError(401, 'Your Discord session expired. Sign in again.');
    }
    throw new HttpError(502, 'Discord could not load this information. Try again shortly.');
  }
  return response.json();
}

async function discordGuilds(session) {
  if (session.discordGuildCache && Date.now() - session.discordGuildsAt < GUILD_CACHE_MS) {
    return session.discordGuildCache;
  }
  const guilds = await discordGet('/users/@me/guilds', session);
  session.discordGuildCache = Array.isArray(guilds) ? guilds : [];
  session.discordGuildsAt = Date.now();
  return session.discordGuildCache;
}

async function authorizedGuild(session, guildId, requireBot = true) {
  requireSession(session);
  if (!/^\d{17,20}$/.test(guildId || '')) throw new HttpError(400, 'Invalid server ID.');
  const guilds = await discordGuilds(session);
  const userGuild = guilds.find((guild) => guild.id === guildId);
  if (!userGuild || !isServerAdministrator(userGuild)) {
    throw new HttpError(403, 'You need server administrator access to manage this server.');
  }

  const guild = requireBot ? null : undefined;
  const botGuild = client.guilds.cache.get(guildId);
  if (!botGuild && requireBot) throw new HttpError(409, 'Add the bot to this server before managing subscriptions.');
  return { userGuild, guild: botGuild || guild };
}

function iconUrl(guild) {
  return guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=96` : null;
}

function botStats() {
  const channels = loadChannels();
  const subscriptionCount = Object.values(channels).reduce(
    (sum, guildSubs) => sum + Object.keys(guildSubs || {}).length,
    0
  );
  return {
    ready: client.isReady(),
    guildCount: client.guilds.cache.size,
    subscriptionCount,
    uptimeSeconds: client.uptime ? Math.floor(client.uptime / 1000) : 0,
    ping: client.ws.ping,
  };
}

function installUrl() {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', 'bot applications.commands');
  // View channels, send messages, embed links.
  url.searchParams.set('permissions', '19456');
  return url.toString();
}

async function guildListApi(res, session) {
  requireSession(session);
  const userGuilds = (await discordGuilds(session)).filter(isServerAdministrator);
  const visibleGuilds = userGuilds.map((guild) => {
    const installed = client.guilds.cache.has(guild.id);
    return {
      id: guild.id,
      name: guild.name,
      iconUrl: iconUrl(guild),
      installed,
      inviteUrl: installed ? null : installUrl(),
      subscriptionCount: installed ? Object.keys(loadChannels()[guild.id] || {}).length : 0,
    };
  });
  visibleGuilds.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
  json(res, 200, { guilds: visibleGuilds, bot: botStats() });
}

async function guildDetailApi(res, session, guildId) {
  const { guild } = await authorizedGuild(session, guildId);
  if (!guild) throw new HttpError(503, 'The bot is not ready yet. Try again in a moment.');

  try {
    await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);
  } catch {
    throw new HttpError(503, 'The bot could not load this server. Check its server permissions.');
  }

  const botMember = guild.members.me;
  const availableChannels = guild.channels.cache
    .filter((channel) => [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type))
    .filter((channel) => {
      const permissions = botMember?.permissionsIn(channel);
      return permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ]);
    })
    .map((channel) => ({ id: channel.id, name: channel.name, type: channel.type }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const roles = guild.roles.cache
    .filter((role) => role.id !== guild.id && !role.managed)
    .map((role) => ({ id: role.id, name: role.name, color: role.hexColor }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const guildSubs = loadChannels()[guildId] || {};
  const logs = (loadLogs()[guildId] || []).slice(0, 8);
  json(res, 200, {
    guild: { id: guild.id, name: guild.name, iconUrl: iconUrl(guild) },
    channels: availableChannels,
    roles,
    subscriptions: Object.entries(guildSubs).map(([name, subscription]) => ({
      name,
      youtubeChannelId: subscription.youtubeChannelId,
      youtubeChannelName: subscription.youtubeChannelName,
      handle: subscription.handle || null,
      avatar: subscription.avatar || null,
      discordChannelId: subscription.discordChannelId,
      roleId: subscription.roleId || null,
      addedAt: subscription.addedAt || null,
    })),
    logs,
    bot: botStats(),
  });
}

function pickDiscordChannel(guild, channelId) {
  if (!/^\d{17,20}$/.test(channelId || '')) throw new HttpError(400, 'Choose a valid Discord channel.');
  const channel = guild.channels.cache.get(channelId);
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    throw new HttpError(400, 'Choose a text or announcement channel in this server.');
  }
  const permissions = guild.members.me?.permissionsIn(channel);
  if (!permissions?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ])) {
    throw new HttpError(400, 'The bot needs view, send message, and embed permissions in that channel.');
  }
  return channel;
}

function pickRole(guild, roleId) {
  if (roleId === null || roleId === undefined || roleId === '') return null;
  if (!/^\d{17,20}$/.test(String(roleId))) throw new HttpError(400, 'Choose a valid ping role.');
  const role = guild.roles.cache.get(String(roleId));
  if (!role || role.id === guild.id || role.managed) throw new HttpError(400, 'Choose a role from this server.');
  return role;
}

function youtubeInput(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a YouTube channel URL or @handle.');
  const input = value.trim();
  if (!input || input.length > 300) throw new HttpError(400, 'Enter a YouTube channel URL or @handle.');
  if (/^UC[\w-]{22}$/.test(input) || /^@[\w.-]{3,30}$/.test(input)) return input;
  if (/^[\w.-]{3,30}$/.test(input)) return `@${input}`;

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new HttpError(400, 'Use an @handle, channel ID, or https://youtube.com channel URL.');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (parsed.protocol !== 'https:' || !['youtube.com', 'm.youtube.com', 'youtu.be'].includes(hostname) || parsed.username || parsed.password) {
    throw new HttpError(400, 'The channel link must be from youtube.com or youtu.be.');
  }
  return parsed.toString();
}

function appendDashboardLog(guildId, entry) {
  try {
    appendLogEntry(guildId, entry);
  } catch (error) {
    console.error('[Dashboard] Could not write the audit log entry:', error.message);
  }
}

function actor(session) {
  return {
    actorId: session.user.id,
    actorTag: session.user.global_name || session.user.username || session.user.id,
  };
}

async function addSubscriptionApi(res, session, guildId, body) {
  const { guild } = await authorizedGuild(session, guildId);
  const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) {
    throw new HttpError(400, 'Use a name with 1–48 letters, numbers, or hyphens.');
  }
  const channel = pickDiscordChannel(guild, String(body.discordChannelId || ''));
  const role = pickRole(guild, body.roleId ?? null);
  const source = youtubeInput(body.youtubeUrl);

  const existing = loadChannels();
  if (existing[guildId]?.[name]) throw new HttpError(409, 'A subscription with that name already exists.');

  let resolved;
  let videos;
  try {
    resolved = await resolveChannel(source);
    videos = await fetchLatestVideos(resolved.id, 1);
  } catch (error) {
    console.warn('[Dashboard] YouTube channel could not be resolved:', error.message);
    throw new HttpError(422, 'YouTube could not resolve that channel. Check the link and try again.');
  }

  // Re-read after network requests so a concurrent edit is not overwritten.
  const current = loadChannels();
  if (current[guildId]?.[name]) throw new HttpError(409, 'A subscription with that name already exists.');
  if (!current[guildId]) current[guildId] = {};
  current[guildId][name] = {
    youtubeChannelId: resolved.id,
    youtubeChannelName: resolved.name,
    handle: resolved.handle,
    avatar: resolved.avatar,
    discordChannelId: channel.id,
    roleId: role?.id || null,
    addedBy: session.user.id,
    addedAt: new Date().toISOString(),
  };
  saveChannels(current);

  if (videos.length > 0) {
    const lastVideos = loadLastVideos();
    if (!lastVideos[guildId]) lastVideos[guildId] = {};
    lastVideos[guildId][name] = [videos[0].id];
    saveLastVideos(lastVideos);
  }

  appendDashboardLog(guildId, {
    action: 'add',
    subscriptionName: name,
    channelName: resolved.name,
    youtubeChannelId: resolved.id,
    discordChannelId: channel.id,
    roleId: role?.id || null,
    ...actor(session),
    details: `Added subscription ${name} from the web dashboard`,
  });
  json(res, 201, { ok: true, name, youtubeChannelName: resolved.name });
}

async function updateSubscriptionApi(res, session, guildId, name, body) {
  const { guild } = await authorizedGuild(session, guildId);
  const cleanName = String(name || '').toLowerCase();
  const current = loadChannels();
  const subscription = current[guildId]?.[cleanName];
  if (!subscription) throw new HttpError(404, 'Subscription not found.');
  const channel = pickDiscordChannel(guild, String(body.discordChannelId || ''));
  const role = pickRole(guild, body.roleId ?? null);
  const oldChannelId = subscription.discordChannelId;
  const oldRoleId = subscription.roleId || null;
  subscription.discordChannelId = channel.id;
  subscription.roleId = role?.id || null;
  saveChannels(current);
  appendDashboardLog(guildId, {
    action: 'update',
    subscriptionName: cleanName,
    channelName: subscription.youtubeChannelName,
    youtubeChannelId: subscription.youtubeChannelId,
    discordChannelId: channel.id,
    roleId: role?.id || null,
    ...actor(session),
    details: oldChannelId !== channel.id || oldRoleId !== (role?.id || null)
      ? `Updated delivery settings for ${cleanName}`
      : `Saved delivery settings for ${cleanName}`,
  });
  json(res, 200, { ok: true });
}

async function removeSubscriptionApi(res, session, guildId, name) {
  await authorizedGuild(session, guildId);
  const cleanName = String(name || '').toLowerCase();
  const channels = loadChannels();
  const subscription = channels[guildId]?.[cleanName];
  if (!subscription) throw new HttpError(404, 'Subscription not found.');

  delete channels[guildId][cleanName];
  if (Object.keys(channels[guildId]).length === 0) delete channels[guildId];
  saveChannels(channels);

  const lastVideos = loadLastVideos();
  if (lastVideos[guildId]) {
    delete lastVideos[guildId][cleanName];
    if (Object.keys(lastVideos[guildId]).length === 0) delete lastVideos[guildId];
    saveLastVideos(lastVideos);
  }
  appendDashboardLog(guildId, {
    action: 'remove',
    subscriptionName: cleanName,
    channelName: subscription.youtubeChannelName,
    youtubeChannelId: subscription.youtubeChannelId,
    discordChannelId: subscription.discordChannelId,
    roleId: subscription.roleId || null,
    ...actor(session),
    details: `Removed subscription ${cleanName} from the web dashboard`,
  });
  json(res, 200, { ok: true });
}

async function handleOAuthLogin(req, res) {
  const session = createSession();
  session.oauthState = crypto.randomBytes(32).toString('base64url');
  setSessionCookie(res, session.id);
  const authorize = new URL(`${DISCORD_AUTH}/authorize`);
  authorize.searchParams.set('client_id', config.clientId);
  authorize.searchParams.set('redirect_uri', `${config.dashboard.baseUrl}/auth/discord/callback`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'identify guilds');
  authorize.searchParams.set('state', session.oauthState);
  redirect(res, authorize.toString());
}

async function handleOAuthCallback(req, res, url) {
  const session = sessionFor(req);
  const returnedState = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (url.searchParams.has('error') || !session?.oauthState || !safeEqual(returnedState, session.oauthState) || !code) {
    clearSessionCookie(res);
    return redirect(res, '/?signin=failed');
  }

  try {
    const tokens = await exchangeOAuth({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${config.dashboard.baseUrl}/auth/discord/callback`,
    });
    const response = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!response.ok) throw new HttpError(502, 'Discord could not load your account. Try signing in again.');
    const user = await response.json();

    sessions.delete(session.id);
    const signedIn = createSession();
    signedIn.user = {
      id: user.id,
      username: user.username,
      global_name: user.global_name,
      avatar: user.avatar,
    };
    signedIn.accessToken = tokens.access_token;
    signedIn.refreshToken = tokens.refresh_token || null;
    signedIn.accessTokenExpiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
    setSessionCookie(res, signedIn.id);
    redirect(res, '/');
  } catch (error) {
    if (error instanceof HttpError) {
      console.warn('[Dashboard] Discord sign-in failed:', error.message);
    } else {
      console.error('[Dashboard] Discord sign-in request failed:', error.message);
    }
    sessions.delete(session.id);
    clearSessionCookie(res);
    redirect(res, '/?signin=failed');
  }
}

function serveStatic(res, pathname) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  };
  const file = files[pathname];
  if (!file) return false;
  const filePath = path.join(__dirname, 'public', file[0]);
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': file[1],
    'Content-Length': body.length,
    'Cache-Control': pathname === '/' || pathname === '/index.html' ? 'no-store' : 'public, max-age=300',
  });
  res.end(body);
  return true;
}

async function route(req, res) {
  const url = new URL(req.url, config.dashboard.baseUrl);
  const session = sessionFor(req);

  if (req.method === 'GET' && url.pathname === '/auth/discord') {
    return handleOAuthLogin(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/auth/discord/callback') {
    return handleOAuthCallback(req, res, url);
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    return json(res, 200, {
      authenticated: !!session?.user,
      user: session?.user || null,
      csrfToken: session?.user ? session.csrfToken : null,
      bot: botStats(),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/guilds') {
    return guildListApi(res, session);
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, botReady: client.isReady() });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    requireCsrf(req, session);
    sessions.delete(session.id);
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  const guildMatch = url.pathname.match(/^\/api\/guilds\/(\d{17,20})$/);
  if (req.method === 'GET' && guildMatch) return guildDetailApi(res, session, guildMatch[1]);

  const subscriptionsMatch = url.pathname.match(/^\/api\/guilds\/(\d{17,20})\/subscriptions$/);
  if (req.method === 'POST' && subscriptionsMatch) {
    requireCsrf(req, session);
    return addSubscriptionApi(res, session, subscriptionsMatch[1], await readBody(req));
  }

  const subscriptionMatch = url.pathname.match(/^\/api\/guilds\/(\d{17,20})\/subscriptions\/([^/]+)$/);
  if (subscriptionMatch) {
    const [, guildId, encodedName] = subscriptionMatch;
    let name;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      throw new HttpError(400, 'Invalid subscription name.');
    }
    if (req.method === 'PATCH') {
      requireCsrf(req, session);
      return updateSubscriptionApi(res, session, guildId, name, await readBody(req));
    }
    if (req.method === 'DELETE') {
      requireCsrf(req, session);
      return removeSubscriptionApi(res, session, guildId, name);
    }
  }

  if (req.method === 'GET' && serveStatic(res, url.pathname)) return;
  throw new HttpError(404, 'Page not found.');
}

function startDashboard(discordClient) {
  if (!config.dashboard.enabled) {
    console.log('[Dashboard] Disabled with DASHBOARD_ENABLED=false.');
    return null;
  }
  if (!config.clientId || !config.dashboard.clientSecret || !config.dashboard.sessionSecret || !config.token) {
    throw new Error(
      'Dashboard configuration is incomplete. Set DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and SESSION_SECRET.'
    );
  }
  if (config.dashboard.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters.');
  }
  if (process.env.NODE_ENV === 'production' && !config.dashboard.baseUrl.startsWith('https://')) {
    throw new Error('Set DASHBOARD_BASE_URL to your public https:// dashboard URL in production.');
  }

  client = discordClient;
  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(res);
    if (config.dashboard.baseUrl.startsWith('https://')) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    try {
      await route(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError)) console.error('[Dashboard] Request failed:', error);
      if (!res.headersSent) {
        json(res, status, {
          error: error instanceof HttpError ? error.message : 'The dashboard hit an unexpected error.',
        });
      } else {
        res.destroy();
      }
    }
  });

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastSeenAt > SESSION_MAX_AGE_MS) sessions.delete(id);
    }
  }, 60 * 60 * 1000);
  cleanupTimer.unref();

  server.listen(config.dashboard.port, '0.0.0.0', () => {
    console.log(`[Dashboard] Listening on port ${config.dashboard.port}`);
    console.log(`[Dashboard] OAuth callback: ${config.dashboard.baseUrl}/auth/discord/callback`);
  });

  return server;
}

let client;

module.exports = { startDashboard };
