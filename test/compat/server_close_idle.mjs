import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { strict as assert } from "node:assert";

const first = http.createServer((req, res) => res.end("one"));
const second = http.createServer((req, res) => res.end("two"));
first.listen(0, "127.0.0.1");
second.listen(0, "127.0.0.1");
await Promise.all([once(first, "listening"), once(second, "listening")]);
const port = first.address().port;
const socket = net.connect(port, "127.0.0.1");
await once(socket, "connect");
let response = "";
const received = new Promise(resolve => socket.on("data", b => {
  response += b.toString();
  if (response.endsWith("one")) resolve();
}));
socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
await received;
const ended = once(socket, "end");
const closed = once(first, "close");
first.close();
await Promise.all([ended, closed]);
socket.destroy();
assert.equal(await (await fetch(`http://127.0.0.1:${second.address().port}/`)).text(), "two");
// The same server instance can bind its old port after closing.
first.listen(port, "127.0.0.1");
await once(first, "listening");
const stopped = [once(first, "close"), once(second, "close")];
first.close();
second.close();
await Promise.all(stopped);
console.log("idle connection closed, other server preserved, listener restarted");
