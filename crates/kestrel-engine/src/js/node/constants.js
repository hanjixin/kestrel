// node:constants (legacy aggregate)
import os from "ext:kestrel/node/os.js";
import fs from "ext:kestrel/node/fs.js";
import crypto from "ext:kestrel/node/crypto.js";
const constants = { ...os.constants.signals, ...os.constants.errno, ...os.constants.priority, ...fs.constants, ...crypto.constants };
export default constants;
