import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import cron from "node-cron";
import { Client, GatewayIntentBits, Partials, EmbedBuilder } from "discord.js";
import {
  parseKvikEmoji,
  ensureKvikData,
  trackKvikReaction,
  postKvikDigest,
} from "./kvik.js";

const REQUIRED_ENV_VARS = [
  "DISCORD_TOKEN",
  "TARGET_CHANNEL_IDS",
  "SUMMARY_CHANNEL_ID",
];
const missingVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingVars.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingVars.join(", ")}`,
  );
}

const TARGET_CHANNEL_IDS = parseIdList(process.env.TARGET_CHANNEL_IDS);
const SUMMARY_CHANNEL_ID = process.env.SUMMARY_CHANNEL_ID;
if (TARGET_CHANNEL_IDS.size === 0) {
  throw new Error("TARGET_CHANNEL_IDS must include at least one channel ID.");
}
const LEADERBOARD_CRON = process.env.LEADERBOARD_CRON || "0 9 * * 1";
const LEADERBOARD_LIMIT = Number(process.env.LEADERBOARD_LIMIT || 10);
const WORST_POST_LIMIT = Number(process.env.WORST_POST_LIMIT || 3);
const SUMMARY_TITLE = process.env.SUMMARY_TITLE || "🏆 Weekly Reaction Summary";
const THREAD_TITLE =
  process.env.THREAD_TITLE || "🎮 Weekly Leaderboard Details";
const THREAD_AUTO_ARCHIVE_MINUTES = parseArchiveDuration(
  process.env.THREAD_AUTO_ARCHIVE_MINUTES,
  10080,
);
const DATA_PATH = path.join("data", "leaderboard.json");
const ALLOWED_MENTIONS = { parse: [] };

const KVIK_REACTION = parseKvikEmoji(process.env.KVIK_REACTION || "");
const KVIK_CRON = process.env.KVIK_CRON || null;
const KVIK_TITLE =
  process.env.KVIK_TITLE || "<:Kuzel:1289601483398189056> Kvík of the week";

const NEGATIVE_REACTIONS = parseEmojiList(process.env.NEGATIVE_REACTIONS || "");
const IGNORED_REACTIONS = parseEmojiList(process.env.IGNORED_REACTIONS || "");

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
ensureKvikData(data);
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

  if (KVIK_REACTION && KVIK_CRON) {
    cron.schedule(KVIK_CRON, async () => {
      try {
        await postKvikDigest({
          client,
          summaryChannelId: SUMMARY_CHANNEL_ID,
          data,
          allowedMentions: ALLOWED_MENTIONS,
          title: KVIK_TITLE,
        });
        await persistData();
      } catch (error) {
        console.error("Failed to post Kvík of the week:", error);
      }
    });
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  await handleReactionChange(reaction, user, 1);
});

client.on("messageReactionRemove", async (reaction, user) => {
  if (user.bot) return;
  await handleReactionChange(reaction, user, -1);
});

async function handleReactionChange(reaction, user, direction) {
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

  if (!reaction.message || !TARGET_CHANNEL_IDS.has(reaction.message.channelId))
    return;

  const emojiKey = normalizeEmoji(reaction.emoji);
  const messageEntry = ensureMessageEntry(reaction.message);

  if (KVIK_REACTION) {
    const updated = trackKvikReaction({
      data,
      messageEntry,
      emojiKey,
      kvikEmojiKey: KVIK_REACTION,
      reactionCount: reaction.count,
    });
    if (updated) {
      await persistData();
    }
  }

  if (IGNORED_REACTIONS.has(emojiKey)) return;
  if (messageEntry.authorId && user.id === messageEntry.authorId) return;

  const isNegative = NEGATIVE_REACTIONS.has(emojiKey);
  const userState = getUserReactionState(messageEntry, user.id);
  const previousScore = scoreFromState(userState);

  updateUserState(userState, emojiKey, isNegative, direction);

  const nextScore = scoreFromState(userState);
  messageEntry.score += nextScore - previousScore;

  if (!hasAnyReactions(userState)) {
    delete messageEntry.userReactions[user.id];
  } else {
    saveUserReactionState(messageEntry, user.id, userState);
  }

  messageEntry.reactions[emojiKey] =
    (messageEntry.reactions[emojiKey] || 0) + direction;
  if (messageEntry.reactions[emojiKey] < 0) {
    messageEntry.reactions[emojiKey] = 0;
  }

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
      imageUrl: extractImageUrl(message),
      score: 0,
      reactions: {},
      userReactions: {},
    };
  }

  const entry = data.messages[message.id];
  if (!entry.reactions) entry.reactions = {};
  if (!entry.userReactions) entry.userReactions = {};
  if (typeof entry.score !== "number") entry.score = 0;
  if (!entry.imageUrl) {
    const imageUrl = extractImageUrl(message);
    if (imageUrl) entry.imageUrl = imageUrl;
  }

  return entry;
}

async function postWeeklyLeaderboard() {
  const summaryChannel = await client.channels.fetch(SUMMARY_CHANNEL_ID);
  if (!summaryChannel || !summaryChannel.isTextBased()) {
    console.error("Summary channel is not text-based or is missing.");
    return;
  }

  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weeklyEntries = Object.values(data.messages).filter(
    (entry) => entry.createdTimestamp >= oneWeekAgo,
  );

  if (weeklyEntries.length === 0) {
    await summaryChannel.send({
      content: "No scored posts in the last week.",
      allowedMentions: ALLOWED_MENTIONS,
    });
    return;
  }

  const authorScores = aggregateAuthorScores(weeklyEntries);
  const topPosts = weeklyEntries
    .slice()
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.createdTimestamp - b.createdTimestamp;
    })
    .slice(0, LEADERBOARD_LIMIT);

  const worstPosts = weeklyEntries
    .slice()
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.createdTimestamp - b.createdTimestamp;
    })
    .slice(0, WORST_POST_LIMIT);

  const bestAuthor = authorScores[0] || null;
  const worstAuthor = authorScores[authorScores.length - 1] || null;
  const bestPost = topPosts[0] || null;
  const worstPost = worstPosts[0] || null;

  const summaryEmbed = new EmbedBuilder()
    .setTitle(SUMMARY_TITLE)
    .setColor(0x00c2ff)
    .setTimestamp(new Date())
    .setFooter({ text: "GGs only — full stats in thread" });

  summaryEmbed.addFields({
    name: "🥇 Best Author",
    value: bestAuthor
      ? `<@${bestAuthor.authorId}> — ${bestAuthor.score}`
      : "No data",
    inline: true,
  });

  summaryEmbed.addFields({
    name: "💀 Worst Author",
    value: worstAuthor
      ? `<@${worstAuthor.authorId}> — ${worstAuthor.score}`
      : "No data",
    inline: true,
  });

  summaryEmbed.addFields({
    name: "🌟 Best Post",
    value: bestPost
      ? `${bestPost.content || "No message content available."}
${summarizeReactions(bestPost.reactions)}
[Jump to message](${bestPost.jumpUrl})`
      : "No data",
  });

  summaryEmbed.addFields({
    name: "💥 Worst Post",
    value: worstPost
      ? `${worstPost.content || "No message content available."}
${summarizeReactions(worstPost.reactions)}
[Jump to message](${worstPost.jumpUrl})`
      : "No data",
  });

  const summaryMessage = await summaryChannel.send({
    embeds: [summaryEmbed],
    allowedMentions: ALLOWED_MENTIONS,
  });

  if (!summaryMessage || !summaryMessage.startThread) {
    console.error("Failed to create thread for leaderboard details.");
    return;
  }

  const thread = await summaryMessage.startThread({
    name: THREAD_TITLE,
    autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES,
  });

  await sendAuthorLeaderboard(thread, authorScores);
  await sendPostLeaderboard(
    thread,
    `🔥 Top ${LEADERBOARD_LIMIT} Posts`,
    topPosts,
  );
  await sendPostLeaderboard(
    thread,
    `💀 Worst ${WORST_POST_LIMIT} Posts`,
    worstPosts,
  );
}

function summarizeReactions(reactions) {
  const totalCount = sumExcludingSet(reactions, IGNORED_REACTIONS);
  const negativeCount = sumBySetExcluding(
    reactions,
    NEGATIVE_REACTIONS,
    IGNORED_REACTIONS,
  );
  const positiveCount = Math.max(0, totalCount - negativeCount);
  const finalScore = positiveCount - negativeCount;
  return `<:up:1503802122162929694> ${positiveCount} / <:down:1503802156556488914> ${negativeCount} / <:equals:1503802180736385116> ${finalScore}`;
}

function aggregateAuthorScores(entries) {
  const totals = new Map();

  entries.forEach((entry) => {
    if (!entry.authorId) return;
    totals.set(entry.authorId, (totals.get(entry.authorId) || 0) + entry.score);
  });

  return Array.from(totals.entries())
    .map(([authorId, score]) => ({ authorId, score }))
    .sort((a, b) => b.score - a.score);
}

async function sendAuthorLeaderboard(channel, authorScores) {
  if (authorScores.length === 0) {
    await channel.send({
      content: "No author scores available.",
      allowedMentions: ALLOWED_MENTIONS,
    });
    return;
  }

  const lines = authorScores.map(
    (entry, index) => `#${index + 1} • <@${entry.authorId}> — ${entry.score}`,
  );
  await sendChunkedEmbeds(channel, "🏅 Personal Leaderboard", lines, 0xf1c40f);
}

async function sendPostLeaderboard(channel, title, entries) {
  if (entries.length === 0) {
    await channel.send({
      content: `${title}: no posts available.`,
      allowedMentions: ALLOWED_MENTIONS,
    });
    return;
  }

  const rankedEntries = entries.map((entry, index) => ({
    entry,
    rank: index + 1,
  }));

  const embedColor = title.startsWith("🔥")
    ? 0x2ecc71
    : title.startsWith("💀")
      ? 0xe74c3c
      : 0x5865f2;

  await sendPostEmbeds(channel, title, rankedEntries, embedColor);
}

async function sendChunkedEmbeds(channel, title, lines, color) {
  const chunks = chunkLines(lines, 3800);
  const embeds = chunks.map((chunk, index) => {
    const embed = new EmbedBuilder().setDescription(chunk).setColor(color);
    if (index === 0) embed.setTitle(title);
    return embed;
  });

  for (const embed of embeds) {
    await channel.send({
      embeds: [embed],
      allowedMentions: ALLOWED_MENTIONS,
    });
  }
}

async function sendPostEmbeds(channel, title, entries, color) {
  for (let i = 0; i < entries.length; i += 1) {
    const { entry, rank } = entries[i];
    const breakdown = summarizeReactions(entry.reactions);
    const content = entry.content || "No message content available.";

    const embed = new EmbedBuilder()
      .setColor(color)
      .setDescription(`${content}\n${breakdown}\n${entry.jumpUrl}`)
      .setAuthor({ name: `#${rank} • Score ${entry.score}` });

    if (i === 0) {
      embed.setTitle(title);
    }

    if (entry.imageUrl) {
      embed.setImage(entry.imageUrl);
    }

    await channel.send({
      embeds: [embed],
      allowedMentions: ALLOWED_MENTIONS,
    });
  }
}

function chunkLines(lines, maxLength) {
  const chunks = [];
  let current = "";

  lines.forEach((line) => {
    const lineWithNewline = current.length === 0 ? line : `\n${line}`;
    if (current.length + lineWithNewline.length > maxLength) {
      if (current.length > 0) chunks.push(current);
      current = line;
    } else {
      current += lineWithNewline;
    }
  });

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function sumBySet(reactions, set) {
  return Object.entries(reactions)
    .filter(([emoji]) => set.has(emoji))
    .reduce((total, [, count]) => total + count, 0);
}

function sumBySetExcluding(reactions, set, excludedSet) {
  return Object.entries(reactions)
    .filter(([emoji]) => set.has(emoji) && !excludedSet.has(emoji))
    .reduce((total, [, count]) => total + count, 0);
}

function sumAllReactions(reactions) {
  return Object.values(reactions).reduce((total, count) => total + count, 0);
}

function sumExcludingSet(reactions, excludedSet) {
  return Object.entries(reactions)
    .filter(([emoji]) => !excludedSet.has(emoji))
    .reduce((total, [, count]) => total + count, 0);
}

function getUserReactionState(messageEntry, userId) {
  const stored = messageEntry.userReactions[userId];
  return {
    positive: new Set(stored?.positive || []),
    negative: new Set(stored?.negative || []),
  };
}

function saveUserReactionState(messageEntry, userId, state) {
  messageEntry.userReactions[userId] = {
    positive: Array.from(state.positive),
    negative: Array.from(state.negative),
  };
}

function updateUserState(state, emojiKey, isNegative, direction) {
  const targetSet = isNegative ? state.negative : state.positive;
  if (direction > 0) {
    targetSet.add(emojiKey);
  } else {
    targetSet.delete(emojiKey);
  }
}

function scoreFromState(state) {
  const hasPositive = state.positive.size > 0;
  const hasNegative = state.negative.size > 0;
  if (hasPositive && hasNegative) return 0;
  if (hasPositive) return 1;
  if (hasNegative) return -1;
  return 0;
}

function hasAnyReactions(state) {
  return state.positive.size > 0 || state.negative.size > 0;
}

function parseArchiveDuration(rawValue, fallback) {
  const allowed = new Set([60, 1440, 4320, 10080]);
  const parsed = Number(rawValue);
  if (allowed.has(parsed)) return parsed;
  return fallback;
}

function parseIdList(rawList) {
  return new Set(
    (rawList || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
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

function extractImageUrl(message) {
  if (!message?.attachments || message.attachments.size === 0) return null;
  for (const attachment of message.attachments.values()) {
    if (isImageAttachment(attachment)) {
      return attachment.url || null;
    }
  }
  return null;
}

function isImageAttachment(attachment) {
  if (!attachment) return false;
  if (attachment.contentType?.startsWith("image/")) return true;
  const name = attachment.name || "";
  return /\.(png|jpe?g|gif|webp|bmp|tiff)$/i.test(name);
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
