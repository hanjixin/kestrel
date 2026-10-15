// Exercises node builtins through require(); output is compared with node.
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const util = require("util");
const crypto = require("crypto");
const zlib = require("zlib");
const { URL, URLSearchParams, fileURLToPath, pathToFileURL } = require("url");
const { Buffer } = require("buffer");
const { Readable, Transform, pipeline } = require("stream");
const { StringDecoder } = require("string_decoder");
const qs = require("querystring");
const { Counter, add, VERSION } = require("./lib.cjs");
const data = require("./data.json");
const out = [];
const log = (...a) => out.push(util.format(...a));

// path
log(path.join("/a/b", "../c", "./d.txt"), path.resolve("/x", "y", "..", "z"), path.basename("/p/q/file.tar.gz", ".gz"), path.extname("a/b.c.d"), JSON.stringify(path.parse("/home/u/f.txt")), path.relative("/a/b/c", "/a/d"), path.normalize("a//b/../c/"), path.isAbsolute("x"), path.dirname("/a/b/"));
// fs
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kc-"));
const f = path.join(tmp, "x.txt");
fs.writeFileSync(f, "héllo\n");
fs.appendFileSync(f, Buffer.from([0x77, 0x6f, 0x72, 0x6c, 0x64]));
log(fs.readFileSync(f, "utf8"), fs.readFileSync(f).length, fs.existsSync(f), fs.existsSync(f + ".nope"), fs.statSync(f).isFile(), fs.statSync(tmp).isDirectory(), fs.statSync(f).size);
fs.mkdirSync(path.join(tmp, "d1/d2"), { recursive: true });
fs.writeFileSync(path.join(tmp, "d1/d2/y.json"), JSON.stringify({ a: 1 }));
log(JSON.stringify(fs.readdirSync(tmp).sort()), JSON.stringify(fs.readdirSync(path.join(tmp, "d1"), { withFileTypes: true }).map((d) => [d.name, d.isDirectory()])));
fs.renameSync(f, f + ".bak");
try { fs.readFileSync(f); } catch (e) { log(e.code, e.syscall, e.message.split(",")[0]); }
fs.rmSync(tmp, { recursive: true, force: true });
log(fs.existsSync(tmp));
// util
log(util.inspect({ a: [1, { b: new Map([["k", new Set([1])]]) }], s: "str", n: null, u: undefined, f() {}, d: new Date(0), r: /x/g, big: 10n }), util.format("%s=%d %j %o", "k", 42, { z: 1 }, [1]), util.isDeepStrictEqual({ a: [1, 2] }, { a: [1, 2] }), util.types.isPromise(Promise.resolve()), typeof util.promisify(fs.readFile));
// events
const c = new Counter(); let seen = []; c.on("inc", (n) => seen.push(n)); c.once("inc", () => seen.push("once")); c.inc().inc();
log(JSON.stringify(seen), c.listenerCount("inc"), add(2, 3), VERSION, data.name, data.items.length);
// buffer
const b = Buffer.from("hello world");
log(b.toString("hex"), b.toString("base64"), Buffer.from("aGk=", "base64").toString(), Buffer.concat([Buffer.from([1, 2]), Buffer.from([3])]).toString("hex"), b.readUInt16BE(0), b.indexOf("world"), Buffer.byteLength("héllo"), b.slice(0, 5).toString(), Buffer.alloc(3, "ab").toString(), Buffer.compare(Buffer.from("a"), Buffer.from("b")), JSON.stringify(Buffer.from([1,2])), Buffer.isBuffer(b), b.equals(Buffer.from("hello world")));
// crypto
log(crypto.createHash("sha256").update("abc").digest("hex"), crypto.createHash("md5").update("abc").digest("base64"), crypto.createHmac("sha1", "key").update("data").digest("hex"), crypto.randomBytes(8).length, /^[0-9a-f-]{36}$/.test(crypto.randomUUID()), crypto.timingSafeEqual(Buffer.from("ab"), Buffer.from("ab")));
// zlib
const z = zlib.gzipSync("hello hello hello hello");
log(zlib.gunzipSync(z).toString(), zlib.inflateSync(zlib.deflateSync(Buffer.from("xyz"))).toString(), zlib.inflateRawSync(zlib.deflateRawSync("raw")).toString(), z[0], z[1]);
// url
const u = new URL("https://user:pw@example.com:8080/p/a/t/h?query=string&a=1#hash");
log(u.href, u.origin, u.host, u.pathname, u.search, u.hash, u.searchParams.get("a"), [...u.searchParams.keys()].join(","), new URL("../x?y=1", "http://h/a/b/c").href, new URLSearchParams({ a: "1 2", b: "&" }).toString(), fileURLToPath("file:///tmp/a%20b.txt"), pathToFileURL("/tmp/a b.txt").href);
u.searchParams.append("z", "9"); u.pathname = "/new"; u.hash = "";
log(u.href);
// querystring / string_decoder
log(JSON.stringify(qs.parse("a=1&b=2&a=3")), qs.stringify({ x: [1, 2], y: "a b" }));
const dec = new StringDecoder("utf8"); const euro = Buffer.from("€");
log(dec.write(euro.subarray(0, 1)) + "|" + dec.write(euro.subarray(1)) + "|" + dec.end());
// streams
const chunks = [];
const upper = new Transform({ transform(chunk, enc, cb) { cb(null, chunk.toString().toUpperCase()); } });
pipeline(Readable.from(["ab", "cd", "ef"]), upper, new (require("stream").Writable)({ write(c, e, cb) { chunks.push(c.toString()); cb(); } }), (err) => {
  log("pipeline", err ? err.message : "ok", chunks.join(""));
  // os / process
  log(typeof os.cpus().length, os.EOL === "\n", os.platform() === process.platform, typeof os.homedir(), process.argv.length >= 2, typeof process.env.PATH, process.cwd() === require("process").cwd(), typeof process.hrtime.bigint(), typeof performance.now());
  assert.strictEqual(add(1, 1), 2);
  assert.deepStrictEqual({ a: [1] }, { a: [1] });
  assert.throws(() => { throw new TypeError("boom"); }, TypeError);
  try { assert.strictEqual(1, 2); } catch (e) { log(e.code, e.name); }
  console.log(out.join("\n"));
});
// --- appended: kdf / ciphers / brotli (compared with node) ---
{
  const crypto = require("crypto"), zlib = require("zlib");
  const key = crypto.pbkdf2Sync("pw", "salt", 1000, 32, "sha256");
  const iv = Buffer.alloc(12, 7);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv); c.setAAD(Buffer.from("aad"));
  const ct = Buffer.concat([c.update("secret message"), c.final()]); const tag = c.getAuthTag();
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv); d.setAAD(Buffer.from("aad")); d.setAuthTag(tag);
  const pt = Buffer.concat([d.update(ct), d.final()]).toString();
  const cbc = crypto.createCipheriv("aes-128-cbc", key.subarray(0, 16), Buffer.alloc(16, 1));
  const cbcCt = Buffer.concat([cbc.update("abc"), cbc.final()]).toString("hex");
  const br = zlib.brotliCompressSync("brotli brotli brotli");
  console.log(JSON.stringify([key.toString("hex"), ct.toString("hex"), tag.toString("hex"), pt, cbcCt, crypto.scryptSync("pw", "salt", 16, { N: 1024 }).toString("hex"), Buffer.from(crypto.hkdfSync("sha256", "ikm", "salt", "info", 16)).toString("hex"), zlib.brotliDecompressSync(br).toString(), br.length < 20]));
}
// --- appended: asymmetric crypto (deterministic parts compared with node) ---
{
  const crypto = require("crypto");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const sig = crypto.createSign("SHA256").update("payload").sign(privateKey);
  const ok = crypto.createVerify("SHA256").update("payload").verify(publicKey, sig);
  const bad = crypto.createVerify("SHA256").update("tampered").verify(publicKey, sig);
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const esig = crypto.sign("sha256", Buffer.from("ec-payload"), ec.privateKey);
  const eok = crypto.verify("sha256", Buffer.from("ec-payload"), ec.publicKey, esig);
  const pubObj = crypto.createPublicKey(publicKey);
  console.log(JSON.stringify([publicKey.startsWith("-----BEGIN PUBLIC KEY-----"), privateKey.startsWith("-----BEGIN PRIVATE KEY-----"), sig.length, ok, bad, eok, pubObj.type, pubObj.asymmetricKeyType, pubObj.asymmetricKeyDetails.modulusLength, ec.publicKey.asymmetricKeyType]));
}
