import sodium from 'libsodium-wrappers-sumo';

// libsodium is WebAssembly and must finish loading before any call. Awaiting
// here means every module that imports `sodium` gets a ready library, in the
// browser and in Node alike.
await sodium.ready;

export { sodium };
