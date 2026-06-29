// @solana/web3.js v1 and torna-sdk rely on the Node `Buffer` global, which the browser
// does not provide. Import this FIRST (before any web3.js-dependent module) so Buffer exists
// at module-evaluation time. See ts-sdk/README "Requirements".
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}
