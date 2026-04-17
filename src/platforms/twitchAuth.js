const axios = require('axios');
const logger = require('../utils/logger');

let appAccessToken = null;
let tokenExpiresAt = 0;

async function getAppAccessToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (appAccessToken && Date.now() < tokenExpiresAt - 300000) {
    return appAccessToken;
  }

  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials'
      }
    });

    appAccessToken = response.data.access_token;
    tokenExpiresAt = Date.now() + (response.data.expires_in * 1000);
    logger.info('Twitch app access token obtained');
    return appAccessToken;
  } catch (error) {
    logger.error('Failed to get Twitch app access token:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Make an authenticated request to the Twitch API
 */
async function twitchApiRequest(method, url, data = null) {
  const token = await getAppAccessToken();
  const config = {
    method,
    url: `https://api.twitch.tv/helix${url}`,
    headers: {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`
    }
  };
  if (data) config.data = data;
  return axios(config);
}

module.exports = { getAppAccessToken, twitchApiRequest };
