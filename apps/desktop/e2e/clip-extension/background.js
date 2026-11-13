// The desktop tests call `converse` in this service worker
// (e2e/clip.spec.ts): it connects to the native host, sends the messages,
// and answers the first `count` messages back, or what came before the
// port closed, with the browser's error.
globalThis.converse = (host, messages, count) =>
  new Promise((resolve) => {
    const port = chrome.runtime.connectNative(host);
    const received = [];
    port.onMessage.addListener((message) => {
      received.push(message);
      if (received.length < count) return;
      port.disconnect();
      resolve({ received });
    });
    port.onDisconnect.addListener(() =>
      resolve({ received, error: chrome.runtime.lastError?.message ?? null }),
    );
    for (const message of messages) port.postMessage(message);
  });
