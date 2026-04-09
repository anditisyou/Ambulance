let refreshInterval;
let socket = null;
let isLoadingEmergencyRequests = false;
const modalFocusRestoreMap = new WeakMap();

function setupModalAccessibility() {
    document.querySelectorAll('.modal').forEach((modalElement) => {
        modalElement.setAttribute('inert', '');

        modalElement.addEventListener('show.bs.modal', () => {
            modalElement.removeAttribute('inert');
        });

        modalElement.addEventListener('hidden.bs.modal', () => {
            modalElement.setAttribute('inert', '');

            if (modalElement.contains(document.activeElement)) {
                document.activeElement.blur();
            }

            const restoreTarget = modalFocusRestoreMap.get(modalElement);
            if (restoreTarget && document.body.contains(restoreTarget)) {
                restoreTarget.focus();
            }
            modalFocusRestoreMap.delete(modalElement);
        });
    });
}

function preserveModalTriggerFocus(modalElement) {
    if (modalElement instanceof HTMLElement) {
        modalFocusRestoreMap.set(modalElement, document.activeElement);
    }
}

const STATUS = {
    PENDING: 'PENDING',
    ASSIGNED: 'ASSIGNED',
    EN_ROUTE: 'EN_ROUTE',
    ACCEPTED: 'ACCEPTED',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED'
};

const ROLES = {
    CITIZEN: 'CITIZEN',
    DRIVER: 'DRIVER',
    HOSPITAL: 'HOSPITAL',
    ADMIN: 'ADMIN',
    DISPATCHER: 'DISPATCHER'
};

// Check authentication
document.addEventListener('DOMContentLoaded', () => {
    const user = apiClient.authState.getUser();
    
    if (!user || user.role !== ROLES.HOSPITAL) {
        window.location.href = '/';
        return;
    }
    
    // Display hospital name
    document.getElementById('hospitalName').textContent = user.name;
    
    // Initialize socket
    initSocket();
    
    // Set up modal accessibility
    setupModalAccessibility();
    
    // Load emergency requests and hospital capacity
    loadEmergencyRequests();
    loadHospitalProfile();
    
    // Set up auto-refresh every 30 seconds
    refreshInterval = setInterval(() => {
      loadEmergencyRequests();
      loadHospitalProfile();
    }, 30000);

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if (typeof logout === 'function') {
                logout();
            } else {
                window.location.href = '/';
            }
        });
    }

    const emergencyTableBody = document.getElementById('emergencyTableBody');
    if (emergencyTableBody) {
        emergencyTableBody.addEventListener('click', (event) => {
            const button = event.target.closest('button');
            if (!button) {
                return;
            }

            if (button.matches('.btn-view-history')) {
                const userId = button.dataset.userId;
                if (userId) {
                    viewMedicalHistory(userId);
                }
            }

            if (button.matches('.btn-accept-request')) {
                const requestId = button.dataset.requestId;
                if (requestId) {
                    acceptRequest(requestId);
                }
            }
        });
    }
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
    if (socket) {
        socket.disconnect();
    }
});

// Initialize Socket.IO
function initSocket() {
    const token = apiClient.authState.getToken();
    socket = io({
        transports: ['polling', 'websocket'],
        auth: { token },
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
    });
    const user = apiClient.authState.getUser();
    
    socket.on('connect', () => {
        console.log('Socket connected');
        socket.emit('join', { userId: user.id, role: ROLES.HOSPITAL });
    });
    
    socket.on('newEmergencyRequest', () => {
        loadEmergencyRequests();
        showNotification('New emergency request received!', 'info');
    });

    socket.on('hospitalCapacityUpdate', (data) => {
        if (!data) return;
        const statusEl = document.getElementById('hospitalCapacityStatus');
        if (statusEl) {
            statusEl.textContent = data.capacityStatus || statusEl.textContent;
        }
        showNotification('Bed capacity updated.', 'info');
        loadHospitalProfile();
    });
}

// Load emergency requests
async function loadEmergencyRequests() {
    if (isLoadingEmergencyRequests) {
        return;
    }

    isLoadingEmergencyRequests = true;
    try {
        const data = await apiClient.request('/api/emergency');
        
        if (data.success) {
            displayEmergencyRequests(data.data);
            updateStatistics(data.data);
        }
    } catch (error) {
        console.error('Error loading emergency requests:', error);
    } finally {
        isLoadingEmergencyRequests = false;
    }
}

// Display emergency requests in table
function displayEmergencyRequests(requests) {
    const tbody = document.getElementById('emergencyTableBody');
    
    if (!requests || requests.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center">No emergency requests found</td></tr>';
        return;
    }
    
    let html = '';
    requests.forEach(request => {
        const time = new Date(request.requestTime || request.createdAt).toLocaleString();
        const coords = request.location && request.location.coordinates ? request.location.coordinates : [0,0];
        const location = `Lat: ${coords[1].toFixed(4)}, Lng: ${coords[0].toFixed(4)}`;
        const userId = request.userId && request.userId._id ? request.userId._id : request.userId;
        
        html += `
            <tr>
                <td>${time}</td>
                <td>${request.userName}</td>
                <td>${request.userPhone}</td>
                <td>${location}</td>
                <td><span class="badge bg-${getPriorityBadge(request.priority)}">${request.priority || 'MEDIUM'}</span></td>
                <td><span class="badge bg-${getStatusBadge(request.status)}">${request.status}</span></td>
                <td>
                    <button class="btn btn-sm btn-info btn-view-history" data-user-id="${userId}">
                        View History
                    </button>
                </td>
                <td>
                    ${request.status === 'PENDING' ? 
                        `<button class="btn btn-sm btn-success btn-accept-request" data-request-id="${request._id}">Accept</button>` : 
                        request.status === 'ASSIGNED' ? 'Assigned' :
                        request.status === 'EN_ROUTE' ? 'En Route' : 
                        request.status === 'COMPLETED' ? 'Completed' : 'N/A'}
                </td>
            </tr>
        `;
    });
    
    tbody.innerHTML = html;
}

function getPriorityBadge(priority) {
    switch(priority) {
        case 'CRITICAL': return 'danger';
        case 'HIGH': return 'warning';
        case 'MEDIUM': return 'info';
        case 'LOW': return 'secondary';
        default: return 'secondary';
    }
}

function getStatusBadge(status) {
    switch(status) {
        case 'PENDING': return 'warning';
        case 'ASSIGNED': return 'info';
        case 'EN_ROUTE': return 'primary';
        case 'COMPLETED': return 'success';
        case 'CANCELLED': return 'danger';
        default: return 'secondary';
    }
}

// Update statistics
function updateStatistics(requests) {
    const pending = requests.filter(r => r.status === 'PENDING').length;
    const assigned = requests.filter(r => r.status === 'ASSIGNED' || r.status === 'EN_ROUTE').length;
    const completed = requests.filter(r => r.status === 'COMPLETED').length;
    
    document.getElementById('pendingCount').textContent = pending;
    document.getElementById('acceptedCount').textContent = assigned;
    document.getElementById('completedCount').textContent = completed;
}

async function loadHospitalProfile() {
    try {
        const data = await apiClient.get('/api/hospitals/me');
        if (!data.success || !data.data) return;

        const profile = data.data;
        const statusEl = document.getElementById('hospitalCapacityStatus');
        if (statusEl) {
            statusEl.textContent = `${profile.capacityStatus} — ${profile.beds.reduce((sum, bed) => sum + bed.available, 0)} available`;
        }

        const bedFields = document.getElementById('bedFieldsContainer');
        if (bedFields) {
            bedFields.innerHTML = profile.beds.map((bed, index) => `
                <div class="mb-3 border-bottom pb-3">
                    <label class="form-label">${bed.type} beds</label>
                    <div class="row gx-2">
                        <div class="col-6">
                            <input type="number" class="form-control" name="beds[${index}][total]" value="${bed.total}" placeholder="Total">
                        </div>
                        <div class="col-6">
                            <input type="number" class="form-control" name="beds[${index}][available]" value="${bed.available}" placeholder="Available">
                        </div>
                    </div>
                    <input type="hidden" name="beds[${index}][type]" value="${bed.type}">
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Error loading hospital profile:', error);
    }
}

function showBedUpdateModal() {
    const modalElement = document.getElementById('bedUpdateModal');
    if (!modalElement) return;
    if (window.bootstrap && typeof window.bootstrap.Modal === 'function') {
        const modal = new window.bootstrap.Modal(modalElement);
        modal.show();
        return;
    }
    if (window.jQuery) {
        window.jQuery('#bedUpdateModal').modal('show');
    }
}

async function submitBedUpdate(event) {
    event.preventDefault();

    const form = event.target;
    const inputs = Array.from(form.querySelectorAll('input[name^="beds"]'));
    const bedsByIndex = {};

    inputs.forEach((input) => {
        const match = input.name.match(/beds\[(\d+)\]\[(\w+)\]/);
        if (!match) return;
        const index = match[1];
        const key = match[2];
        bedsByIndex[index] = bedsByIndex[index] || {};
        bedsByIndex[index][key] = input.value;
    });

    const beds = Object.values(bedsByIndex).map((bed) => ({
        type: bed.type,
        total: Number(bed.total) || 0,
        available: Number(bed.available) || 0,
    }));

    try {
        const response = await apiClient.put('/api/hospitals/beds', { beds });
        if (response.success) {
            showNotification('Bed capacity updated successfully.', 'success');
            loadHospitalProfile();
            const modalElement = document.getElementById('bedUpdateModal');
            if (modalElement && window.bootstrap && typeof window.bootstrap.Modal === 'function') {
                window.bootstrap.Modal.getInstance(modalElement)?.hide();
            }
        } else {
            showNotification(response.message || 'Unable to update beds.', 'error');
        }
    } catch (error) {
        console.error('Error updating beds:', error);
        showNotification('Unable to update bed capacity.', 'error');
    }
}

// Accept emergency request
async function acceptRequest(requestId) {
    if (!confirm('Are you sure you want to accept this emergency request?')) {
        return;
    }
    
    try {
        const data = await apiClient.request(`/api/emergency/${requestId}/accept`, {
            method: 'PUT'
        });
        
        if (data.success) {
            showNotification('Request accepted successfully', 'success');
            loadEmergencyRequests();
        } else {
            showNotification(data.message, 'error');
        }
    } catch (error) {
        showNotification('Error accepting request', 'error');
    }
}

// View medical history
async function viewMedicalHistory(userId) {
    try {
        const data = await apiClient.request(`/api/medical/user/${userId}`);
        
        if (data.success) {
            displayMedicalHistory(data.data);
            const modalElement = document.getElementById('medicalHistoryModal');
            if (modalElement) {
                preserveModalTriggerFocus(modalElement);
                if (window.jQuery && typeof window.jQuery(modalElement).modal === 'function') {
                    window.jQuery(modalElement).modal('show');
                } else if (window.bootstrap && typeof window.bootstrap.Modal === 'function') {
                    new window.bootstrap.Modal(modalElement).show();
                }
            }
        } else {
            showNotification('Error loading medical history', 'error');
        }
    } catch (error) {
        showNotification('Error loading medical history', 'error');
    }
}

// Display medical history in modal
function displayMedicalHistory(records) {
    const container = document.getElementById('medicalHistoryContent');
    
    if (!records || records.length === 0) {
        container.innerHTML = '<p class="text-muted text-center">No medical records found for this patient.</p>';
        return;
    }
    
    let html = '<div class="list-group">';
    records.forEach(record => {
        const date = new Date(record.createdAt).toLocaleDateString();
        html += `
            <div class="list-group-item">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <h6 class="mb-1">${record.fileName || 'Medical Record'}</h6>
                        <small>Uploaded: ${date}</small>
                        <br><small>Type: ${record.recordType || 'Document'}</small>
                    </div>
                    <a href="${record.fileUrl}" target="_blank" class="btn btn-sm btn-primary">View</a>
                </div>
            </div>
        `;
    });
    html += '</div>';
    
    container.innerHTML = html;
}

function toggleAvailability() {
    const btn = document.getElementById('availabilityBtn');
    const isAvailable = btn.classList.contains('available');
    
    if (isAvailable) {
        btn.innerHTML = '<i class="fas fa-circle me-2"></i>Busy';
        btn.className = 'availability-toggle busy';
        showNotification('Set to busy - you will not receive new requests', 'warning');
    } else {
        btn.innerHTML = '<i class="fas fa-circle me-2"></i>Available';
        btn.className = 'availability-toggle available';
        showNotification('Set to available - you will receive requests', 'success');
    }
}

function refreshRequests() {
    loadEmergencyRequests();
    showNotification('Refreshing requests...', 'info');
}

function exportData() {
    showNotification('Exporting data...', 'info');
    // In a real implementation, this would download a CSV/PDF
}

function viewStatistics() {
    showNotification('Opening statistics...', 'info');
    // In a real implementation, this would show detailed statistics
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