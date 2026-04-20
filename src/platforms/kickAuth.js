const axios = require('axios');
const logger = require('../utils/logger');

const TOKEN_URL = 'https://id.kick.com/oauth/token';
const SCOPES = 'events:subscribe user:read channel:read';

let cachedToken = null;
let cachedExpiresAt = 0;

function isConfigured() {
  return Boolean(process.env.KICK_CLIENT_ID && process.env.KICK_CLIENT_SECRET);
}

/**
 * Get a valid app access token using the Client Credentials flow.
 * Caches the token in memory until 60s before expiry.
 */
async function getAppToken() {
  if (!isConfigured()) {
    throw new Error('KICK_CLIENT_ID and/or KICK_CLIENT_SECRET are not set');
  }

  const now = Date.now();
  if (cachedToken && now < cachedExpiresAt - 60 * 1000) {
    return cachedToken;
  }

  const form = new URLSearchParams();
  form.append('grant_type', 'client_credentials');
  form.append('client_id', process.env.KICK_CLIENT_ID);
  form.append('client_secret', process.env.KICK_CLIENT_SECRET);
  form.append('scope', SCOPES);

  const response = await axios.post(TOKEN_URL, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000
  });

  const { access_token, expires_in } = response.data;
  cachedToken = access_token;
  cachedExpiresAt = now + (expires_in * 1000);
  logger.info(`Kick OAuth token refreshed, expires in ${expires_in}s`);
  return cachedToken;
}

module.exports = { isConfigured, getAppToken };
