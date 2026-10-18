import http from "node:http";
import { strict as assert } from "node:assert";

const response = new http.ServerResponse({ method: "GET" });
response.sendDate = false;
response.statusCode = 201;
response.setHeader("Content-Type", "text/plain");
const original = response.writeHead;
let calls = 0;
response.writeHead = function (...args) {
  calls++;
  this.setHeader("X-Middleware", "visited");
  return original.apply(this, args);
};
// Next's compression middleware uses this guard before writing a response.
for (let i = 0; i < 2; i++) {
  if (!response._header) response._implicitHeader();
}
assert.equal(calls, 1);
assert.equal(response.headersSent, true);
assert.equal(response.getHeader("X-Middleware"), "visited");
assert.equal(typeof response._header, "string");
assert.ok(response._header.startsWith("HTTP/1.1 201 Created\r\n"));
assert.throws(() => response.setHeader("Too-Late", "yes"), { code: "ERR_HTTP_HEADERS_SENT" });
const flushed = new http.ServerResponse({ method: "GET" });
let flushCalls = 0;
flushed.writeHead = function (...args) {
  flushCalls++;
  this.setHeader("X-Middleware", "flushed");
  return original.apply(this, args);
};
flushed.flushHeaders();
flushed.flushHeaders();
assert.equal(flushCalls, 1);
assert.equal(flushed.getHeader("X-Middleware"), "flushed");
console.log("implicit response headers: passed");
