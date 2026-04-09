// admin-dashboard.js - Fixed API endpoints
const ROLES = {
    CITIZEN: 'CITIZEN',
    DRIVER: 'DRIVER',
    HOSPITAL: 'HOSPITAL',
    ADMIN: 'ADMIN',
    DISPATCHER: 'DISPATCHER'
};

let statsChart = null;
let responseChart = null;
let socket = null;

document.addEventListener('DOMContentLoaded', () => {
    const user = apiClient.authState.getUser();
    
    if (!user || user.role !== ROLES.ADMIN) {
        window.location.href = '/';
        return;
    }
    
    document.getElementById('adminWelcome').textContent = `Welcome, ${user.name}`;
    
    initSocket();
    
    loadSystemStats();
    loadUsers();
    loadAmbulances();
    loadDispatchQueue();
    loadMetrics();
    initCharts();
    
    setupSearch();
    
    setInterval(() => {
        loadSystemStats();
        loadDispatchQueue();
        loadMetrics();
    }, 30000);
});

function initSocket() {
    if (!window.io) return;

    const token = apiClient.authState.getToken();
    socket = io({ auth: { token } });
    const user = apiClient.authState.getUser();

    socket.on('connect', () => {
        if (!user) return;
        socket.emit('join', { userId: user.id || user._id, role: user.role });
    });

    socket.on('dispatchAllocated', (data) => {
        showNotification('A request has been allocated. Queue updated.', 'success');
        loadDispatchQueue();
        loadSystemStats();
    });

    socket.on('dispatchQueued', (data) => {
        showNotification('A new request has entered the queue.', 'warning');
        loadDispatchQueue();
    });

    socket.on('requestCompleted', (data) => {
        showNotification('A mission has completed successfully.', 'success');
        loadSystemStats();
        loadDispatchQueue();
        loadAmbulances();
    });

    socket.on('ambulanceStatusChanged', () => {
        loadAmbulances();
    });
}

async function loadSystemStats() {
    try {
        const data = await apiClient.request('/api/admin/stats');
        
        if (data.success) {
            document.getElementById('totalUsers').textContent = data.data.totalUsers || 0;
            document.getElementById('activeAmbulances').textContent = data.data.totalAmbulances || 0;
            document.getElementById('completedMissions').textContent = data.data.completedToday || 0;
            const queuedEl = document.getElementById('queuedRequests');
            if (queuedEl) queuedEl.textContent = data.data.pendingRequests || 0;
            const slaEl = document.getElementById('slaBreaches');
            if (slaEl) slaEl.textContent = data.data.slaBreaches || '–';
            const avgRespEl = document.getElementById('avgResponseTime');
            if (avgRespEl) avgRespEl.textContent = data.data.avgResponseTime || 'N/A';
        }
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

async function loadUsers() {
    try {
        const data = await apiClient.request('/api/admin/users?limit=50');
        
        if (data.success) {
            displayUsers(data.data);
        }
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

function displayUsers(users) {
    const tbody = document.getElementById('usersTableBody');
    
    if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center">No users found</td></tr>';
        return;
    }
    
    let html = '';
    users.forEach(user => {
        const joined = new Date(user.createdAt).toLocaleDateString();
        const roleClass = getRoleClass(user.role);
        
        html += `
            <tr>
                <td><strong>${user.name}</strong></td>
                <td>${user.email}</td>
                <td>${user.phone}</td>
                <td><span class="role-badge ${roleClass}">${user.role}</span></td>
                <td><span class="badge bg-${user.isActive ? 'success' : 'danger'}">${user.isActive ? 'Active' : 'Inactive'}</span></td>
                <td>${joined}</td>
                <td>
                    <button class="action-btn view" onclick="viewUser('${user._id}')">View</button>
                    <button class="action-btn edit" onclick="editUserRole('${user._id}', '${user.role}')">Edit Role</button>
                </td>
            </tr>
        `;
    });
    
    tbody.innerHTML = html;
}

async function loadAmbulances() {
    try {
        const data = await apiClient.request('/api/admin/ambulances?limit=50');
        
        if (data.success) {
            displayAmbulances(data.data);
        }
    } catch (error) {
        console.error('Error loading ambulances:', error);
    }
}

async function loadDispatchQueue() {
    try {
        const data = await apiClient.request('/api/admin/dispatch-queue');
        if (data.success) {
            displayDispatchQueue(data.data);
            const queuedEl = document.getElementById('queuedRequests');
            if (queuedEl) queuedEl.textContent = data.count || 0;
        }
    } catch (error) {
        console.error('Error loading dispatch queue:', error);
        const tbody = document.getElementById('dispatchQueueTableBody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center">Unable to load dispatch queue.</td></tr>';
        }
    }
}

function displayDispatchQueue(queue) {
    const tbody = document.getElementById('dispatchQueueTableBody');
    if (!tbody) return;

    if (!queue || queue.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center">No queued requests at the moment.</td></tr>';
        return;
    }

    let html = '';
    queue.forEach(item => {
        const requestedAt = new Date(item.requestTime).toLocaleString();
        const waitMinutes = Math.round(item.waitSeconds / 60);
        const slaBadge = item.slaStatus === 'BREACHED' ? 'danger' : item.slaStatus === 'AT_RISK' ? 'warning' : 'success';
        const locationText = item.location ? `${item.location[1].toFixed(4)}, ${item.location[0].toFixed(4)}` : 'Not set';

        html += `
            <tr>
                <td><strong>${item._id.toString().slice(-6)}</strong><br><small>${requestedAt}</small></td>
                <td>${item.userName}<br><small>${item.userPhone}</small></td>
                <td>${item.priority}</td>
                <td>${waitMinutes} min</td>
                <td><span class="badge bg-${slaBadge}">${item.slaStatus}</span></td>
                <td>${locationText}</td>
                <td>
                    <button class="action-btn view" onclick="window.open('https://www.google.com/maps/search/?api=1&query=${item.location ? item.location[1] : ''},${item.location ? item.location[0] : ''}', '_blank')">View</button>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

function displayAmbulances(ambulances) {
    const tbody = document.getElementById('ambulancesTableBody');
    
    if (!ambulances || ambulances.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center">No ambulances found</td></tr>';
        return;
    }
    
    let html = '';
    ambulances.forEach(amb => {
        const lastActive = new Date(amb.updatedAt).toLocaleString();
        const statusClass = getStatusClass(amb.status);
        const location = amb.currentLocation?.coordinates ? 
            `${amb.currentLocation.coordinates[1].toFixed(4)}, ${amb.currentLocation.coordinates[0].toFixed(4)}` : 
            'Not set';
        
        html += `
            <tr>
                <td><strong>${amb.plateNumber}</strong></td>
                <td>${amb.driverId?.name || 'Not assigned'}</td>
                <td><span class="badge bg-${statusClass}">${amb.status}</span></td>
                <td>${location}</td>
                <td>${amb.currentMission || 'None'}</td>
                <td>${lastActive}</td>
                <td>
                    <button class="action-btn view" onclick="viewAmbulance('${amb._id}')">Track</button>
                    <button class="action-btn edit" onclick="editAmbulance('${amb._id}')">Edit</button>
                </td>
            </tr>
        `;
    });
    
    tbody.innerHTML = html;
}

async function loadMetrics() {
    try {
        const [latencyData, perfData] = await Promise.all([
            apiClient.request('/api/analytics/latency'),
            apiClient.request('/api/analytics/performance?days=30'),
        ]);

        const latencyHtml = latencyData.success ? `
            <div class="col-md-6">
                <h6>Response Metrics</h6>
                <p>Average Response: ${latencyData.data.metrics?.avgResponse?.toFixed(2) || 'N/A'} sec</p>
                <p>Min Response: ${latencyData.data.metrics?.minResponse?.toFixed(2) || 'N/A'} sec</p>
                <p>Max Response: ${latencyData.data.metrics?.maxResponse?.toFixed(2) || 'N/A'} sec</p>
            </div>
            <div class="col-md-6">
                <h6>Completion Metrics</h6>
                <p>Average Completion: ${latencyData.data.metrics?.avgCompletion?.toFixed(2) || 'N/A'} sec</p>
                <p>Total Requests: ${latencyData.data.metrics?.count || 0}</p>
            </div>
            ${latencyData.data.byPriority ? `
            <div class="mt-3">
                <h6>By Priority</h6>
                <pre>${JSON.stringify(latencyData.data.byPriority, null, 2)}</pre>
            </div>
            ` : ''}
        ` : '<div class="col-12 text-danger">Unable to load latency metrics.</div>';

        const performanceHtml = perfData.success ? `
            <div class="row mt-4">
                <div class="col-md-6">
                    <h6>Ambulance Utilization</h6>
                    <p>Available: ${perfData.data.ambulanceUtilization?.AVAILABLE || 0}</p>
                    <p>Assigned: ${perfData.data.ambulanceUtilization?.ASSIGNED || 0}</p>
                    <p>En Route: ${perfData.data.ambulanceUtilization?.ENROUTE || 0}</p>
                </div>
                <div class="col-md-6">
                    <h6>New Users (30 days)</h6>
                    <p>Drivers: ${perfData.data.newUsers?.DRIVER || 0}</p>
                    <p>Citizens: ${perfData.data.newUsers?.CITIZEN || 0}</p>
                    <p>Hospitals: ${perfData.data.newUsers?.HOSPITAL || 0}</p>
                </div>
            </div>
        ` : '<div class="row"><div class="col-12 text-danger">Unable to load performance metrics.</div></div>';

        document.getElementById('metrics').innerHTML = `
            <div class="row">${latencyHtml}</div>
            ${performanceHtml}
        `;
    } catch (error) {
        console.error('Error loading metrics:', error);
        document.getElementById('metrics').innerHTML = '<div class="text-center text-muted">Unable to load metrics</div>';
    }
}

function setupSearch() {
    const userSearch = document.getElementById('userSearch');
    if (userSearch) {
        userSearch.addEventListener('input', function(e) {
            const searchTerm = e.target.value.toLowerCase();
            const rows = document.querySelectorAll('#usersTableBody tr');
            
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(searchTerm) ? '' : 'none';
            });
        });
    }
    
    const ambulanceSearch = document.getElementById('ambulanceSearch');
    if (ambulanceSearch) {
        ambulanceSearch.addEventListener('input', function(e) {
            const searchTerm = e.target.value.toLowerCase();
            const rows = document.querySelectorAll('#ambulancesTableBody tr');
            
            rows.forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(searchTerm) ? '' : 'none';
            });
        });
    }
}

function getRoleClass(role) {
    switch(role) {
        case 'ADMIN': return 'admin';
        case 'HOSPITAL': return 'hospital';
        case 'DRIVER': return 'driver';
        default: return 'citizen';
    }
}

function getStatusClass(status) {
    switch(status) {
        case 'AVAILABLE': return 'success';
        case 'ASSIGNED': return 'warning';
        case 'EN_ROUTE': return 'info';
        case 'ENROUTE': return 'info';
        case 'MAINTENANCE': return 'danger';
        default: return 'secondary';
    }
}

function viewUser(userId) {
    showNotification(`Viewing user: ${userId}`, 'info');
}

async function editUserRole(userId, currentRole) {
    const newRole = prompt(`Enter new role for user (ADMIN, DISPATCHER, HOSPITAL, DRIVER, CITIZEN):`, currentRole);
    
    if (!newRole || newRole === currentRole) return;
    
    try {
        const data = await apiClient.request(`/api/admin/users/${userId}/role`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ role: newRole.toUpperCase() })
        });
        
        if (data.success) {
            showNotification('Role updated successfully', 'success');
            loadUsers();
        } else {
            showNotification(data.message, 'error');
        }
    } catch (error) {
        showNotification('Error updating role', 'error');
    }
}

function viewAmbulance(ambulanceId) {
    showNotification(`Tracking ambulance: ${ambulanceId}`, 'info');
}

function editAmbulance(ambulanceId) {
    showNotification(`Editing ambulance: ${ambulanceId}`, 'info');
}

function showNotification(message, type) {
    const notification = document.createElement('div');
    notification.className = `alert alert-${type} position-fixed top-0 end-0 m-3`;
    notification.style.zIndex = '9999';
    notification.style.minWidth = '300px';
    notification.innerHTML = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 3000);
}

function initCharts() {
    const ctx1 = document.getElementById('requestsChart');
    if (ctx1) {
        new Chart(ctx1, {
            type: 'line',
            data: {
                labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                datasets: [{
                    label: 'Emergency Requests',
                    data: [65, 59, 80, 81, 56, 55, 40],
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37, 99, 235, 0.1)',
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                }
            }
        });
    }

    const ctx2 = document.getElementById('responseTimeChart');
    if (ctx2) {
        new Chart(ctx2, {
            type: 'bar',
            data: {
                labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                datasets: [{
                    label: 'Response Time',
                    data: [7.1, 6.8, 7.3, 7.0, 6.9, 6.5, 7.2],
                    backgroundColor: '#14b8a6'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                }
            }
        });
    }
}