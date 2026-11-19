// bindings.js - bind data-action attributes to global functions
(function() {
  function bindActions() {
    // Click bindings
    document.querySelectorAll('[data-action]').forEach((el) => {
      const name = el.getAttribute('data-action');
      if (!name) return;
      // Avoid double-binding
      if (el.__boundAction === name) return;
      el.__boundAction = name;

      const handler = (e) => {
        try {
          const fn = window[name];
          if (typeof fn === 'function') {
            fn(e);
          } else {
            console.warn('No global function named', name);
          }
        } catch (err) {
          console.error('Error invoking action', name, err);
        }
      };

      // If element is a form, bind submit; otherwise bind click
      if (el.tagName.toLowerCase() === 'form') {
        el.addEventListener('submit', (e) => {
          e.preventDefault();
          handler(e);
        });
      } else {
        el.addEventListener('click', (e) => {
          handler(e);
        });
      }
    });
  }

  function bindTiltElements() {
    document.querySelectorAll('.card, .stat-card, .action-card, .chart-card').forEach((element) => {
      if (element.__tiltBound) return;
      element.__tiltBound = true;
      element.style.transformStyle = 'preserve-3d';
      element.style.transition = 'transform 0.2s ease, box-shadow 0.2s ease';

      const reset = () => {
        element.style.transform = 'perspective(900px) rotateX(0deg) rotateY(0deg)';
        element.style.boxShadow = '0 22px 60px rgba(17,32,51,0.07)';
      };

      element.addEventListener('mousemove', (event) => {
        const rect = element.getBoundingClientRect();
        const dx = event.clientX - rect.left - rect.width / 2;
        const dy = event.clientY - rect.top - rect.height / 2;
        const rotationX = (-dy / rect.height) * 8;
        const rotationY = (dx / rect.width) * 8;
        element.style.transform = `perspective(900px) rotateX(${rotationX}deg) rotateY(${rotationY}deg)`;
        element.style.boxShadow = '0 28px 78px rgba(17,32,51,0.14)';
      });

      element.addEventListener('mouseleave', () => {
        reset();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindActions();
    bindTiltElements();
  });
  // Also re-bind when new nodes are inserted (basic support)
  const observer = new MutationObserver(() => {
    bindActions();
    bindTiltElements();
  });
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
})();
