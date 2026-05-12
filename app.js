import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import cron from "node-cron";
import { Client, GatewayIntentBits, Partials, EmbedBuilder } from "discord.js";

const REQUIRED_ENV_VARS = ["DISCORD_TOKEN", "TARGET_CHANNEL_ID"];
const missingVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingVars.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingVars.join(", ")}`,
  );
}

const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const LEADERBOARD_CHANNEL_ID =
  process.env.LEADERBOARD_CHANNEL_ID || TARGET_CHANNEL_ID;
const LEADERBOARD_CRON = process.env.LEADERBOARD_CRON || "0 9 * * 1";
const LEADERBOARD_LIMIT = Number(process.env.LEADERBOARD_LIMIT || 10);
const DATA_PATH = path.join("data", "leaderboard.json");

const POSITIVE_REACTIONS = parseEmojiList(process.env.POSITIVE_REACTIONS || "");
const NEGATIVE_REACTIONS = parseEmojiList(process.env.NEGATIVE_REACTIONS || "");

if (POSITIVE_REACTIONS.size === 0 && NEGATIVE_REACTIONS.size === 0) {
  throw new Error(
    "Set POSITIVE_REACTIONS and/or NEGATIVE_REACTIONS to enable scoring.",
  );
}

const USE_MESSAGE_CONTENT_INTENT =
  String(process.env.MESSAGE_CONTENT_INTENT || "").toLowerCase() === "true";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    USE_MESSAGE_CONTENT_INTENT ? GatewayIntentBits.MessageContent : null,
  ].filter(Boolean),
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

let data = await loadData();
let saveInFlight = null;

client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  cron.schedule(LEADERBOARD_CRON, async () => {
    try {
      await postWeeklyLeaderboard();
    } catch (error) {
      console.error("Failed to post leaderboard:", error);
    }
  });
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  await handleReactionChange(reaction, 1);
});

client.on("messageReactionRemove", async (reaction, user) => {
  if (user.bot) return;
  await handleReactionChange(reaction, -1);
});

async function handleReactionChange(reaction, direction) {
  try {
    if (reaction.partial) {
      await reaction.fetch();
    }
    if (reaction.message.partial) {
      await reaction.message.fetch();
    }
  } catch (error) {
    console.error("Failed to fetch partial reaction/message:", error);
    return;
  }

  if (!reaction.message || reaction.message.channelId !== TARGET_CHANNEL_ID)
    return;

  const emojiKey = normalizeEmoji(reaction.emoji);
  const scoreDelta = getScoreDelta(emojiKey) * direction;
  if (scoreDelta === 0) return;

  const messageEntry = ensureMessageEntry(reaction.message);
  messageEntry.reactions[emojiKey] =
    (messageEntry.reactions[emojiKey] || 0) + direction;
  if (messageEntry.reactions[emojiKey] < 0) {
    messageEntry.reactions[emojiKey] = 0;
  }
  messageEntry.score += scoreDelta;

  await persistData();
}

function ensureMessageEntry(message) {
  if (!data.messages[message.id]) {
    data.messages[message.id] = {
      messageId: message.id,
      channelId: message.channelId,
      authorId: message.author?.id || null,
      createdTimestamp: message.createdTimestamp,
      jumpUrl: message.url,
      content: summarizeContent(message.content),
      score: 0,
      reactions: {},
    };
  }

  return data.messages[message.id];
}

async function postWeeklyLeaderboard() {
  const leaderboardChannel = await client.channels.fetch(
    LEADERBOARD_CHANNEL_ID,
  );
  if (!leaderboardChannel || !leaderboardChannel.isTextBased()) {
    console.error("Leaderboard channel is not text-based or is missing.");
    return;
  }

  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const entries = Object.values(data.messages)
    .filter((entry) => entry.createdTimestamp >= oneWeekAgo)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.createdTimestamp - b.createdTimestamp;
    })
    .slice(0, LEADERBOARD_LIMIT);

  if (entries.length === 0) {
    await leaderboardChannel.send("No scored posts in the last week.");
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Weekly Reaction Leaderboard")
    .setDescription(
      `Top posts from the last 7 days in <#${TARGET_CHANNEL_ID}>.`,
    )
    .setColor(0x5865f2)
    .setTimestamp(new Date());

  entries.forEach((entry, index) => {
    const breakdown = summarizeReactions(entry.reactions);
    const content = entry.content || "No message content available.";
    embed.addFields({
      name: `#${index + 1} • Score ${entry.score}`,
      value: `${content}\n${breakdown}\n[Jump to message](${entry.jumpUrl})`,
    });
  });

  await leaderboardChannel.send({ embeds: [embed] });
}

function summarizeReactions(reactions) {
  const positiveCount = sumBySet(reactions, POSITIVE_REACTIONS);
  const negativeCount = sumBySet(reactions, NEGATIVE_REACTIONS);
  return `Reactions: +${positiveCount} / -${negativeCount}`;
}

function sumBySet(reactions, set) {
  return Object.entries(reactions)
    .filter(([emoji]) => set.has(emoji))
    .reduce((total, [, count]) => total + count, 0);
}

function getScoreDelta(emojiKey) {
  if (POSITIVE_REACTIONS.has(emojiKey)) return 1;
  if (NEGATIVE_REACTIONS.has(emojiKey)) return -1;
  return 0;
}

function parseEmojiList(rawList) {
  const set = new Set();
  if (!rawList) return set;

  rawList
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => {
      const match = value.match(/<?a?:?([^:>]+):([0-9]+)>?/);
      if (match) {
        set.add(`${match[1]}:${match[2]}`);
      } else {
        set.add(value);
      }
    });

  return set;
}

function normalizeEmoji(emoji) {
  if (emoji.id) {
    return `${emoji.name}:${emoji.id}`;
  }
  return emoji.name;
}

function summarizeContent(content) {
  if (!content) return "";
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= 140) return clean;
  return `${clean.slice(0, 137)}...`;
}

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.messages) parsed.messages = {};
    return parsed;
  } catch (error) {
    return { version: 1, messages: {} };
  }
}

async function persistData() {
  if (saveInFlight) return saveInFlight;
  saveInFlight = (async () => {
    await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
    await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
    saveInFlight = null;
  })();

  return saveInFlight;
}

client.login(process.env.DISCORD_TOKEN);
