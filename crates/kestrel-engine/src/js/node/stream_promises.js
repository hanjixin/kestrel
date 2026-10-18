import { promises } from "ext:kestrel/node/stream.js";
export const pipeline = promises.pipeline, finished = promises.finished;
export default promises;
