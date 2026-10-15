const assert = require("node:assert");
const Redis = require("ioredis");

const TEST_DB = 15;

/** Cliente en la DB 15 del Redis del compose, vacía: la DB 0 guarda datos de desarrollo. */
async function createTestRedis() {
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:16379", { db: TEST_DB });
  assert.strictEqual(redis.options.db, TEST_DB);
  await redis.flushdb();
  return redis;
}

module.exports = { createTestRedis };
