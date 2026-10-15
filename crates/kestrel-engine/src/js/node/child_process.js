// node:child_process — not available yet.
import { nodeError } from "ext:kestrel/internal.js";
const nyi = (n) => () => { throw nodeError("ERR_METHOD_NOT_IMPLEMENTED", "child_process." + n + " is not implemented in kestrel yet"); };
export const spawn = nyi("spawn"), exec = nyi("exec"), execFile = nyi("execFile"), fork = nyi("fork"), spawnSync = nyi("spawnSync"), execSync = nyi("execSync"), execFileSync = nyi("execFileSync");
export class ChildProcess {}
export default { spawn, exec, execFile, fork, spawnSync, execSync, execFileSync, ChildProcess };
