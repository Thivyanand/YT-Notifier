const app = document.getElementById('app');
const toastElement = document.getElementById('toast');

const state = {
  session: null,
  guilds: [],
  bot: null,
  selectedGuildId: null,
  detail: null,
  loadingGuild: false,
  loadError: '',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function avatarUrl(user) {
  if (!user?.avatar) return '';
  const extension = user.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.${extension}?size=80`;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET' && state.session?.csrfToken) {
    headers['X-CSRF-Token'] = state.session.csrfToken;
  }
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      state.session = { authenticated: false };
      render();
    }
    throw new Error(payload.error || 'Something went wrong. Please try again.');
  }
  return payload;
}

function showToast(message, type = 'success') {
  toastElement.textContent = message;
  toastElement.className = `toast toast-${type} toast-visible`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastElement.classList.remove('toast-visible'), 3400);
}

function initials(value) {
  return String(value || '?').trim().split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase();
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function displayUserName(user) {
  return user?.global_name || user?.username || 'Discord user';
}

function botStatus(bot) {
  return bot?.ready ? 'Online' : 'Starting';
}

function renderAuth() {
  const failed = new URLSearchParams(window.location.search).get('signin') === 'failed';
  const startupError = state.loadError
    ? `<div class="inline-alert">${escapeHtml(state.loadError)} <button data-action="retry-start">Retry</button></div>`
    : '';
  app.innerHTML = `
    <main class="login-page">
      <div class="login-grid" aria-hidden="true"></div>
      <section class="login-card">
        <div class="brand-lockup"><span class="brand-mark">Y</span><span>YT <strong>NOTIFIER</strong></span></div>
        <div class="login-art" aria-hidden="true">
          <div class="orbit orbit-one"></div><div class="orbit orbit-two"></div>
          <div class="play-tile"><span class="play-triangle"></span></div>
          <span class="art-dot art-dot-one"></span><span class="art-dot art-dot-two"></span>
          <span class="art-line"></span>
        </div>
        <p class="eyebrow">YOUR DISCORD, IN SYNC</p>
        <h1>YouTube updates,<br><em>right where they belong.</em></h1>
        <p class="login-copy">Connect your Discord account to manage upload alerts, live streams, and Shorts across your servers.</p>
        ${failed ? '<div class="inline-alert">Discord sign-in did not finish. Please try again.</div>' : startupError}
        <a class="button button-discord button-wide" href="/auth/discord">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.7 5.2a18.5 18.5 0 0 0-4.6-1.4l-.6 1.2a17 17 0 0 0-5 0L9 3.8a18.5 18.5 0 0 0-4.6 1.4C1.5 9.4.7 13.5 1.1 17.6a18.6 18.6 0 0 0 5.7 2.9l1.2-2a12 12 0 0 1-1.9-.9l.5-.4a13.2 13.2 0 0 0 11 0l.5.4a12 12 0 0 1-1.9.9l1.2 2a18.6 18.6 0 0 0 5.7-2.9c.5-4.7-.8-8.8-3.4-12.4ZM8.7 15.3c-1.1 0-2-1-2-2.2s.9-2.2 2-2.2 2 .9 2 2.2-.9 2.2-2 2.2Zm6.6 0c-1.1 0-2-1-2-2.2s.9-2.2 2-2.2 2 .9 2 2.2-.9 2.2-2 2.2Z"/></svg>
          Continue with Discord <span class="button-arrow">↗</span>
        </a>
        <div class="login-foot"><span class="lock-icon">⌑</span> Only server administrators can manage subscriptions.</div>
      </section>
      <footer class="login-footer"><span>YT-NOTIFIER <i>•</i> DISCORD CONTROL PANEL</span><span>Built for creators who never miss an upload.</span></footer>
    </main>`;
}

function userControl() {
  const user = state.session?.user;
  const image = avatarUrl(user);
  return `<div class="user-control">
    ${image ? `<img class="user-avatar" src="${escapeHtml(image)}" alt="">` : `<span class="user-avatar user-avatar-fallback">${escapeHtml(initials(displayUserName(user)))}</span>`}
    <span class="user-name">${escapeHtml(displayUserName(user))}</span>
    <button class="icon-button" data-action="logout" aria-label="Sign out" title="Sign out">↗</button>
  </div>`;
}

function shell(content, active = 'Overview') {
  const online = state.bot?.ready;
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand-lockup sidebar-brand" href="/" aria-label="YT-Notifier home"><span class="brand-mark">Y</span><span>YT <strong>NOTIFIER</strong></span></a>
        <div class="sidebar-label">WORKSPACE</div>
        <button class="nav-item ${active === 'Overview' ? 'nav-active' : ''}" data-action="overview"><span class="nav-icon">◫</span><span>Overview</span></button>
        ${state.selectedGuildId ? `<button class="nav-item ${active === 'Subscriptions' ? 'nav-active' : ''}" data-action="subscriptions"><span class="nav-icon">◉</span><span>Subscriptions</span><span class="nav-count">${state.detail?.subscriptions?.length || 0}</span></button>` : ''}
        <div class="sidebar-spacer"></div>
        <div class="bot-status-card">
          <span class="status-pulse ${online ? 'pulse-live' : ''}"></span>
          <div><strong>Bot ${escapeHtml(botStatus(state.bot))}</strong><span>${online ? `${formatNumber(state.bot?.guildCount)} servers connected` : 'Connecting to Discord'}</span></div>
          <span class="status-dot ${online ? 'dot-live' : ''}"></span>
        </div>
        <div class="sidebar-profile">${userControl()}</div>
      </aside>
      <main class="main-area">
        <header class="topbar">
          <div class="breadcrumb"><span>YT-NOTIFIER</span><b>/</b><strong>${escapeHtml(active)}</strong></div>
          <div class="topbar-actions"><span class="connection-label"><i class="connection-dot ${online ? 'dot-live' : ''}"></i>${online ? 'All systems operational' : 'Bot is starting'}</span><button class="refresh-button" data-action="refresh" aria-label="Refresh servers" title="Refresh">↻</button></div>
        </header>
        <div class="page-content">${content}</div>
      </main>
    </div>`;
}

function guildIcon(guild, sizeClass = '') {
  return guild.iconUrl
    ? `<img class="guild-icon ${sizeClass}" src="${escapeHtml(guild.iconUrl)}" alt="">`
    : `<span class="guild-icon guild-icon-fallback ${sizeClass}">${escapeHtml(initials(guild.name))}</span>`;
}

function guildCard(guild) {
  return `<article class="server-card ${guild.installed ? '' : 'server-card-setup'}">
    <div class="server-card-top">${guildIcon(guild)}<span class="server-card-arrow">↗</span></div>
    <div class="server-card-copy"><h3>${escapeHtml(guild.name)}</h3><p>${guild.installed ? `${formatNumber(guild.subscriptionCount)} active ${guild.subscriptionCount === 1 ? 'feed' : 'feeds'}` : 'Add the bot to get started'}</p></div>
    <div class="server-card-bottom">
      <span class="server-state ${guild.installed ? 'server-state-ready' : 'server-state-setup'}"><i></i>${guild.installed ? 'CONNECTED' : 'SETUP REQUIRED'}</span>
      ${guild.installed
        ? `<button class="text-action" data-action="open-guild" data-guild="${escapeHtml(guild.id)}">Manage <span>→</span></button>`
        : `<a class="text-action" href="${escapeHtml(guild.inviteUrl)}" target="_blank" rel="noopener noreferrer">Add bot <span>↗</span></a>`}
    </div>
  </article>`;
}

function renderOverview() {
  const installed = state.guilds.filter((guild) => guild.installed);
  const setup = state.guilds.filter((guild) => !guild.installed);
  const totalFeeds = installed.reduce((sum, guild) => sum + guild.subscriptionCount, 0);
  const guildCards = state.guilds.length
    ? state.guilds.map(guildCard).join('')
    : `<div class="empty-state"><span class="empty-icon">⌂</span><h3>No administrator servers found</h3><p>Sign in with an account that has administrator access to a Discord server.</p></div>`;

  return shell(`
    <section class="welcome-row">
      <div><p class="eyebrow">CONTROL ROOM <span>•</span> ${escapeHtml(new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(new Date()).toUpperCase())}</p><h1>Your servers<span class="heading-period">.</span></h1><p class="section-subtitle">Manage YouTube notifications across your Discord communities.</p></div>
      <div class="welcome-decoration" aria-hidden="true"><span class="welcome-ring"></span><span class="welcome-play">▶</span><span class="welcome-spark">✳</span></div>
    </section>
    <section class="metrics-grid">
      <article class="metric-card metric-primary"><div class="metric-heading"><span>BOT STATUS</span><span class="metric-icon">◉</span></div><div class="metric-value"><i class="metric-live ${state.bot?.ready ? 'dot-live' : ''}"></i>${escapeHtml(botStatus(state.bot))}</div><div class="metric-foot">${state.bot?.ready ? `${formatNumber(state.bot?.ping)} ms gateway latency` : 'Connecting to Discord gateway'}</div></article>
      <article class="metric-card"><div class="metric-heading"><span>CONNECTED SERVERS</span><span class="metric-icon">⌂</span></div><div class="metric-value">${formatNumber(installed.length)}<small> / ${formatNumber(state.guilds.length)}</small></div><div class="metric-foot">Servers you can administer</div></article>
      <article class="metric-card"><div class="metric-heading"><span>ACTIVE FEEDS</span><span class="metric-icon metric-icon-red">▶</span></div><div class="metric-value">${formatNumber(totalFeeds)}</div><div class="metric-foot">Watching for new uploads and live streams</div></article>
    </section>
    ${state.loadError ? `<div class="inline-alert page-alert">${escapeHtml(state.loadError)} <button data-action="refresh">Try again</button></div>` : ''}
    <section class="section-block"><div class="section-heading"><div><p class="eyebrow">SERVER ACCESS</p><h2>Choose a server</h2></div><span class="section-count">${formatNumber(state.guilds.length)} ${state.guilds.length === 1 ? 'SERVER' : 'SERVERS'}</span></div><div class="server-grid">${guildCards}</div></section>
    ${setup.length ? `<section class="setup-note"><span class="setup-note-icon">＋</span><div><strong>Ready to connect ${setup.length === 1 ? 'another server' : `${setup.length} more servers`}?</strong><p>Add YT-Notifier to a server you administer, then manage it here.</p></div></section>` : ''}
  `);
}

function channelOptions(selectedId) {
  const channels = state.detail?.channels || [];
  const first = channels.length ? '<option value="">Choose a channel</option>' : '<option value="">No bot-accessible channels</option>';
  return first + channels.map((channel) => `<option value="${escapeHtml(channel.id)}" ${channel.id === selectedId ? 'selected' : ''}># ${escapeHtml(channel.name)}</option>`).join('');
}

function roleOptions(selectedId) {
  const roles = state.detail?.roles || [];
  return '<option value="">No role ping</option>' + roles.map((role) => `<option value="${escapeHtml(role.id)}" ${role.id === selectedId ? 'selected' : ''}>@ ${escapeHtml(role.name)}</option>`).join('');
}

function renderSubscription(subscription) {
  const icon = initials(subscription.youtubeChannelName);
  return `<article class="subscription-row" data-subscription="${escapeHtml(subscription.name)}">
    <div class="subscription-identity"><span class="youtube-avatar">${escapeHtml(icon)}</span><div><div class="subscription-name">${escapeHtml(subscription.name)}<span class="feed-status"><i></i> ACTIVE</span></div><div class="youtube-name">${escapeHtml(subscription.youtubeChannelName)}${subscription.handle ? ` <span>${escapeHtml(subscription.handle)}</span>` : ''}</div></div></div>
    <div class="subscription-controls">
      <label class="compact-field"><span>POST TO</span><select data-field="channel" aria-label="Notification channel for ${escapeHtml(subscription.name)}">${channelOptions(subscription.discordChannelId)}</select></label>
      <label class="compact-field"><span>ROLE PING</span><select data-field="role" aria-label="Ping role for ${escapeHtml(subscription.name)}">${roleOptions(subscription.roleId)}</select></label>
      <button class="button button-small button-outline save-subscription" data-action="save-subscription" data-name="${escapeHtml(subscription.name)}">Save</button>
      <button class="icon-button delete-button" data-action="delete-subscription" data-name="${escapeHtml(subscription.name)}" aria-label="Remove ${escapeHtml(subscription.name)}" title="Remove subscription">×</button>
    </div>
    <div class="subscription-meta"><span>YouTube channel ID <code>${escapeHtml(subscription.youtubeChannelId)}</code></span><span>Added ${escapeHtml(formatDate(subscription.addedAt))}</span></div>
  </article>`;
}

function renderLog(entry) {
  const labels = { add: 'Added feed', remove: 'Removed feed', update: 'Updated settings', force: 'Sent test alert' };
  const icon = entry.action === 'remove' ? '−' : entry.action === 'add' ? '+' : '↗';
  return `<div class="activity-item"><span class="activity-icon activity-${escapeHtml(entry.action || 'update')}">${icon}</span><div class="activity-copy"><strong>${escapeHtml(labels[entry.action] || 'Changed a feed')}</strong><span>${escapeHtml(entry.subscriptionName || 'Subscription')} · ${escapeHtml(entry.actorTag || 'Unknown user')}</span></div><time>${escapeHtml(formatDate(entry.createdAt))}</time></div>`;
}

function renderGuildDetail() {
  if (state.loadingGuild) return shell('<div class="loading-state"><span class="spinner"></span><p>Loading server settings…</p></div>', 'Subscriptions');
  if (state.loadError && !state.detail) return shell(`<button class="back-link" data-action="overview">← All servers</button><div class="empty-state"><h3>Could not load this server</h3><p>${escapeHtml(state.loadError)}</p><button class="button button-primary" data-action="refresh">Try again</button></div>`, 'Subscriptions');
  if (!state.detail) return renderOverview();

  const detail = state.detail;
  const subscriptions = detail.subscriptions || [];
  const channelsDisabled = !detail.channels?.length;
  const audit = detail.logs?.length ? detail.logs.map(renderLog).join('') : '<div class="activity-empty">Changes made in the dashboard or with /yt will appear here.</div>';
  return shell(`
    <button class="back-link" data-action="overview">← All servers</button>
    <section class="guild-heading"><div class="guild-title-lockup">${guildIcon(detail.guild, 'guild-icon-large')}<div><p class="eyebrow">SERVER SETTINGS <span>•</span> CONNECTED</p><h1>${escapeHtml(detail.guild.name)}<span class="heading-period">.</span></h1><p class="section-subtitle">Manage feeds and where notifications are delivered.</p></div></div><a class="server-id" href="https://discord.com/channels/${escapeHtml(detail.guild.id)}" target="_blank" rel="noopener noreferrer">SERVER ID <code>${escapeHtml(detail.guild.id)}</code><span>↗</span></a></section>
    <section class="guild-metrics"><article class="guild-metric"><span>ACTIVE FEEDS</span><strong>${formatNumber(subscriptions.length)}</strong></article><article class="guild-metric"><span>POST DESTINATIONS</span><strong>${formatNumber(new Set(subscriptions.map((item) => item.discordChannelId)).size)}</strong></article><article class="guild-metric"><span>AVAILABLE CHANNELS</span><strong>${formatNumber(detail.channels?.length || 0)}</strong></article><div class="guild-online"><i class="connection-dot ${detail.bot?.ready ? 'dot-live' : ''}"></i> Bot ${escapeHtml(botStatus(detail.bot))}</div></section>
    <div class="management-layout">
      <div class="management-main">
        <section class="panel add-panel"><div class="panel-heading"><div><p class="eyebrow">NEW SOURCE</p><h2>Add a YouTube feed</h2></div><span class="panel-step">01 <i>/</i> 01</span></div>
          <form id="add-feed-form" class="add-feed-form">
            <label class="form-field form-field-full"><span>SUBSCRIPTION NAME</span><input name="name" maxlength="48" placeholder="e.g. mrbeast" pattern="[A-Za-z0-9][A-Za-z0-9-]{0,47}" required><small>A short name used to identify this feed in Discord.</small></label>
            <label class="form-field form-field-full"><span>YOUTUBE CHANNEL</span><input name="youtubeUrl" maxlength="300" placeholder="@handle or YouTube channel URL" required><small>Paste a channel link, UC channel ID, or @handle.</small></label>
            <label class="form-field"><span>NOTIFY IN</span><select name="discordChannelId" required ${channelsDisabled ? 'disabled' : ''}>${channelOptions('')}</select></label>
            <label class="form-field"><span>ROLE PING <em>OPTIONAL</em></span><select name="roleId">${roleOptions(null)}</select></label>
            <div class="form-submit"><span class="form-hint">New feeds start from the latest upload.</span><button class="button button-primary" type="submit" ${channelsDisabled ? 'disabled' : ''}>Add feed <span>＋</span></button></div>
            ${channelsDisabled ? '<div class="inline-alert form-alert">The bot needs View Channel, Send Messages, and Embed Links in at least one text channel.</div>' : ''}
          </form>
        </section>
        <section class="panel feeds-panel"><div class="panel-heading"><div><p class="eyebrow">MONITORING</p><h2>Your feeds <span class="heading-count">${formatNumber(subscriptions.length)}</span></h2></div><span class="polling-label"><i></i> CHECKING EVERY 30 SEC</span></div>
          ${subscriptions.length ? `<div class="subscription-list">${subscriptions.map(renderSubscription).join('')}</div>` : '<div class="empty-feed"><span class="empty-feed-icon">▶</span><strong>No feeds yet</strong><p>Add a YouTube channel above to start sending upload alerts to this server.</p></div>'}
        </section>
      </div>
      <aside class="management-aside"><section class="panel activity-panel"><div class="panel-heading"><div><p class="eyebrow">RECENT CHANGES</p><h2>Activity</h2></div><span class="activity-live">LIVE</span></div><div class="activity-list">${audit}</div><div class="activity-footer">Changes from this dashboard and <code>/yt</code> are recorded.</div></section><div class="aside-tip"><span class="tip-spark">✳</span><div><strong>One feed. Every moment.</strong><p>New uploads, Shorts, and live streams are checked automatically.</p></div></div></aside>
    </div>
  `, 'Subscriptions');
}

function render() {
  if (!state.session?.authenticated) {
    renderAuth();
    return;
  }
  app.innerHTML = state.selectedGuildId ? renderGuildDetail() : renderOverview();
}

async function loadOverview() {
  state.loadError = '';
  try {
    const result = await api('/api/guilds');
    state.guilds = result.guilds || [];
    state.bot = result.bot || state.bot;
  } catch (error) {
    state.loadError = error.message;
  }
  render();
}

async function loadGuild(guildId) {
  state.selectedGuildId = guildId;
  state.detail = null;
  state.loadError = '';
  state.loadingGuild = true;
  render();
  try {
    state.detail = await api(`/api/guilds/${encodeURIComponent(guildId)}`);
    state.bot = state.detail.bot || state.bot;
  } catch (error) {
    state.loadError = error.message;
  }
  state.loadingGuild = false;
  render();
}

async function refreshCurrent() {
  if (state.selectedGuildId) await loadGuild(state.selectedGuildId);
  else await loadOverview();
}

function submitButton(button, busy, text) {
  if (!button) return;
  button.disabled = busy;
  button.dataset.originalText ||= button.innerHTML;
  button.innerHTML = busy ? `<span class="button-spinner"></span>${escapeHtml(text || 'Saving…')}` : button.dataset.originalText;
}

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;

  if (action === 'overview' || action === 'back') {
    state.selectedGuildId = null;
    state.detail = null;
    state.loadError = '';
    await loadOverview();
  } else if (action === 'subscriptions') {
    if (state.selectedGuildId) renderGuildDetail();
  } else if (action === 'retry-start') {
    await start();
  } else if (action === 'open-guild') {
    await loadGuild(button.dataset.guild);
  } else if (action === 'refresh') {
    button.classList.add('is-spinning');
    await refreshCurrent();
    button.classList.remove('is-spinning');
    showToast('Dashboard refreshed.');
  } else if (action === 'logout') {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* The session may already have expired. */ }
    state.session = { authenticated: false };
    state.guilds = [];
    state.selectedGuildId = null;
    state.detail = null;
    render();
  } else if (action === 'save-subscription') {
    const card = button.closest('[data-subscription]');
    const name = button.dataset.name;
    const channelId = card.querySelector('[data-field="channel"]').value;
    const roleId = card.querySelector('[data-field="role"]').value || null;
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      await api(`/api/guilds/${encodeURIComponent(state.selectedGuildId)}/subscriptions/${encodeURIComponent(name)}`, {
        method: 'PATCH', body: JSON.stringify({ discordChannelId: channelId, roleId }),
      });
      await loadGuild(state.selectedGuildId);
      showToast('Delivery settings saved.');
    } catch (error) {
      button.disabled = false;
      button.innerHTML = original;
      showToast(error.message, 'error');
    }
  } else if (action === 'delete-subscription') {
    const name = button.dataset.name;
    if (!window.confirm(`Remove the “${name}” YouTube feed from this server?`)) return;
    button.disabled = true;
    try {
      await api(`/api/guilds/${encodeURIComponent(state.selectedGuildId)}/subscriptions/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await loadGuild(state.selectedGuildId);
      showToast('YouTube feed removed.');
    } catch (error) {
      button.disabled = false;
      showToast(error.message, 'error');
    }
  }
});

app.addEventListener('submit', async (event) => {
  if (event.target.id !== 'add-feed-form') return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('button[type="submit"]');
  const formData = new FormData(form);
  const body = {
    name: formData.get('name'),
    youtubeUrl: formData.get('youtubeUrl'),
    discordChannelId: formData.get('discordChannelId'),
    roleId: formData.get('roleId') || null,
  };
  submitButton(button, true, 'Adding feed…');
  try {
    const result = await api(`/api/guilds/${encodeURIComponent(state.selectedGuildId)}/subscriptions`, {
      method: 'POST', body: JSON.stringify(body),
    });
    await loadGuild(state.selectedGuildId);
    showToast(`${result.youtubeChannelName} added to this server.`);
  } catch (error) {
    submitButton(button, false);
    showToast(error.message, 'error');
  }
});

async function start() {
  state.loadError = '';
  try {
    state.session = await api('/api/session');
  } catch (error) {
    state.session = { authenticated: false };
    state.loadError = error.message;
  }
  render();
  if (state.session.authenticated) await loadOverview();
  if (new URLSearchParams(window.location.search).get('signin') === 'failed') {
    window.history.replaceState({}, '', '/');
  }
}

start();
