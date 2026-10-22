const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
  MessageFlags,
} = require('discord.js');
const { resolveChannel, getVideoDetails, fetchLatestVideos } = require('../utils/youtube');
const {
  loadChannels,
  saveChannels,
  loadLastVideos,
  saveLastVideos,
  loadLogs,
  appendLogEntry,
  sendNotification,
} = require('../utils/checker');
const { buildNotificationEmbed, buildActionRow } = require('../utils/embeds');

function safeAppendLogEntry(guildId, entry) {
  if (typeof appendLogEntry !== 'function') {
    console.warn('[/yt] appendLogEntry is unavailable; skipping audit log entry.');
    return;
  }

  try {
    appendLogEntry(guildId, entry);
  } catch (error) {
    console.warn('[/yt] Failed to write audit log entry:', error.message);
  }
}

// ─── Command Definition ──────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('yt')
    .setDescription('Manage YouTube upload notifications')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)

    // /yt add
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Subscribe to a YouTube channel')
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('Unique name for this subscription (e.g. "mrbeast")')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('url')
            .setDescription('@handle, YouTube URL, or UC channel ID')
            .setRequired(true)
        )
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Discord channel to post notifications in')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
        .addRoleOption((opt) =>
          opt
            .setName('role')
            .setDescription('Role to ping on new uploads (optional)')
            .setRequired(false)
        )
    )

    // /yt remove
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Unsubscribe from a YouTube channel')
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('Name of the subscription to remove')
            .setRequired(true)
            .setAutocomplete(true)
        )
    )

    // /yt list
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List all active YouTube subscriptions')
    )

    // /yt logs
    .addSubcommand((sub) =>
      sub.setName('logs').setDescription('View recent subscription changes for this server')
    )

    // /yt test
    .addSubcommand((sub) =>
      sub
        .setName('test')
        .setDescription('Preview the notification embed for a YouTube video')
        .addStringOption((opt) =>
          opt
            .setName('url')
            .setDescription('YouTube video URL to test')
            .setRequired(true)
        )
    )

    // /yt force
    .addSubcommand((sub) =>
      sub
        .setName('force')
        .setDescription('Force-send a notification for the latest video of a subscription')
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('Name of the subscription')
            .setRequired(true)
            .setAutocomplete(true)
        )
    ),
            

  // ─── Autocomplete ────────────────────────────────────────────────

  async autocomplete(interaction) {
    if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.respond([]);
    }

    const focused = interaction.options.getFocused().toLowerCase();
    const guildId = interaction.guildId;
    const channels = loadChannels();
    const guildSubs = channels[guildId] || {};
    const choices = Object.keys(guildSubs)
      .filter((name) => name.includes(focused))
      .slice(0, 25)
      .map((name) => ({
        name: `${name} — ${guildSubs[name].youtubeChannelName}`,
        value: name,
      }));

    await interaction.respond(choices);
  },

  // ─── Execute ─────────────────────────────────────────────────────

  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      const payload = {
        content: '❌ This command is restricted to server administrators only.',
        ephemeral: true,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
      return;
    }

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'add':
        return handleAdd(interaction);
      case 'remove':
        return handleRemove(interaction);
      case 'list':
        return handleList(interaction);
      case 'logs':
        return handleLogs(interaction);
      case 'test':
        return handleTest(interaction);
      case 'force':
        return handleForce(interaction);
    }
  },
};

// ─── Subcommand Handlers ─────────────────────────────────────────────

async function handleAdd(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId;
  if (!guildId) {
    return interaction.editReply({ content: '❌ This command can only be used in a server.' });
  }

  const name = interaction.options.getString('name').toLowerCase().replace(/\s+/g, '-');
  const url = interaction.options.getString('url');
  const discordChannel = interaction.options.getChannel('channel');
  const role = interaction.options.getRole('role');

  const channels = loadChannels();
  if (!channels[guildId]) {
    channels[guildId] = {};
  }

  if (channels[guildId][name]) {
    return interaction.editReply({
      content: `❌ A subscription named **\`${name}\`** already exists. Use a different name or remove it first.`,
    });
  }

  try {
    const resolved = await resolveChannel(url);

    const videos = await fetchLatestVideos(resolved.id, 1);

    const subscription = {
      youtubeChannelId: resolved.id,
      youtubeChannelName: resolved.name,
      handle: resolved.handle,
      avatar: resolved.avatar,
      discordChannelId: discordChannel.id,
      roleId: role?.id || null,
      addedBy: interaction.user.id,
      addedAt: new Date().toISOString(),
    };

    // Save subscription only after the feed check succeeds.
    channels[guildId][name] = subscription;
    saveChannels(channels);

    if (videos.length > 0) {
      const lastVideos = loadLastVideos();
      if (!lastVideos[guildId]) lastVideos[guildId] = {};
      lastVideos[guildId][name] = [videos[0].id];
      saveLastVideos(lastVideos);
    }

    // Confirmation embed
    const embed = new EmbedBuilder()
      .setColor(0x57f287) // Discord green
      .setTitle('✅  YouTube Subscription Added')
      .addFields(
        { name: 'Subscription', value: `\`${name}\``, inline: true },
        { name: 'YouTube Channel', value: resolved.name, inline: true },
        { name: '\u200b', value: '\u200b', inline: true }, // spacer
        { name: 'Channel ID', value: `\`${resolved.id}\``, inline: false },
        { name: 'Notify In', value: `<#${discordChannel.id}>`, inline: true },
        { name: 'Ping Role', value: role ? `<@&${role.id}>` : '*None*', inline: true }
      )
      .setTimestamp();

    if (resolved.avatar) {
      embed.setThumbnail(resolved.avatar);
    }

    safeAppendLogEntry(guildId, {
      action: 'add',
      subscriptionName: name,
      channelName: resolved.name,
      youtubeChannelId: resolved.id,
      discordChannelId: discordChannel.id,
      roleId: role?.id || null,
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      details: `Added subscription ${name}`,
    });

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    if (error?.code === 'YOUTUBE_CHANNEL_NOT_FOUND') {
      return interaction.editReply({
        content: '❌ That YouTube channel feed returned 404, so the subscription was not added.',
      });
    }

    console.error('[/yt add]', error);
    return interaction.editReply({
      content: `❌ **Failed to resolve YouTube channel.**\n\`\`\`${error.message}\`\`\``,
    });
  }
}

async function handleRemove(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId;
  if (!guildId) {
     return interaction.editReply({ content: '❌ This command can only be used in a server.' });
  }

  const name = interaction.options.getString('name').toLowerCase();
  const channels = loadChannels();
  const guildSubs = channels[guildId] || {};

  if (!guildSubs[name]) {
     return interaction.editReply({
      content: `❌ No subscription found named **\`${name}\`** in this server.`,
    });
  }

  const removed = guildSubs[name];
  delete channels[guildId][name];
  if (Object.keys(channels[guildId]).length === 0) {
    delete channels[guildId];
  }
  saveChannels(channels);

  // Clean up last-video tracking
  const lastVideos = loadLastVideos();
  if (lastVideos[guildId]) {
    delete lastVideos[guildId][name];
    if (Object.keys(lastVideos[guildId]).length === 0) {
      delete lastVideos[guildId];
    }
    saveLastVideos(lastVideos);
  }

  safeAppendLogEntry(guildId, {
    action: 'remove',
    subscriptionName: name,
    channelName: removed.youtubeChannelName,
    youtubeChannelId: removed.youtubeChannelId,
    discordChannelId: removed.discordChannelId,
    roleId: removed.roleId || null,
    actorId: interaction.user.id,
    actorTag: interaction.user.tag,
    details: `Removed subscription ${name}`,
  });

  const embed = new EmbedBuilder()
    .setColor(0xed4245) // Discord red
    .setTitle('🗑  Subscription Removed')
    .setDescription(
      `Unsubscribed from **${removed.youtubeChannelName}** (\`${name}\`).\n` +
      `Notifications will no longer be sent to <#${removed.discordChannelId}>.`
    )
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

async function handleList(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    return interaction.reply({ content: '❌ This command can only be used in a server.', flags: MessageFlags.Ephemeral });
  }

  const channels = loadChannels();
  const guildSubs = channels[guildId] || {};
  const entries = Object.entries(guildSubs);

  if (entries.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2) // Discord blurple
      .setTitle('📺  YouTube Subscriptions')
      .setDescription('No subscriptions configured yet for this server.\nUse `/yt add` to get started!')
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('📺  YouTube Subscriptions')
    .setDescription(`Monitoring **${entries.length}** channel(s) in this server — checking every 30 seconds.`)
    .setTimestamp();

  for (const [name, config] of entries) {
    const handle = config.handle ? ` (${config.handle})` : '';
    embed.addFields({
      name: `📌  ${name}`,
      value: [
        `**Channel:** ${config.youtubeChannelName}${handle}`,
        `**ID:** \`${config.youtubeChannelId}\``,
        `**Notify:** <#${config.discordChannelId}>`,
        `**Ping:** ${config.roleId ? `<@&${config.roleId}>` : '*None*'}`,
      ].join('\n'),
      inline: false,
    });
  }

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleLogs(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId;
  if (!guildId) {
      return interaction.editReply({ content: '❌ This command can only be used in a server.' });
  }

  const logs = loadLogs();
  const guildLogs = logs[guildId] || [];

  if (guildLogs.length === 0) {
      const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🧾  YouTube Audit Logs')
      .setDescription('No subscription changes have been recorded for this server yet.')
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('🧾  YouTube Audit Logs')
    .setDescription(`Showing the most recent **${Math.min(guildLogs.length, 10)}** change(s) for this server.`)
    .setTimestamp();

  for (const entry of guildLogs.slice(0, 10)) {
    const timestamp = Math.floor(new Date(entry.createdAt).getTime() / 1000);
    const actorLine = entry.actorId ? `<@${entry.actorId}>` : entry.actorTag || '*Unknown*';
    const subscriptionLine = entry.subscriptionName ? `\`${entry.subscriptionName}\`` : '*Unknown*';
    const channelLine = entry.channelName || '*Unknown channel*';
    const detailsLine = entry.details || `${entry.action || 'update'} event`;
    const actionLabel = entry.action === 'add' ? 'Added' : entry.action === 'remove' ? 'Removed' : entry.action === 'force' ? 'Force Sent' : 'Updated';
    const actionEmoji = entry.action === 'add' ? '➕' : entry.action === 'remove' ? '🗑' : entry.action === 'force' ? '⚡' : '📝';

    embed.addFields({
      name: `${actionEmoji}  ${actionLabel}`,
      value: [
        `**Subscription:** ${subscriptionLine}`,
        `**Channel:** ${channelLine}`,
        `**By:** ${actorLine}`,
        `**When:** <t:${timestamp}:F> (<t:${timestamp}:R>)`,
        `**Details:** ${detailsLine}`,
      ].join('\n'),
      inline: false,
    });
  }

  return interaction.editReply({ embeds: [embed] });
}

async function handleTest(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const url = interaction.options.getString('url');

  // Extract video ID from various URL formats
  const videoIdMatch = url.match(
    /(?:v=|\/(?:embed|shorts|live)\/|youtu\.be\/)([\w-]{11})/
  );

  if (!videoIdMatch) {
    return interaction.editReply({
      content: '❌ **Invalid YouTube video URL.**\nExpected a link like `https://youtube.com/watch?v=...`',
    });
  }

  const videoId = videoIdMatch[1];

  try {
    const details = await getVideoDetails(videoId);
    if (!details) {
      return interaction.editReply({
        content: '❌ Could not fetch video details. The video may be private or deleted.',
      });
    }

    const embed = buildNotificationEmbed(details, {});
    const row = buildActionRow(details);

    return interaction.editReply({
      content: '🧪 **Embed Preview** — this is how a notification would look:',
      embeds: [embed],
      components: [row],
    });
  } catch (error) {
    console.error('[/yt test]', error);
    return interaction.editReply({
      content: `❌ **Error:** \`${error.message}\``,
    });
  }
}

async function handleForce(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId;
  if (!guildId) {
    return interaction.editReply({ content: '❌ This command can only be used in a server.' });
  }

  const name = interaction.options.getString('name').toLowerCase();
  const channels = loadChannels();
  const guildSubs = channels[guildId] || {};

  if (!guildSubs[name]) {
    return interaction.editReply({
      content: `❌ No subscription found named **\`${name}\`** in this server.`,
    });
  }

  const config = guildSubs[name];

  try {
    const videos = await fetchLatestVideos(config.youtubeChannelId, 1);
    if (videos.length === 0) {
      return interaction.editReply({
        content: '❌ No videos found on this channel\'s RSS feed.',
      });
    }

    const details = await getVideoDetails(
      videos[0].id,
      videos[0].title,
      videos[0].author,
      videos[0].isLiveHint || false
    );
    if (!details) {
      return interaction.editReply({
        content: '❌ Could not fetch video details.',
      });
    }

    // Send the notification to the configured channel
    await sendNotification(interaction.client, config, details);

    safeAppendLogEntry(guildId, {
      action: 'force',
      subscriptionName: name,
      channelName: config.youtubeChannelName,
      youtubeChannelId: config.youtubeChannelId,
      discordChannelId: config.discordChannelId,
      roleId: config.roleId || null,
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      details: `Force sent notification for ${details.title}`,
    });

    // Update last-video tracking
    const lastVideos = loadLastVideos();
    if (!lastVideos[guildId]) {
      lastVideos[guildId] = {};
    }
    let previousVideoIds = lastVideos[guildId][name];
    if (typeof previousVideoIds === 'string') {
      previousVideoIds = [previousVideoIds];
    } else if (!Array.isArray(previousVideoIds)) {
      previousVideoIds = [];
    }
    if (!previousVideoIds.includes(videos[0].id)) {
      previousVideoIds.unshift(videos[0].id);
      if (previousVideoIds.length > 10) {
        previousVideoIds = previousVideoIds.slice(0, 10);
      }
    }
    lastVideos[guildId][name] = previousVideoIds;
    saveLastVideos(lastVideos);

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅  Force Notification Sent')
      .setDescription(
        `Sent notification for **${details.title}** to <#${config.discordChannelId}>.`
      )
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    if (error?.code === 'YOUTUBE_CHANNEL_NOT_FOUND') {
      return interaction.editReply({
        content: '❌ That YouTube channel feed returned 404, so this subscription is no longer valid.',
      });
    }

    console.error('[/yt force]', error);
    return interaction.editReply({
      content: `❌ **Error:** \`${error.message}\``,
    });
  }
}
