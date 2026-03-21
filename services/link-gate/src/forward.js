import { env } from './env.js';

export async function forwardToB(serverBUrl, payload, correlationId = '') {
  const headers = { 'content-type': 'application/json' };
  if (correlationId) {
    headers['x-correlation-id'] = correlationId;
  }

  let response;

  try {
    response = await fetch(serverBUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(env.FORWARD_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(JSON.stringify({
      server: 'D',
      ts: Date.now(),
      event: 'forward_fetch_error',
      error: 'upstream_failed',
      detail: err?.name === 'TimeoutError' ? 'timeout' : 'network_error',
      method: 'POST',
      path: '/api/resolve',
      correlationId,
      url: serverBUrl,
      errorName: String(err?.name || 'UnknownError'),
      errorMessage: String(err?.message || 'No error message provided'),
    }));
    return {
      data: null,
      error: err?.name === 'TimeoutError' ? 'timeout' : 'network_error',
    };
  }

  if (!response.ok) {
    console.error(JSON.stringify({
      server: 'D',
      ts: Date.now(),
      event: 'forward_http_error',
      error: 'upstream_failed',
      detail: `http_${response.status}`,
      method: 'POST',
      path: '/api/resolve',
      correlationId,
      url: response.url || serverBUrl,
      status: response.status,
      statusText: String(response.statusText || ''),
    }));
    return { data: null, error: `http_${response.status}` };
  }

  const url = response.url;
  try {
    const data = await response.json();
    return { data, error: null };
  } catch {
    console.error(JSON.stringify({
      server: 'D',
      ts: Date.now(),
      event: 'forward_invalid_json',
      error: 'upstream_failed',
      detail: 'invalid_json',
      method: 'POST',
      path: '/api/resolve',
      correlationId,
      url,
    }));
    return { data: null, error: 'invalid_json' };
  }
}
