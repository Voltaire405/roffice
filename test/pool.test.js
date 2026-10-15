const test = require("node:test");
const assert = require("node:assert");
const { createPool } = require("../src/pool");
const { createTestRedis } = require("./redis");

async function setup(t, options = {}) {
  const redis = await createTestRedis();
  t.after(() => redis.quit());
  return createPool({ redis, instances: "http://oo-1|http://pub-1,http://oo-2|http://pub-2", ...options });
}

const load = async (pool) => Object.fromEntries((await pool.status()).map((inst) => [inst.url, inst.activeDocuments]));

test("aperturas simultáneas del mismo documento comparten instancia y key", async (t) => {
  const pool = await setup(t);
  const [a, b] = await Promise.all([pool.assign("t:doc", "key-a"), pool.assign("t:doc", "key-b")]);

  assert.strictEqual(a.instanceUrl, b.instanceUrl);
  assert.strictEqual(a.documentKey, b.documentKey);
  assert.deepStrictEqual([a.joined, b.joined].sort(), [false, true]);
  assert.deepStrictEqual(await load(pool), { "http://oo-1": 1, "http://oo-2": 0 });
});

test("reparte documentos por carga y libera la carga al cerrar", async (t) => {
  const pool = await setup(t);
  const a = await pool.assign("t:a", "ka");
  const b = await pool.assign("t:b", "kb");
  assert.notStrictEqual(a.instanceUrl, b.instanceUrl);
  assert.strictEqual(b.publicUrl, b.instanceUrl.replace("oo", "pub"));

  const joined = await pool.assign("t:a", "otra");
  assert.deepStrictEqual([joined.instanceUrl, joined.documentKey, joined.joined], [a.instanceUrl, "ka", true]);
  assert.deepStrictEqual(await pool.lookup("t:a"), { instanceUrl: a.instanceUrl, documentKey: "ka", assignedAt: (await pool.lookup("t:a")).assignedAt });

  await pool.release("t:a");
  assert.strictEqual(await pool.lookup("t:a"), null);
  assert.deepStrictEqual(await load(pool), { [a.instanceUrl]: 0, [b.instanceUrl]: 1 });
});

test("una asignación vencida deja de contar como carga", async (t) => {
  const pool = await setup(t, { assignmentTtlSeconds: 1 });
  await pool.assign("t:a", "ka");
  await new Promise((resolve) => setTimeout(resolve, 1100));

  assert.deepStrictEqual(await load(pool), { "http://oo-1": 0, "http://oo-2": 0 });
  assert.strictEqual((await pool.assign("t:b", "kb")).instanceUrl, "http://oo-1");
});
