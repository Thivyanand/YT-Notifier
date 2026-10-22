const { Client, Collection, GatewayIntentBits, Events } = require('discord.js');
const config = require('./config');
const ytCommand = require('./commands/yt');
const { startChecker } = require('./utils/checker');
const { startDashboard } = require('./dashboard/server');

// ─── Client Setup ────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

// ─── Load Commands ───────────────────────────────────────────────────

client.commands = new Collection();
client.commands.set(ytCommand.data.name, ytCommand);

// ─── Interaction Handler ─────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  // Autocomplete
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (command?.autocomplete) {
      try {
        await command.autocomplete(interaction);
      } catch (error) {
        console.error(`[Autocomplete] Error in /${interaction.commandName}:`, error);
      }
    }
    return;
  }

  // Slash commands
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    const subcommand = interaction.options?.getSubcommand?.(false);
    const commandLabel = subcommand ? `/${interaction.commandName} ${subcommand}` : `/${interaction.commandName}`;
    console.error(`[Command] Error executing ${commandLabel}:`, error);

    const errorPayload = {
      content: '❌ An unexpected error occurred while running this command.',
      ephemeral: true,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorPayload).catch(() => {});
    } else {
      await interaction.reply(errorPayload).catch(() => {});
    }
  }
});

// ─── Ready ───────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  console.log('');
  console.log('┌──────────────────────────────────────────┐');
  console.log('│        📺  YT-Notifier  v1.2.0           │');
  console.log('├──────────────────────────────────────────┤');
  console.log(`│  Logged in as: ${c.user.tag.padEnd(24)}  │`);
  console.log(`│  Guilds:       ${String(c.guilds.cache.size).padEnd(24)}│`);
  console.log(`│  Video check:  every 30s (RSS)    │`);
  console.log(`│  Live check:   every 10min (Data API v3) │`);
  console.log('└──────────────────────────────────────────┘');
  console.log('');

  // Video check every 30s, live stream check every 10 minutes
  startChecker(client, 30_000, 600_000);
});

// ─── Login ───────────────────────────────────────────────────────────

if (config.dashboard.enabled) {
  startDashboard(client);
}

client.login(config.token).catch((err) => {
  console.error('❌ Failed to login. Is your bot token correct?');
  console.error(err.message);
  process.exit(1);
});

// ─── Graceful Shutdown ───────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('[Bot] Received SIGINT — shutting down gracefully.');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Bot] Received SIGTERM — shutting down gracefully.');
  client.destroy();
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Bot] Unhandled promise rejection at:', promise, 'reason:', reason);
  // Do NOT exit — keep the bot alive on non-fatal async errors
});

process.on('uncaughtException', (err) => {
  console.error('[Bot] Uncaught exception:', err);
  // Do NOT exit on non-fatal errors; log and continue
});
