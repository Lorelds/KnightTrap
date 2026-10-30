// Upstash Redis client, created on first use from environment variables.
// The Vercel Marketplace integration sets either UPSTASH_REDIS_REST_* or KV_REST_API_*.
// Files under api/_lib are not deployed as endpoints.

let client = null;

export async function getRedis() {
  if (client) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  // Imported lazily so the tests can run with a mock and no installed packages.
  const { Redis } = await import('@upstash/redis');
  client = new Redis({ url, token });
  return client;
}

// Tests only.
export function setRedis(mock) {
  client = mock;
}
