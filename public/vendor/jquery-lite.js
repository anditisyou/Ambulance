/* Tiny jQuery compatibility shim for legacy modal calls. */
(function () {
  if (window.jQuery) return;

  function JQueryLite(input) {
    const nodes = typeof input === 'string'
      ? Array.from(document.querySelectorAll(input))
      : input instanceof Element
        ? [input]
        : Array.from(input || []);

    return {
      modal(action) {
        nodes.forEach((node) => {
          if (!window.bootstrap?.Modal) return;
          const instance = window.bootstrap.Modal.getOrCreateInstance(node);
          if (action === 'hide') instance.hide();
          else instance.show();
        });
        return this;
      },
      on(eventName, handler) {
        nodes.forEach((node) => node.addEventListener(eventName, handler));
        return this;
      },
    };
  }

  window.jQuery = window.$ = JQueryLite;
})();
