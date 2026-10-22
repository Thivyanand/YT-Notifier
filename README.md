# YT-Notifier — Discord YouTube dashboard

YT-Notifier runs the Discord bot and its web dashboard in one Node.js process. Sign in with Discord, choose a server where you are an administrator, and manage its YouTube feeds from the browser or with the existing `/yt` commands.

## Requirements

- Node.js 18 or newer
- A Discord application with a bot
- A public URL with HTTPS when deployed
- Persistent disk storage for `data/bot.db`

## Configure the Discord application

1. In the Discord Developer Portal, copy the application ID and bot token.
2. Under **OAuth2 → General**, copy the client secret.
3. Add this exact redirect URL under **OAuth2 → Redirects**:

   `https://YOUR-DASHBOARD-HOST/auth/discord/callback`

   For local development, add `http://localhost:3000/auth/discord/callback`.
4. Invite the bot to your server with the `bot` and `applications.commands` scopes. The dashboard's **Add bot** link requests View Channel, Send Messages, and Embed Links permissions.

## Run it

1. Copy `.env.example` to `.env` and set `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and a private random `SESSION_SECRET`.
2. Set `DASHBOARD_BASE_URL` to the same URL used in the OAuth redirect list. Keep the local value for local development.
3. Install the existing dependencies and register the slash command:

   ```sh
   npm install
   npm run deploy
   ```

4. Start the bot and dashboard together:

   ```sh
   npm start
   ```

Open the dashboard at `http://localhost:3000`. The web server starts with the bot; the bot needs its token and the dashboard needs the OAuth client secret and session secret.

If the browser shows an old page or stays on the loading screen, open the served URL directly (`http://localhost:3000`) instead of opening `dashboard/public/index.html` as a file, then refresh once. Only one `npm start` process should run at a time; a second process will report that the port is already in use.

The original bot settings file is not included because it can contain your bot token. If you want to reuse its non-environment settings (such as a YouTube API key or WebSub callback), copy your private `config.json` from the archive into this project root. It is ignored by Git, and environment variables override matching values.

## Deploy on a host

Set the variables from `.env.example` in the host's environment settings. Set `NODE_ENV=production`, use the public HTTPS URL for `DASHBOARD_BASE_URL`, and add its matching callback URL in the Discord Developer Portal. Let the host provide `PORT` when it requires one. Run `npm install`, run `npm run deploy` once, then use `npm start` as the service start command.

The bot database is stored in `data/bot.db`. Attach persistent storage at the project directory or back up that database; an ephemeral filesystem will lose subscription settings when the host replaces the instance. Do not upload `.env`, `config.json`, or your bot token to a public repository.

## Optional settings

- `YOUTUBE_API_KEY` enables the bot's Data API fallback and live stream checks. RSS upload checks continue without it.
- `WEBSUB_ENABLED=true` enables YouTube push notifications in addition to polling. Set `WEBSUB_CALLBACK_BASE_URL` to a public HTTPS URL and keep `WEBSUB_PORT` separate from the dashboard port.
- Set `DASHBOARD_ENABLED=false` only if you intentionally want to run the bot without its dashboard.

The OAuth flow asks for your Discord identity and server list. The dashboard only shows servers where you are the owner or an administrator, and it checks that access again before changing a feed. Dashboard sessions are held in memory and expire after seven days; restarting the service signs users out.
