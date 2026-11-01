// The diagram host frame (ADR 0010). The app frames diagram-host.html with
// sandbox="allow-scripts", so Mermaid runs here at an opaque origin, under
// a policy that allows no requests, and may use the inline styles it needs
// to measure text. It draws each diagram it is sent and returns the SVG
// as text; the app shows it as an image, where nothing in it runs.
//
// From the app (window messages):
//   { type: 'render', id, source, dark }: draw `source`, in the dark theme
//     if `dark`.
// To the app (window messages): { type: 'ready' } once loaded, then for
//   each render { type: 'rendered', id, svg } or { type: 'failed', id, error }.
(function () {
  var queue = Promise.resolve();
  var count = 0;

  // Mermaid sizes the SVG to its container (`width="100%"` and a
  // max-width style). As an image it needs its own size: its viewBox's.
  function sized(svg) {
    var doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    var root = doc.documentElement;
    var box = root.viewBox.baseVal;
    if (box && box.width > 0 && box.height > 0) {
      root.setAttribute('width', String(Math.ceil(box.width)));
      root.setAttribute('height', String(Math.ceil(box.height)));
      root.style.removeProperty('max-width');
    }
    return new XMLSerializer().serializeToString(root);
  }

  function render(id, source, dark) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      // An SVG image can't load the app's web fonts: measure and draw in
      // fonts every system has, and as SVG text, not HTML.
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    count += 1;
    return mermaid.render('diagram-' + count, source).then(
      function (result) {
        parent.postMessage({ type: 'rendered', id: id, svg: sized(result.svg) }, '*');
      },
      function (error) {
        parent.postMessage(
          { type: 'failed', id: id, error: String((error && error.message) || error) },
          '*',
        );
      },
    );
  }

  window.addEventListener('message', function (event) {
    // Only the app that framed this. Answers go to '*': this frame's opaque
    // origin can't name the app's, and they carry only the drawn diagram.
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.type !== 'render' || typeof data.id !== 'number') return;
    queue = queue.then(function () {
      return render(data.id, String(data.source), Boolean(data.dark));
    });
  });

  parent.postMessage({ type: 'ready' }, '*');
})();
