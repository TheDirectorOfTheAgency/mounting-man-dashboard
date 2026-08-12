function configuredError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function postJson({ endpoint, token, path = '', body, httpClient = fetch }) {
  if (!endpoint || !token) throw configuredError('complete_publisher_unavailable');
  const response = await httpClient(`${String(endpoint).replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response?.ok) throw configuredError('complete_publisher_request_failed');
  return response.json();
}

/** Deterministic preview endpoint backed by the version-pinned canonical publisher. */
export function createCanonicalPreviewClient({ endpoint, token, httpClient } = {}) {
  return {
    async preview({ jobId, revision, seed, image }) {
      if (!endpoint || !token) throw configuredError('canonical_previewer_unavailable');
      const result = await postJson({
        endpoint,
        token,
        path: '/preview',
        httpClient,
        body: {
          jobId: String(jobId),
          revision: String(revision),
          seed,
          image: { sha256: image.sha256, hostedUrl: image.hostedUrl },
        },
      }).catch((error) => {
        if (error.code === 'complete_publisher_unavailable') {
          throw configuredError('canonical_previewer_unavailable');
        }
        if (error.code === 'complete_publisher_request_failed') {
          throw configuredError('canonical_previewer_request_failed');
        }
        throw error;
      });
      if (!result?.website || !result?.destinations) {
        throw configuredError('canonical_previewer_invalid_response');
      }
      return result;
    },
  };
}
/**
 * Complete publisher transport. It receives only opaque identities and must
 * fetch the stored manifest from the authoritative backend.
 */
export function createCompletePublisherClient({ endpoint, token, httpClient } = {}) {
  return {
    async dispatch({ jobId, revision, manifestId, dispatchId }) {
      const result = await postJson({
        endpoint,
        token,
        path: '/publish',
        httpClient,
        body: { jobId, revision, manifestId, dispatchId },
      });
      return { dispatchId: String(result?.dispatchId || dispatchId) };
    },

    async retry({ jobId, revision, manifestId, dispatchId, destinationIds }) {
      const result = await postJson({
        endpoint,
        token,
        path: '/retry',
        httpClient,
        body: { jobId, revision, manifestId, dispatchId, destinationIds },
      });
      return { dispatchId: String(result?.dispatchId || dispatchId) };
    },
  };
}
