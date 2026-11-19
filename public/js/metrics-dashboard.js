// metrics-dashboard.js - moved from inline script
let metricsHistory = [];
let charts = {};

async function fetchMetrics() {
    try {
        const response = await fetch('/metrics', {
            credentials: 'include',
        });
        if (response.status === 401 || response.status === 403) {
            window.location.href = '/';
            return null;
        }
        if (!response.ok) {
            throw new Error(`Metrics request failed with status ${response.status}`);
        }
        const prometheusData = await response.text();
        return parsePrometheusMetrics(prometheusData);
    } catch (error) {
        console.error('Failed to fetch metrics:', error);
        return null;
    }
}

function parsePrometheusMetrics(data) {
    const metrics = {};
    const lines = data.split('\n').filter(line => line.trim() && !line.startsWith('#'));

    lines.forEach(line => {
        const [name, value] = line.split(' ');
        if (name && value) {
            metrics[name] = parseFloat(value) || 0;
        }
    });

    return metrics;
}

function updateMetricsCards(metrics) {
    const grid = document.getElementById('metricsGrid');
    const totalRequests = metrics.ers_requests_total || 0;
    const errors = metrics.ers_errors_total || 0;
    const errorRate = totalRequests > 0 ? (errors / totalRequests * 100).toFixed(2) : 0;
    const avgResponseTime = metrics.ers_avg_response_time || 0;
    const queueDepth = metrics.ers_dispatch_queue_depth || 0;
    const dispatchSuccess = metrics.ers_dispatch_success_total || 0;
    const dispatchFailure = metrics.ers_dispatch_failure_total || 0;

    const cards = [
        {
            title: 'Total Requests',
            value: totalRequests.toLocaleString(),
            subtitle: 'All-time requests processed',
            class: ''
        },
        {
            title: 'Error Rate',
            value: `${errorRate}%`,
            subtitle: `${errors} errors out of ${totalRequests} requests`,
            class: errorRate > 5 ? 'error' : errorRate > 1 ? 'warning' : 'success'
        },
        {
            title: 'Avg Response Time',
            value: `${avgResponseTime.toFixed(0)}ms`,
            subtitle: 'Average API response time',
            class: avgResponseTime > 5000 ? 'error' : avgResponseTime > 2000 ? 'warning' : 'success'
        },
        {
            title: 'Queue Depth',
            value: queueDepth.toString(),
            subtitle: 'Pending dispatch jobs',
            class: queueDepth > 50 ? 'error' : queueDepth > 20 ? 'warning' : 'success'
        },
        {
            title: 'Dispatch Success Rate',
            value: `${dispatchSuccess + dispatchFailure > 0 ? ((dispatchSuccess / (dispatchSuccess + dispatchFailure)) * 100).toFixed(1) : 0}%`,
            subtitle: `${dispatchSuccess} successful, ${dispatchFailure} failed`,
            class: dispatchFailure > dispatchSuccess * 0.1 ? 'error' : 'success'
        }
    ];

    grid.innerHTML = cards.map(card => `
        <div class="metric-card ${card.class}">
            <div class="metric-title">${card.title}</div>
            <div class="metric-value">${card.value}</div>
            <div class="metric-subtitle">${card.subtitle}</div>
        </div>
    `).join('');
}

function initCharts() {
    const ctx1 = document.getElementById('requestsChart').getContext('2d');
    const ctx2 = document.getElementById('errorRateChart').getContext('2d');
    const ctx3 = document.getElementById('responseTimeChart').getContext('2d');
    const ctx4 = document.getElementById('dispatchChart').getContext('2d');

    charts.requests = new Chart(ctx1, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Requests',
                data: [],
                borderColor: '#007bff',
                backgroundColor: 'rgba(0,123,255,0.1)',
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true }
            }
        }
    });

    charts.errorRate = new Chart(ctx2, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Error Rate (%)',
                data: [],
                borderColor: '#dc3545',
                backgroundColor: 'rgba(220,53,69,0.1)',
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true, max: 100 }
            }
        }
    });

    charts.responseTime = new Chart(ctx3, {
        type: 'bar',
        data: {
            labels: ['< 100ms', '100-500ms', '500ms-2s', '2s-5s', '> 5s'],
            datasets: [{
                label: 'Response Time Distribution',
                data: [0, 0, 0, 0, 0],
                backgroundColor: ['#28a745', '#ffc107', '#fd7e14', '#dc3545', '#6f42c1']
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true }
            }
        }
    });

    charts.dispatch = new Chart(ctx4, {
        type: 'doughnut',
        data: {
            labels: ['Successful', 'Failed', 'Pending'],
            datasets: [{
                data: [0, 0, 0],
                backgroundColor: ['#28a745', '#dc3545', '#ffc107']
            }]
        },
        options: {
            responsive: true
        }
    });
}

function updateCharts(metrics) {
    const now = new Date().toLocaleTimeString();

    // Update history
    metricsHistory.push({
        time: now,
        requests: metrics.ers_requests_total || 0,
        errors: metrics.ers_errors_total || 0,
        responseTime: metrics.ers_avg_response_time || 0,
        dispatchSuccess: metrics.ers_dispatch_success_total || 0,
        dispatchFailure: metrics.ers_dispatch_failure_total || 0,
        queueDepth: metrics.ers_dispatch_queue_depth || 0
    });

    // Keep only last 20 data points
    if (metricsHistory.length > 20) {
        metricsHistory.shift();
    }

    // Update request chart
    charts.requests.data.labels = metricsHistory.map(m => m.time);
    charts.requests.data.datasets[0].data = metricsHistory.map(m => m.requests);
    charts.requests.update();

    // Update error rate chart
    const totalRequests = metrics.ers_requests_total || 0;
    const errors = metrics.ers_errors_total || 0;
    const errorRate = totalRequests > 0 ? (errors / totalRequests * 100) : 0;

    charts.errorRate.data.labels = metricsHistory.map(m => m.time);
    charts.errorRate.data.datasets[0].data = metricsHistory.map(() => errorRate);
    charts.errorRate.update();

    // Update dispatch chart
    const success = metrics.ers_dispatch_success_total || 0;
    const failure = metrics.ers_dispatch_failure_total || 0;
    const pending = metrics.ers_dispatch_queue_depth || 0;

    charts.dispatch.data.datasets[0].data = [success, failure, pending];
    charts.dispatch.update();
}

async function refreshData() {
    const metrics = await fetchMetrics();
    if (metrics) {
        updateMetricsCards(metrics);
        updateCharts(metrics);
    }
}

// Initialize
initCharts();
refreshData();

// Auto-refresh every 30 seconds
setInterval(refreshData, 30000);
