const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

/**
 * Build the notification embed for a new video / stream / short.
 *
 * @param {object} video   – Video details from getVideoDetails()
 * @param {object} config  – Subscription config from channels.json
 * @returns {EmbedBuilder}
 */
function buildNotificationEmbed(video, config = {}) {
  const { title, channelName, channelId, id, isLive, isUpcoming, isShort, duration, viewCount } =
    video;

  // ── Status badge ──
  let statusText, statusEmoji;
  if (isLive) {
    statusText = 'LIVE NOW';
    statusEmoji = '🔴';
  } else if (isUpcoming) {
    statusText = 'PREMIERING SOON';
    statusEmoji = '⏰';
  } else if (isShort) {
    statusText = 'NEW SHORT';
    statusEmoji = '📱';
  } else {
    statusText = 'NEW UPLOAD';
    statusEmoji = '📹';
  }

  const embed = new EmbedBuilder()
    .setColor(0xff0000) // YouTube red
    .setAuthor({
      name: channelName || config.youtubeChannelName || 'YouTube',
      url: `https://www.youtube.com/channel/${channelId || config.youtubeChannelId}`,
      iconURL: config.avatar || undefined,
    })
    .setTitle(`${statusEmoji}  ${title}`)
    .setURL(`https://www.youtube.com/watch?v=${id}`)
    .setImage(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`)
    .setFooter({
      text: `YouTube  •  ${statusText}`,
      iconURL: 'https://www.youtube.com/s/desktop/271dfaff/img/favicon_144x144.png',
    })
    .setTimestamp();

  // ── Fields ──
  const fields = [];

  if (duration && !isLive && !isUpcoming) {
    const hrs = Math.floor(duration / 3600);
    const mins = Math.floor((duration % 3600) / 60);
    const secs = duration % 60;
    const parts = [];
    if (hrs) parts.push(`${hrs}h`);
    parts.push(`${mins}m`);
    parts.push(`${secs.toString().padStart(2, '0')}s`);
    fields.push({ name: '⏱ Duration', value: parts.join(' '), inline: true });
  }

  if (isLive && viewCount) {
    fields.push({
      name: '👀 Watching',
      value: viewCount.toLocaleString(),
      inline: true,
    });
  }

  if (fields.length > 0) {
    embed.addFields(fields);
  }

  return embed;
}

/**
 * Build the action-row buttons for the notification message.
 *
 * @param {object} video – Video details from getVideoDetails()
 * @returns {ActionRowBuilder}
 */
function buildActionRow(video) {
  const { id, channelId, isLive } = video;

  const watchButton = new ButtonBuilder()
    .setLabel(isLive ? '🔴 Watch Stream' : '▶ Watch Video')
    .setStyle(ButtonStyle.Link)
    .setURL(`https://www.youtube.com/watch?v=${id}`);

  const channelButton = new ButtonBuilder()
    .setLabel('📺 Visit Channel')
    .setStyle(ButtonStyle.Link)
    .setURL(`https://www.youtube.com/channel/${channelId}`);

  return new ActionRowBuilder().addComponents(watchButton, channelButton);
}

module.exports = { buildNotificationEmbed, buildActionRow };
