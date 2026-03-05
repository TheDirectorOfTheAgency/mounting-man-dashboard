// pages/api/vault/write.js
//
// Vault Write Bridge — The Agency
//
// Accepts a note from any source (Grok, ChatGPT, Gemini, Apple Shortcut, iOS Share Sheet)
// and commits it as a Markdown file to the GitHub vault repo.
//
// Flow: Source app (share sheet) → POST /api/vault/write
//        → builds Brainstorms/YYYY-MM-DD-[slug].md
//        → commits to GitHub via REST API
//        → returns GitHub URL
//
// Auth: ?secret=VAULT_WRITE_SECRET (or body.secret)
// Method: POST
//
// Body (JSON):
//   content  — the text to save (required)
//   title    — note title / filename slug (optional, defaults to "note")
//   source   — where it came from: "grok", "chatgpt", "gemini", "siri", etc.
//   tags     — comma-separated tags (optional)

const GITHUB_TOKEN = process.env.VAULT_GITHUB_TOKEN;
const GITHUB_REPO  = 'TheDirectorOfTheAgency/the-agency-vault';
const WRITE_SECRET = (process.env.VAULT_WRITE_SECRET || 'vault_write_2026').split('\n')[0].trim();

// ── Helpers ───────────────────────────────────────────────────────────────────

function toSlug(str) {
  return (str || 'note')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50);
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function nowLabel() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) + ' CT';
}

async function getFileSHA(path) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const res  = await fetch(url, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.sha || null;
}

async function commitToGitHub(path, content, commitMessage) {
  const url     = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const sha     = await getFileSHA(path);
  const encoded = Buffer.from(content).toString('base64');

  const payload = {
    message: commitMessage,
    content: encoded,
    branch:  'main',
    committer: { name: 'The Agency', email: 'mntvmounting@gmail.com' },
  };
  if (sha) payload.sha = sha;

  const res = await fetch(url, {
    method:  'PUT',
    headers: {
      Authorization:  `token ${GITHUB_TOKEN}`,
      Accept:         'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`GitHub API error ${res.status}: ${JSON.stringify(err)}`);
  }
  return await res.json();
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Auth check
  const secretFromQuery = req.query.secret;
  const secretFromBody  = req.body?.secret;
  const provided = (secretFromQuery || secretFromBody || '').trim();

  if (provided !== WRITE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed — use POST' });
  }

  const { content, title, source = 'unknown', tags = '' } = req.body || {};

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'content is required' });
  }

  const date      = todayISO();
  const slug      = toSlug(title || 'brainstorm');
  const filename  = `${date}-${slug}`;
  const path      = `Brainstorms/${filename}.md`;
  const sourceTag = source.toLowerCase().trim();

  // Build the markdown
  const tagLine = tags ? `\ntags: [${tags}]` : '';
  const markdown = `---
title: "${title || 'Brainstorm'}"
source: ${sourceTag}
date: ${date}${tagLine}
---

# ${title || 'Brainstorm'}
*Captured from ${sourceTag} — ${nowLabel()}*

${content.trim()}
`;

  try {
    const result = await commitToGitHub(
      path,
      markdown,
      `brainstorm: ${title || slug} (via ${sourceTag})`
    );

    const githubUrl = `https://github.com/${GITHUB_REPO}/blob/main/${path}`;

    return res.status(200).json({
      ok:      true,
      path,
      url:     githubUrl,
      message: `Saved to vault: ${path}`,
    });
  } catch (err) {
    console.error('[vault/write] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
