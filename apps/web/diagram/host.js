// The diagram host frame (ADR 0010). The app frames the host page, which
// the build writes under /assets/diagram/ with this script and Mermaid's
// own, each named by its hash (vite.config.ts), loading Mermaid before this,
// with sandbox="allow-scripts", so Mermaid runs here at an opaque origin, under
// a policy that allows no requests, and may use the inline styles it needs
// to measure text. It draws each diagram it is sent and returns the SVG
// as text; the app shows it as an image, where nothing in it runs.
//
// From the app (window messages):
//   { type: 'render', id, source, look }: draw `source` in the theme's
//     colours, `look` ({ dark, variables }: Mermaid's theme variables as
//     plain colours), or in Mermaid's own light theme if `look` is null.
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
  function sized(svg, look) {
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
      names[i].style.setProperty('fill', look ? look.variables.textColor : '#333');
    }
    return new XMLSerializer().serializeToString(root);
  }

  // An SVG image can't load the app's web fonts: measure and draw in
  // fonts every system has, and as SVG text, not HTML.
  var FONTS = 'ui-sans-serif, system-ui, sans-serif';

  function settings(look) {
    return {
      startOnLoad: false,
      securityLevel: 'strict',
      theme: look ? 'base' : 'default',
      themeVariables: look
        ? Object.assign({}, look.variables, { darkMode: look.dark, fontFamily: FONTS })
        : {},
      fontFamily: FONTS,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // A journey's text is HTML in the SVG by default, which a canvas
      // won't export, so its public copy would get no image.
      journey: { textPlacement: 'tspan' },
    };
  }

  // Anything that throws on the way, sizing too, fails this diagram only.
  function render(id, source, look) {
    return Promise.resolve()
      .then(function () {
        mermaid.initialize(settings(look));
        count += 1;
        return mermaid.render('diagram-' + count, source);
      })
      .then(function (result) {
        parent.postMessage({ type: 'rendered', id: id, svg: sized(result.svg, look) }, '*');
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
      return render(data.id, String(data.source), data.look || null);
    });
  });

  parent.postMessage({ type: 'ready' }, '*');
})();
