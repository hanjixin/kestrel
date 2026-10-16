// Target for inspect.mjs: stays alive while the debugger client talks to it.
globalThis.answer = 6 * 7;
setTimeout(() => { console.log("target done"); process.exit(0); }, 4000);
