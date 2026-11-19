/* Local Bootstrap modal subset. Enough for ERS dashboards when CDN scripts are unavailable. */
(function () {
  class Modal {
    constructor(element) {
      if (typeof element === 'string') {
        element = document.querySelector(element);
      }
      if (!element) throw new Error('Modal element not found');
      this.element = element;
      Modal.instances.set(element, this);
    }

    show() {
      const event = new Event('show.bs.modal', { bubbles: true });
      this.element.dispatchEvent(event);
      this.element.classList.add('show');
      this.element.style.display = 'block';
      this.element.removeAttribute('aria-hidden');
      this.element.removeAttribute('inert');
      document.body.classList.add('modal-open');
      const shown = new Event('shown.bs.modal', { bubbles: true });
      this.element.dispatchEvent(shown);
    }

    hide() {
      const event = new Event('hide.bs.modal', { bubbles: true });
      this.element.dispatchEvent(event);
      this.element.classList.remove('show');
      this.element.style.display = 'none';
      this.element.setAttribute('aria-hidden', 'true');
      this.element.setAttribute('inert', '');
      document.body.classList.remove('modal-open');
      const hidden = new Event('hidden.bs.modal', { bubbles: true });
      this.element.dispatchEvent(hidden);
    }

    static getInstance(element) {
      return Modal.instances.get(element) || null;
    }

    static getOrCreateInstance(element) {
      return Modal.getInstance(element) || new Modal(element);
    }
  }

  Modal.instances = new WeakMap();
  window.bootstrap = window.bootstrap || {};
  window.bootstrap.Modal = Modal;

  document.addEventListener('click', (event) => {
    const close = event.target.closest('[data-bs-dismiss="modal"]');
    if (close) {
      const modal = close.closest('.modal');
      if (modal) Modal.getOrCreateInstance(modal).hide();
      return;
    }

    const trigger = event.target.closest('[data-bs-toggle="modal"]');
    if (trigger) {
      const selector = trigger.getAttribute('data-bs-target') || trigger.getAttribute('href');
      if (selector) {
        const modal = document.querySelector(selector);
        if (modal) Modal.getOrCreateInstance(modal).show();
      }
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.modal.show').forEach((modal) => {
      Modal.getOrCreateInstance(modal).hide();
    });
  });
})();
