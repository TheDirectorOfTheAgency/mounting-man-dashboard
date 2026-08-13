export function upstashSetCommandUrl(baseUrl, command, key, member) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  return `${root}/${encodeURIComponent(command)}/${encodeURIComponent(key)}/${encodeURIComponent(member)}`;
}

export async function upstashSetCommand({ httpClient, baseUrl, token, command, key, member }) {
  if (!baseUrl || !token) return false;
  const response = await httpClient.get(upstashSetCommandUrl(baseUrl, command, key, member), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return Number.isInteger(response.data?.result);
}
