// node:inspector/promises — Session.post returns a promise.
import inspector, { Session as CallbackSession, open, close, url, waitForDebugger, console, Network } from "ext:kestrel/node/inspector.js";
export class Session extends CallbackSession {
  post(method, params) {
    return new Promise((resolve, reject) => super.post(method, params, (err, result) => (err ? reject(err) : resolve(result))));
  }
}
export { open, close, url, waitForDebugger, console, Network };
export default { ...inspector, Session };
