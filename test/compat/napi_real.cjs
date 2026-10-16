// Real prebuilt Node-API addons from npm: sqlite3 (node-sqlite3, N-API, callbacks and async
// work) and bcrypt (async work on the thread pool).
const sqlite3 = require("sqlite3");
const bcrypt = require("bcrypt");
const out = [];
const db = new sqlite3.Database(":memory:");
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, rows) => (e ? rej(e) : res(rows))));
(async () => {
  await run("create table t (id integer primary key, name text, blob blob)");
  for (const n of ["a", "bb", "ccc"]) await run("insert into t (name, blob) values (?, ?)", [n, Buffer.from(n)]);
  out.push(await all("select count(*) as c, sum(length(name)) as l from t"));
  out.push(await all("select name, length(blob) as b from t order by id desc"));
  const st = await run("insert into t (name) values (?)", ["last"]);
  out.push(st.lastID, st.changes);
  try { await all("select * from nope"); } catch (e) { out.push(e.code, e.errno); }
  await new Promise((r) => db.close(r));
  const hash = bcrypt.hashSync("secret", 4);
  out.push(hash.startsWith("$2b$04$"), bcrypt.compareSync("secret", hash), bcrypt.compareSync("wrong", hash));
  out.push(await bcrypt.compare("async", await bcrypt.hash("async", 4)));
  console.log(JSON.stringify(out));
})();
