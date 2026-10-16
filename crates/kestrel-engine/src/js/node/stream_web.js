// node:stream/web — the Web Streams API as a Node builtin module (globals are defined by
// web_streams.js; this just re-exports them).
export const ReadableStream = globalThis.ReadableStream;
export const WritableStream = globalThis.WritableStream;
export const TransformStream = globalThis.TransformStream;
export const ByteLengthQueuingStrategy = globalThis.ByteLengthQueuingStrategy;
export const CountQueuingStrategy = globalThis.CountQueuingStrategy;
export const TextEncoderStream = globalThis.TextEncoderStream;
export const TextDecoderStream = globalThis.TextDecoderStream;
export const ReadableStreamDefaultReader = globalThis.ReadableStreamDefaultReader;
export const ReadableStreamDefaultController = globalThis.ReadableStreamDefaultController;
export const WritableStreamDefaultWriter = globalThis.WritableStreamDefaultWriter;
export const WritableStreamDefaultController = globalThis.WritableStreamDefaultController;
export default { ReadableStream, WritableStream, TransformStream, ByteLengthQueuingStrategy, CountQueuingStrategy, TextEncoderStream, TextDecoderStream, ReadableStreamDefaultReader, ReadableStreamDefaultController, WritableStreamDefaultWriter, WritableStreamDefaultController };
