#!/usr/bin/env node
// Quick script to get a Google Ads OAuth refresh token
// Usage: node scripts/get-google-refresh-token.js

const http = require('http');
const axios = require('axios');
const fs = require('fs');

const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID || '155328431466-ms2ucl67h93ne8tcp3c965kdffi170nn.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
if (!CLIENT_SECRET) {
  console.error('Set GOOGLE_ADS_CLIENT_SECRET env var (pull from Vercel: vercel env pull .env.local)');
  process.exit(1);
}
const REDIRECT_URI = 'http://localhost:9877/callback';
const SCOPE = 'https://www.googleapis.com/auth/adwords';
const TOKEN_FILE = '/tmp/google_ads_refresh_token_v5_mntvmounting.txt';

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
  login_hint: 'mntvmounting@gmail.com',
})}`;

console.log('AUTH_URL=' + authUrl);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:9877');

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h1>Error: ${error}</h1>`);
      console.error('ERROR=' + error);
      server.close();
      return;
    }

    if (code) {
      try {
        const tokenRes = await axios.post('https://oauth2.googleapis.com/token', null, {
          params: {
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code',
          },
        });

        const { refresh_token } = tokenRes.data;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>Success!</h1><p>Refresh token saved. You can close this tab.</p>`);

        // Write token to file for easy retrieval
        fs.writeFileSync(TOKEN_FILE, refresh_token);
        console.log('REFRESH_TOKEN=' + refresh_token);
        console.log('TOKEN_SAVED=' + TOKEN_FILE);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h1>Token exchange failed</h1><pre>${err.response?.data ? JSON.stringify(err.response.data, null, 2) : err.message}</pre>`);
        console.error('TOKEN_ERROR=' + JSON.stringify(err.response?.data || err.message));
      }
    }

    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 1000);
  }
});

server.listen(9877, () => {
  console.log('SERVER_READY=true');
});
