export function parseKvikEmoji(rawValue) {
  if (!rawValue) return null;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/<?a?:?([^:>]+):([0-9]+)>?/);
  if (match) {
    return `${match[1]}:${match[2]}`;
  }
  return trimmed;
}

export function ensureKvikData(data) {
  if (!data.kvik) data.kvik = {};
  if (!data.kvik.messages) data.kvik.messages = {};
}

export function trackKvikReaction({
  data,
  messageEntry,
  emojiKey,
  kvikEmojiKey,
  reactionCount,
}) {
  if (!kvikEmojiKey || emojiKey !== kvikEmojiKey) return false;
  ensureKvikData(data);

  if (typeof reactionCount === "number" && reactionCount <= 0) {
    delete data.kvik.messages[messageEntry.messageId];
    return true;
  }

  data.kvik.messages[messageEntry.messageId] = {
    messageId: messageEntry.messageId,
    channelId: messageEntry.channelId,
    authorId: messageEntry.authorId,
    createdTimestamp: messageEntry.createdTimestamp,
    jumpUrl: messageEntry.jumpUrl,
    content: messageEntry.content,
  };

  return true;
}

export async function postKvikDigest({
  client,
  summaryChannelId,
  data,
  allowedMentions,
  title,
}) {
  ensureKvikData(data);
  const summaryChannel = await client.channels.fetch(summaryChannelId);
  if (!summaryChannel || !summaryChannel.isTextBased()) {
    console.error("Summary channel is not text-based or is missing.");
    return;
  }

  const entries = Object.values(data.kvik.messages || {}).sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp,
  );

  if (entries.length === 0) {
    return;
  }

  await summaryChannel.send({
    content: `**${title}**`,
    allowedMentions,
  });

  const lines = entries.map((entry, index) => {
    const content = entry.content || "No message content available.";
    const author = entry.authorId ? `<@${entry.authorId}>` : "Unknown author";
    return `#${index + 1} • ${author}\n${content}\n${entry.jumpUrl}`;
  });

  await sendChunkedLines(summaryChannel, allowedMentions, lines);

  data.kvik.messages = {};
}

async function sendChunkedLines(channel, allowedMentions, lines) {
  const chunks = chunkLines(lines, 1800);
  for (const chunk of chunks) {
    await channel.send({
      content: chunk,
      allowedMentions,
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
