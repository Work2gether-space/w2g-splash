// lib/redis.js
// Node redis v4 client with TLS for Redis Cloud

import { createClient } from 'redis';

let client;

export async function getRedis() {
  if (client && client.isOpen) return client;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set');

  // For rediss urls the client enables TLS automatically — no manual socket config needed
  client = createClient({ url });

  client.on('error', (e) => console.error('[redis] client error', e?.message || e));

  await client.connect();
  return client;
}

