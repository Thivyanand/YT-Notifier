const { REST, Routes } = require('discord.js');
const config = require('./config');
const ytCommand = require('./commands/yt');

// ─── Deploy Slash Commands ───────────────────────────────────────────

const commands = [ytCommand.data.toJSON()];
const rest = new REST().setToken(config.token);

(async () => {
  try {
    console.log(`🔄 Registering ${commands.length} slash command(s)...`);

    if (config.guildId) {
      // Guild-specific — instant availability
      await rest.put(
        Routes.applicationGuildCommands(config.clientId, config.guildId),
        { body: commands }
      );
      console.log(`✅ Registered ${commands.length} guild command(s) for guild ${config.guildId}`);
    } else {
      // Global — may take up to 1 hour to propagate
      await rest.put(
        Routes.applicationCommands(config.clientId),
        { body: commands }
      );
      console.log(`✅ Registered ${commands.length} global command(s) (may take ~1 hour to propagate)`);
    }
  } catch (error) {
    console.error('❌ Error registering commands:', error);
    process.exit(1);
  }
})();
