const tokenFromUrl = new URLSearchParams(window.location.search).get('token');
if (tokenFromUrl) sessionStorage.setItem('codeatlas-token', tokenFromUrl);
const token = tokenFromUrl ?? sessionStorage.getItem('codeatlas-token');

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!token) throw new Error('This CodeAtlas session has no access token. Re-open it from the CLI URL.');
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-codeatlas-token': token,
      ...init?.headers,
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`);
  return body;
}
