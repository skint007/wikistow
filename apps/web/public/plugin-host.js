// The plugin host frame (ADR 0002). The app frames plugin-host.html with
// sandbox="allow-scripts", so this runs at an opaque origin, under a policy
// that allows no requests and only `data:` workers. It runs no plugin code
// itself: a loop on this thread would freeze the whole tab in Firefox and
// WebKit. Each script runs in a module worker of its own, and this relays
// its messages to and from a MessagePort the app gave with it.
//
// From the app (window messages):
//   { type: 'start', id, name, source } with the port: start `source` as a
//     module worker named `name` (its plugin's ID).
//   { type: 'end', id }: terminate that worker.
// To the app (window messages): { type: 'ready' } once loaded, and
//   { type: 'ended', id } after each end, so the app knows it still answers.
// On each port, to the app: { message } for each of the worker's messages,
//   and { error } if it fails to load or throws. From the app: messages for
//   the worker, passed on as they are.
(function () {
  var running = new Map();

  // Base64, so a 1 MB script stays under Chromium's 2 MB limit on `data:`
  // workers whatever characters it has.
  function dataUrl(source) {
    var bytes = new TextEncoder().encode(source);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return 'data:text/javascript;base64,' + btoa(binary);
  }

  function start(id, name, source, port) {
    var worker;
    try {
      worker = new Worker(dataUrl(source), { type: 'module', name: name });
    } catch (error) {
      port.postMessage({ error: String((error && error.message) || error) });
      return;
    }
    running.set(id, { worker: worker, port: port });
    worker.onmessage = function (event) {
      port.postMessage({ message: event.data });
    };
    worker.onerror = function (event) {
      event.preventDefault();
      port.postMessage({ error: event.message || '' });
    };
    port.onmessage = function (event) {
      worker.postMessage(event.data);
    };
  }

  function end(id) {
    var script = running.get(id);
    if (script) {
      script.worker.terminate();
      script.port.close();
      running.delete(id);
    }
    parent.postMessage({ type: 'ended', id: id }, '*');
  }

  window.addEventListener('message', function (event) {
    // Only the app that framed this. Its answers go to '*': this frame's
    // opaque origin can't name the app's, and they carry nothing secret.
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || typeof data.id !== 'number') return;
    if (data.type === 'start' && event.ports[0]) {
      start(data.id, String(data.name), String(data.source), event.ports[0]);
    } else if (data.type === 'end') {
      end(data.id);
    }
  });

  parent.postMessage({ type: 'ready' }, '*');
})();
