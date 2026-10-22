const fs = require('node:fs');
const path = require('node:path');

// Load a small local .env file for self-hosting without adding a runtime
// dependency. Environment variables supplied by the host always win.
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;

    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadDotEnv();

// A private config.json from older bot installs remains supported as a
// fallback. Never commit it; use .env or host environment variables instead.
let legacy = {};
try {
  legacy = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch {
  // A config.json is optional when environment variables are configured.
}

function envOrLegacy(envName, legacyValue) {
  return process.env[envName] || legacyValue || '';
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const port = Number(process.env.PORT || process.env.DASHBOARD_PORT || 3000);
const legacyWebsub = legacy.websub || {};

module.exports = {
  token: envOrLegacy('DISCORD_BOT_TOKEN', legacy.token),
  clientId: envOrLegacy('DISCORD_CLIENT_ID', legacy.clientId),
  guildId: envOrLegacy('DISCORD_GUILD_ID', legacy.guildId),
  youtubeApiKey: envOrLegacy('YOUTUBE_API_KEY', legacy.youtubeApiKey),
  websub: {
    enabled: boolValue(process.env.WEBSUB_ENABLED, !!legacyWebsub.enabled),
    callbackBaseUrl: envOrLegacy('WEBSUB_CALLBACK_BASE_URL', legacyWebsub.callbackBaseUrl),
    port: Number(process.env.WEBSUB_PORT || legacyWebsub.port || 3001),
  },
  dashboard: {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000,
    baseUrl: (process.env.DASHBOARD_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    clientSecret: process.env.DISCORD_CLIENT_SECRET || legacy.clientSecret || '',
    sessionSecret: process.env.SESSION_SECRET || '',
    enabled: process.env.DASHBOARD_ENABLED !== 'false',
  },
};
