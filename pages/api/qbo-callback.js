/**
 * Temporary QBO OAuth callback — captures code + realmId for manual token exchange.
 * Remove after production tokens are obtained.
 */
export default function handler(req, res) {
  const { code, realmId, state, error } = req.query;

  if (error) {
    return res.status(400).send(`
      <html><body style="font-family:monospace;padding:2em;">
        <h2 style="color:red">OAuth Error</h2>
        <pre>${JSON.stringify(req.query, null, 2)}</pre>
      </body></html>
    `);
  }

  if (!code) {
    return res.status(400).send(`
      <html><body style="font-family:monospace;padding:2em;">
        <h2 style="color:red">No code received</h2>
        <pre>${JSON.stringify(req.query, null, 2)}</pre>
      </body></html>
    `);
  }

  res.status(200).send(`
    <html><body style="font-family:monospace;padding:2em;background:#0a0a0a;color:#00ff88;">
      <h2>✅ QBO Authorization Code Received</h2>
      <p>Copy these values — give them to Claude Code to exchange for tokens.</p>
      <hr style="border-color:#333;"/>
      <p><strong>CODE:</strong><br/>
        <span style="color:#fff;word-break:break-all;">${code}</span></p>
      <p><strong>REALM ID:</strong><br/>
        <span style="color:#fff;">${realmId || 'N/A'}</span></p>
      <p><strong>STATE:</strong><br/>
        <span style="color:#888;">${state || 'N/A'}</span></p>
      <hr style="border-color:#333;"/>
      <p style="color:#888;font-size:0.85em;">This page is a temporary OAuth callback. The code expires in ~10 minutes.</p>
    </body></html>
  `);
}
