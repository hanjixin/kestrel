import { strict } from "ext:kestrel/node/assert.js";
export * from "ext:kestrel/node/assert.js";
export const equal = strict.equal, notEqual = strict.notEqual;
export const deepEqual = strict.deepEqual, notDeepEqual = strict.notDeepEqual;
export default strict;
