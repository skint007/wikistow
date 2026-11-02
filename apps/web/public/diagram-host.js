// The diagram host frame (ADR 0010). The app frames diagram-host.html
// (which the build writes, loading Mermaid's own script before this one)
// with sandbox="allow-scripts", so Mermaid runs here at an opaque origin, under
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
  // Mermaid writes the SVG as HTML, whose one entity XML lacks is
  // `&nbsp;` (a non-breaking space in a label).
  //
  // A journey's task and section names drawn as SVG text are filled with
  // its `sectionColours`, white, which Mermaid reads once as it loads, so
  // setting it does nothing, and a section's name also takes its box's
  // colour from the SVG's stylesheet. They take the theme's text colour
  // here, as a style, which beats the stylesheet.
  function sized(svg, dark) {
    var xml = svg.replace(/&nbsp;/g, '&#160;');
    var doc = new DOMParser().parseFromString(xml, 'image/svg+xml');
    var root = doc.documentElement;
    var box = root.viewBox.baseVal;
    if (box && box.width > 0 && box.height > 0) {
      root.setAttribute('width', String(Math.ceil(box.width)));
      root.setAttribute('height', String(Math.ceil(box.height)));
      root.style.removeProperty('max-width');
    }
    var names = root.querySelectorAll('text.task, text.journey-section');
    for (var i = 0; i < names.length; i++) {
      names[i].style.setProperty('fill', dark ? '#ccc' : '#333');
    }
    return new XMLSerializer().serializeToString(root);
  }

  function settings(dark) {
    return {
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      // An SVG image can't load the app's web fonts: measure and draw in
      // fonts every system has, and as SVG text, not HTML.
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // A journey's text is HTML in the SVG by default, which a canvas
      // won't export, so its public copy would get no image.
      journey: { textPlacement: 'tspan' },
    };
  }

  // Anything that throws on the way, sizing too, fails this diagram only.
  function render(id, source, dark) {
    return Promise.resolve()
      .then(function () {
        mermaid.initialize(settings(dark));
        count += 1;
        return mermaid.render('diagram-' + count, source);
      })
      .then(function (result) {
        parent.postMessage({ type: 'rendered', id: id, svg: sized(result.svg, dark) }, '*');
      })
      .catch(function (error) {
        parent.postMessage(
          { type: 'failed', id: id, error: String((error && error.message) || error) },
          '*',
        );
      });
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
