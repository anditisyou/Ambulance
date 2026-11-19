/* Minimal Chart.js fallback so dashboards remain usable offline. */
(function () {
  if (window.Chart) return;

  class ChartLite {
    constructor(canvas, config) {
      this.canvas = canvas;
      this.config = config || {};
      this.ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
      this.render();
    }

    render() {
      if (!this.ctx || !this.canvas) return;
      const ctx = this.ctx;
      const width = this.canvas.width || this.canvas.clientWidth || 320;
      const height = this.canvas.height || this.canvas.clientHeight || 180;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#cbd5e1';
      ctx.strokeRect(0, 0, width, height);
      ctx.fillStyle = '#334155';
      ctx.font = '14px Segoe UI, Arial, sans-serif';
      ctx.fillText('Chart data loaded', 16, 28);

      const labels = this.config?.data?.labels || [];
      const datasets = this.config?.data?.datasets || [];
      const values = datasets[0]?.data || [];
      const max = Math.max(1, ...values.map(Number));
      const barWidth = Math.max(12, (width - 40) / Math.max(1, values.length));
      values.forEach((value, index) => {
        const barHeight = Math.max(4, (Number(value) / max) * (height - 70));
        const x = 20 + index * barWidth;
        const y = height - 28 - barHeight;
        ctx.fillStyle = datasets[0]?.backgroundColor || '#0f6fff';
        ctx.fillRect(x, y, barWidth * .65, barHeight);
        ctx.fillStyle = '#475569';
        ctx.font = '10px Segoe UI, Arial, sans-serif';
        ctx.fillText(String(labels[index] || index + 1).slice(0, 8), x, height - 10);
      });
    }

    update() {
      this.render();
    }

    destroy() {}
  }

  window.Chart = ChartLite;
})();
