import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discordAuthorizationHeader,
  postDiscordOperationsMessage,
  resolveDiscordBotAuth,
} from '../lib/discord-ops.js';

test('Discord auth prefers the Q bot token and does not double the Bot prefix', () => {
  const auth = resolveDiscordBotAuth({
    DISCORD_Q_BOT_TOKEN: 'Bot q-token',
    DISCORD_BOT_TOKEN: 'other-token',
  });
  assert.equal(auth.envName, 'DISCORD_Q_BOT_TOKEN');
  assert.equal(auth.token, 'q-token');
  assert.equal(discordAuthorizationHeader(auth.token), 'Bot q-token');
  assert.equal(discordAuthorizationHeader('Bot q-token'), 'Bot q-token');
});

test('Discord post uses the bot channel API and names the env var on failure', async () => {
  let request;
  const result = await postDiscordOperationsMessage('summary', {
    env: { DISCORD_BOT_TOKEN: 'opus-token' },
    httpClient: {
      async post(url, body, config) {
        request = { url, body, config };
        const error = new Error('Request failed');
        error.response = { status: 401, data: { message: '401: Unauthorized', code: 0 } };
        throw error;
      },
    },
  });
  assert.equal(request.url, 'https://discord.com/api/v10/channels/1472767806452924520/messages');
  assert.equal(request.config.headers.Authorization, 'Bot opus-token');
  assert.equal(result.ok, false);
  assert.equal(result.envName, 'DISCORD_BOT_TOKEN');
  assert.equal(result.status, 401);
  assert.equal(result.error.code, 0);
});
