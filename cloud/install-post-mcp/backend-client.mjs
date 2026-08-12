import { createHmac, randomUUID } from 'node:crypto';

function backendError(code) {
  const safeCode = /^[a-z0-9_]{1,80}$/.test(String(code || ''))
    ? String(code)
    : 'backend_request_failed';
  const error = new Error(safeCode);
  error.code = safeCode;
  return error;
}

export function createInstallationPostBackendClient({ endpoint, token, httpClient = fetch } = {}) {
  return {
    async call(tool, args = {}, { verifiedActor } = {}) {
      if (!endpoint || !token) throw backendError('backend_unavailable');
      const issuedAt = Date.now();
      const body = JSON.stringify({
        tool,
        arguments: args,
        actor: verifiedActor?.sub ? { sub: String(verifiedActor.sub) } : null,
        requestId: randomUUID(),
      });
      const signature = createHmac('sha256', token).update(`${issuedAt}.${body}`).digest('hex');
      let response;
      try {
        response = await httpClient(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Install-Post-Issued-At': String(issuedAt),
            'X-Install-Post-Signature': signature,
          },
          body,
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        throw backendError('backend_request_failed');
      }
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        throw backendError('backend_invalid_response');
      }
      if (!response.ok) throw backendError(payload?.error);
      if (!payload || typeof payload.result !== 'object' || payload.result === null) {
        throw backendError('backend_invalid_response');
      }
      return payload.result;
    },
  };
}
