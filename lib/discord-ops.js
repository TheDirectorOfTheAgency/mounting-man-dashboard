import axios from 'axios';

export const DISCORD_OPS_CHANNEL_ID = '1472767806452924520';

function bareBotToken(value) {
  return String(value || '').trim().replace(/^Bot\s+/i, '');
}

/**
 * Square payment logs prefer DISCORD_Q_BOT_TOKEN, then DISCORD_BOT_TOKEN.
 * Discord's channel API expects `Authorization: Bot <token>` with the raw
 * bot token (no webhook URL, no extra "Bot " prefix stored in the env var).
 */
export function resolveDiscordBotAuth(env = process.env) {
  const qToken = bareBotToken(env.DISCORD_Q_BOT_TOKEN);
  if (qToken) return { envName: 'DISCORD_Q_BOT_TOKEN', token: qToken };
  const botToken = bareBotToken(env.DISCORD_BOT_TOKEN);
  if (botToken) return { envName: 'DISCORD_BOT_TOKEN', token: botToken };
  return { envName: null, token: '' };
}

export function discordAuthorizationHeader(token) {
  return `Bot ${bareBotToken(token)}`;
}

export async function postDiscordOperationsMessage(message, {
  env = process.env,
  httpClient = axios,
  channelId = DISCORD_OPS_CHANNEL_ID,
} = {}) {
  const auth = resolveDiscordBotAuth(env);
  if (!auth.token) return { ok: false, skipped: true, envName: null, error: null };
  try {
    await httpClient.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      { content: String(message).slice(0, 1900) },
      {
        headers: {
          Authorization: discordAuthorizationHeader(auth.token),
          'Content-Type': 'application/json',
        },
      },
    );
    return { ok: true, skipped: false, envName: auth.envName, error: null };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      envName: auth.envName,
      status: error.response?.status || null,
      error: error.response?.data || error.message,
    };
  }
}
