// node:util/types
const tag = (v) => Object.prototype.toString.call(v).slice(8, -1);
export const isAnyArrayBuffer = (v) => v instanceof ArrayBuffer || v instanceof SharedArrayBuffer;
export const isArrayBuffer = (v) => v instanceof ArrayBuffer;
export const isSharedArrayBuffer = (v) => v instanceof SharedArrayBuffer;
export const isArrayBufferView = (v) => ArrayBuffer.isView(v);
export const isTypedArray = (v) => ArrayBuffer.isView(v) && !(v instanceof DataView);
export const isUint8Array = (v) => v instanceof Uint8Array;
export const isUint8ClampedArray = (v) => v instanceof Uint8ClampedArray;
export const isUint16Array = (v) => v instanceof Uint16Array;
export const isUint32Array = (v) => v instanceof Uint32Array;
export const isInt8Array = (v) => v instanceof Int8Array;
export const isInt16Array = (v) => v instanceof Int16Array;
export const isInt32Array = (v) => v instanceof Int32Array;
export const isFloat32Array = (v) => v instanceof Float32Array;
export const isFloat64Array = (v) => v instanceof Float64Array;
export const isBigInt64Array = (v) => v instanceof BigInt64Array;
export const isBigUint64Array = (v) => v instanceof BigUint64Array;
export const isDataView = (v) => v instanceof DataView;
export const isDate = (v) => v instanceof Date;
export const isRegExp = (v) => v instanceof RegExp;
export const isMap = (v) => v instanceof Map;
export const isSet = (v) => v instanceof Set;
export const isWeakMap = (v) => v instanceof WeakMap;
export const isWeakSet = (v) => v instanceof WeakSet;
export const isPromise = (v) => v instanceof Promise;
export const isNativeError = (v) => v instanceof Error;
export const isBoxedPrimitive = (v) => v instanceof Number || v instanceof String || v instanceof Boolean || (typeof v === "object" && v !== null && (tag(v) === "Symbol" || tag(v) === "BigInt"));
export const isNumberObject = (v) => v instanceof Number;
export const isStringObject = (v) => v instanceof String;
export const isBooleanObject = (v) => v instanceof Boolean;
export const isSymbolObject = (v) => typeof v === "object" && v !== null && tag(v) === "Symbol";
export const isBigIntObject = (v) => typeof v === "object" && v !== null && tag(v) === "BigInt";
export const isAsyncFunction = (v) => typeof v === "function" && v.constructor && v.constructor.name === "AsyncFunction";
export const isGeneratorFunction = (v) => typeof v === "function" && v.constructor && /GeneratorFunction$/.test(v.constructor.name);
export const isGeneratorObject = (v) => tag(v) === "Generator";
export const isMapIterator = (v) => tag(v) === "Map Iterator";
export const isSetIterator = (v) => tag(v) === "Set Iterator";
export const isArgumentsObject = (v) => tag(v) === "Arguments";
export const isProxy = () => false;
export const isModuleNamespaceObject = (v) => tag(v) === "Module";
export const isExternal = () => false;
export const isKeyObject = () => false;
export const isCryptoKey = () => false;
export default {
  isAnyArrayBuffer, isArrayBuffer, isSharedArrayBuffer, isArrayBufferView, isTypedArray, isUint8Array, isUint8ClampedArray, isUint16Array, isUint32Array,
  isInt8Array, isInt16Array, isInt32Array, isFloat32Array, isFloat64Array, isBigInt64Array, isBigUint64Array, isDataView, isDate, isRegExp, isMap, isSet,
  isWeakMap, isWeakSet, isPromise, isNativeError, isBoxedPrimitive, isNumberObject, isStringObject, isBooleanObject, isSymbolObject, isBigIntObject,
  isAsyncFunction, isGeneratorFunction, isGeneratorObject, isMapIterator, isSetIterator, isArgumentsObject, isProxy, isModuleNamespaceObject, isExternal, isKeyObject, isCryptoKey,
};
