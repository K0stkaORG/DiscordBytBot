# Reaction Leaderboard Bot

This Discord bot monitors reactions in a specific channel, classifies them as positive or negative, and posts a weekly leaderboard with the top-scoring posts.

## Features

- Track reactions in a single target channel
- Configure positive and negative reaction sets
- Weekly leaderboard embed with score breakdown and jump links
- Persistent storage in `data/leaderboard.json`
- Self-hostable with Docker

## Requirements

- A Discord application with a bot user
- Enabled **Message Content Intent** (so the bot can summarize post content)
- Bot permissions in the target channel:
  - View Channel
  - Read Message History
  - Read Messages
  - Add Reactions (optional)
  - Send Messages
  - Embed Links

## Configuration

Copy `.env.example` to `.env` and fill in values:

- `DISCORD_TOKEN` (required)
- `TARGET_CHANNEL_ID` (required)
- `LEADERBOARD_CHANNEL_ID` (optional, defaults to `TARGET_CHANNEL_ID`)
- `POSITIVE_REACTIONS` (comma-separated)
- `NEGATIVE_REACTIONS` (comma-separated)
- `LEADERBOARD_CRON` (optional, default `0 9 * * 1`)
- `LEADERBOARD_LIMIT` (optional, default `10`)

Reaction values accept unicode or custom emojis. Custom emojis can be provided as either `name:id` or the full `<:name:id>` format.

## Local development (Bun)

```BytBot/README.md#L33-41
bun install
cp .env.example .env
# edit .env with your values
bun run start
```

## Docker

```BytBot/README.md#L45-50
cp .env.example .env
# edit .env with your values
docker compose up -d --build
```

Data is persisted to `./data` via the Docker volume defined in `docker-compose.yml`.

## Notes

- The bot only tracks reactions while it is running. If you want to backfill historical data, let me know and I can add a one-time sync.
- Leaderboard scheduling uses the container/server time zone.
