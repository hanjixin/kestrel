// node:process
const process = globalThis.process;
export default process;
export const { argv, env, platform, pid, exit, nextTick, cwd, chdir, hrtime, versions, version, stdout, stderr, stdin, on, once, off, emit, exitCode, title, arch, execPath, execArgv, uptime, memoryUsage, emitWarning, umask, kill, release, config, features } = process;
