// lib/redis.js  (CommonJS)
const Redis = require("ioredis");

let client;
function getRedis() {
  if (!client) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("Missing REDIS_URL");
    client = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableAutoPipelining: true,
      lazyConnect: false,
    });
  }
  return client;
}

module.exports = { getRedis };
