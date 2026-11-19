let refreshInterval;
let socket = null;
let isLoadingEmergencyRequests = false;
let hospitalProfile = null;
const modalFocusRestoreMap = new WeakMap();

function csrfHeaders() {
    const token = apiClient.authState.getCsrfToken?.();
    return token ? { 'X-CSRF-Token': token } : {};
}

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
    loadTrackingData();
    
    // Socket.IO is primary; polling keeps the operational queue current if a
    // real-time connection is interrupted.
    refreshInterval = setInterval(() => {
      loadEmergencyRequests();
      loadHospitalProfile();
      loadTrackingData();
    }, 5000);

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

    // Global action handler
    document.addEventListener('click', (event) => {
        const actionElement = event.target.closest('[data-action]');
        if (actionElement?.tagName?.toLowerCase() === 'form') {
            return;
        }

        const action = actionElement?.dataset.action;
        if (!action) return;

        event.preventDefault();

        switch (action) {
            case 'refreshRequests':
                refreshRequests();
                break;
            case 'viewStatistics':
                viewStatistics();
                break;
            case 'exportData':
                exportData();
                break;
            case 'refreshTracking':
                refreshTracking();
                break;
            case 'toggleAvailability':
                toggleAvailability();
                break;
            case 'showBedUpdateModal':
                showBedUpdateModal();
                break;
            case 'useCurrentLocationForProfile':
                useCurrentLocationForProfile(event);
                break;
            case 'addBedCategory':
                addBedCategory(event);
                break;
            default:
                console.warn('Unknown action:', action);
        }
    });

    document.addEventListener('submit', (event) => {
        const form = event.target.closest('form[data-action]');
        if (!form) return;

        switch (form.dataset.action) {
            case 'submitHospitalProfile':
                submitHospitalProfile(event);
                break;
            case 'submitBedUpdate':
                submitBedUpdate(event);
                break;
            default:
                console.warn('Unknown form action:', form.dataset.action);
        }
    });

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

            if (button.matches('.btn-live-map')) {
                openLiveMap(button.dataset.requestId, button.dataset.patientLat, button.dataset.patientLng, button.dataset.driverLat, button.dataset.driverLng);
            }

            if (button.matches('.btn-delete-bed')) {
                const type = button.dataset.bedType;
                if (type) {
                    deleteBedCategory(type);
                }
            }
        });
    }

    const bedFieldsContainer = document.getElementById('bedFieldsContainer');
    if (bedFieldsContainer) {
        bedFieldsContainer.addEventListener('click', (event) => {
            const button = event.target.closest('.btn-delete-bed');
            if (!button) return;
            const type = button.dataset.bedType;
            if (type) {
                deleteBedCategory(type);
            }
        });
    }

    const incomingAmbulances = document.getElementById('incomingAmbulances');
    if (incomingAmbulances) {
        incomingAmbulances.addEventListener('click', (event) => {
            const button = event.target.closest('.prepare-bed-btn');
            if (!button) return;
            prepareBed(button.dataset.requestId, button.dataset.patientName || 'this patient');
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
    socket = io({
        transports: ['polling', 'websocket'],
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

    socket.on('statusUpdate', () => loadEmergencyRequests());
    socket.on('requestCompleted', () => loadEmergencyRequests());
    socket.on('ambulanceLocationUpdate', (data) => updateLiveMap(data));
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
            if (socket?.connected) {
                data.data.forEach((request) => socket.emit('join', { requestId: request._id }));
            }
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
        const requestDate = new Date(request.requestTime || request.createdAt);
        const time = Number.isNaN(requestDate.getTime()) ? 'Unknown' : requestDate.toLocaleString();
        const coords = request.location && request.location.coordinates ? request.location.coordinates : [0,0];
        const location = `Lat: ${safeNumber(coords[1]).toFixed(4)}, Lng: ${safeNumber(coords[0]).toFixed(4)}`;
        const userId = request.userId && request.userId._id ? request.userId._id : request.userId;
        const priority = request.priority || 'MEDIUM';
        const status = request.status || 'PENDING';
        const driverCoords = request.assignedAmbulanceId?.currentLocation?.coordinates || [];
        
        html += `
            <tr>
                <td>${escapeHtml(time)}</td>
                <td>${escapeHtml(request.userName || 'Unknown patient')}</td>
                <td>${escapeHtml(request.userPhone || 'Not provided')}</td>
                <td>${escapeHtml(location)}</td>
                <td><span class="badge bg-${getPriorityBadge(priority)}">${escapeHtml(priority)}</span></td>
                <td><span class="badge bg-${getStatusBadge(status)}">${escapeHtml(status)}</span></td>
                <td>
                    <button type="button" class="btn btn-sm btn-info btn-view-history" data-user-id="${escapeHtml(userId)}">
                        View History
                    </button>
                </td>
                <td>
                    ${['ASSIGNED', 'ACCEPTED', 'EN_ROUTE'].includes(status) ?
                        `<button type="button" class="btn btn-sm btn-outline-primary btn-live-map" data-request-id="${escapeHtml(request._id)}" data-patient-lat="${safeNumber(coords[1])}" data-patient-lng="${safeNumber(coords[0])}" data-driver-lat="${safeNumber(driverCoords[1])}" data-driver-lng="${safeNumber(driverCoords[0])}">Live Map</button> ` : ''}
                    ${status === 'PENDING' ? 
                        `<button type="button" class="btn btn-sm btn-success btn-accept-request" data-request-id="${escapeHtml(request._id)}">Accept</button>` : 
                        status === 'ASSIGNED' ? 'Assigned' :
                        status === 'EN_ROUTE' ? 'En Route' : 
                        status === 'COMPLETED' ? 'Completed' : 'N/A'}
                </td>
            </tr>
        `;
    });
    
    tbody.innerHTML = html;
}

let activeMapRequestId = null;
function openLiveMap(requestId, patientLat, patientLng, driverLat, driverLng) {
    activeMapRequestId = requestId;
    const patient = `${Number(patientLat)},${Number(patientLng)}`;
    const driver = Number(driverLat) && Number(driverLng) ? `${Number(driverLat)},${Number(driverLng)}` : patient;
    const src = `https://www.google.com/maps?output=embed&f=d&saddr=${encodeURIComponent(driver)}&daddr=${encodeURIComponent(patient)}`;
    let frame = document.getElementById('liveMapFrame');
    if (!frame) {
        document.body.insertAdjacentHTML('beforeend', `<div class="modal fade" id="liveMapModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-lg modal-dialog-centered"><div class="modal-content"><div class="modal-header"><h5 class="modal-title">Live Ambulance and Patient Location</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body p-0"><iframe id="liveMapFrame" title="Live ambulance route" style="width:100%;height:460px;border:0" loading="lazy"></iframe></div></div></div></div>`);
        frame = document.getElementById('liveMapFrame');
    }
    frame.src = src;
    bootstrap.Modal.getOrCreateInstance(document.getElementById('liveMapModal')).show();
}

function updateLiveMap(data) {
    if (!data?.requestId || String(data.requestId) !== String(activeMapRequestId)) return;
    const frame = document.getElementById('liveMapFrame');
    if (!frame) return;
    const current = new URL(frame.src);
    const destination = current.searchParams.get('daddr');
    const [lng, lat] = data.coordinates || [];
    if (lat == null || lng == null || !destination) return;
    current.searchParams.set('saddr', `${lat},${lng}`);
    frame.src = current.toString();
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

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (char) => {
        switch (char) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return char;
        }
    });
}

function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function getAuthToken() {
    return null;
}

function getAvailableBedTypes() {
    const beds = Array.isArray(hospitalProfile?.beds) ? hospitalProfile.beds : [];
    return beds.filter((bed) => Number(bed.available) > 0);
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
        hospitalProfile = profile;
        const beds = Array.isArray(profile.beds) ? profile.beds : [];
        profile.beds = beds;
        document.getElementById('hospitalName').textContent = profile.name || apiClient.authState.getUser()?.name || 'Hospital';
        const statusEl = document.getElementById('hospitalCapacityStatus');
        if (statusEl) {
            statusEl.textContent = `${profile.capacityStatus || 'UNKNOWN'} - ${profile.beds.reduce((sum, bed) => sum + safeNumber(bed.available), 0)} available`;
        }

        const bedFields = document.getElementById('bedFieldsContainer');
        if (bedFields) {
            bedFields.innerHTML = beds.length ? beds.map((bed, index) => `
                <div class="mb-3 border-bottom pb-3">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <label class="form-label mb-0">${escapeHtml(bed.type)} beds</label>
                        <button type="button" class="btn btn-sm btn-outline-danger btn-delete-bed" data-bed-type="${escapeHtml(bed.type)}">
                            Delete
                        </button>
                    </div>
                    <div class="row gx-2">
                        <div class="col-6">
                            <input type="number" class="form-control" name="beds[${index}][total]" value="${safeNumber(bed.total)}" min="0" placeholder="Total">
                        </div>
                        <div class="col-6">
                            <input type="number" class="form-control" name="beds[${index}][available]" value="${safeNumber(bed.available)}" min="0" placeholder="Available">
                        </div>
                    </div>
                    <input type="hidden" name="beds[${index}][type]" value="${escapeHtml(bed.type)}">
                </div>
            `).join('') : '<p class="text-muted mb-3">No bed categories added yet.</p>';
        }
    } catch (error) {
        console.error('Error loading hospital profile:', error);
        if (error.status === 404) {
            openHospitalProfileModal();
        }
    }
}

function openHospitalProfileModal() {
    const user = apiClient.authState.getUser();
    const nameInput = document.getElementById('profileHospitalName');
    const phoneInput = document.getElementById('profileHospitalPhone');
    const emailInput = document.getElementById('profileHospitalEmail');

    if (nameInput && !nameInput.value) nameInput.value = user?.name || '';
    if (phoneInput && !phoneInput.value) phoneInput.value = user?.phone || '';
    if (emailInput && !emailInput.value) emailInput.value = user?.email || '';

    const modalElement = document.getElementById('hospitalProfileModal');
    if (modalElement && window.bootstrap && typeof window.bootstrap.Modal === 'function') {
        modalElement.removeAttribute('inert');
        window.bootstrap.Modal.getOrCreateInstance(modalElement, {
            backdrop: 'static',
            keyboard: false,
        }).show();
    }
}

function useCurrentLocationForProfile(event) {
    if (event) event.preventDefault();
    if (!navigator.geolocation) {
        showNotification('Location services are not supported by this browser.', 'warning');
        return;
    }

    navigator.geolocation.getCurrentPosition((position) => {
        document.getElementById('profileLatitude').value = position.coords.latitude;
        document.getElementById('profileLongitude').value = position.coords.longitude;
        showNotification('Hospital location filled from current position.', 'success');
    }, (error) => {
        showNotification(error.message || 'Unable to read current location.', 'warning');
    });
}

async function submitHospitalProfile(event) {
    event.preventDefault();

    const latitude = Number(document.getElementById('profileLatitude')?.value);
    const longitude = Number(document.getElementById('profileLongitude')?.value);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        showNotification('Enter valid hospital latitude and longitude.', 'warning');
        return;
    }

    const specialties = (document.getElementById('profileSpecialties')?.value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

    const payload = {
        name: document.getElementById('profileHospitalName')?.value?.trim(),
        phone: document.getElementById('profileHospitalPhone')?.value?.trim(),
        email: document.getElementById('profileHospitalEmail')?.value?.trim(),
        address: {
            street: document.getElementById('profileStreet')?.value?.trim() || '',
            city: document.getElementById('profileCity')?.value?.trim() || '',
            state: document.getElementById('profileState')?.value?.trim() || '',
            zipCode: document.getElementById('profileZip')?.value?.trim() || '',
        },
        location: {
            type: 'Point',
            coordinates: [longitude, latitude],
        },
        specialties,
        beds: [],
    };

    try {
        const response = await apiClient.post('/api/hospitals', payload);
        if (response.success) {
            showNotification('Hospital profile saved. Add bed capacity next.', 'success');
            hospitalProfile = response.data;
            const modalElement = document.getElementById('hospitalProfileModal');
            if (modalElement && window.bootstrap && typeof window.bootstrap.Modal === 'function') {
                window.bootstrap.Modal.getInstance(modalElement)?.hide();
            }
            await loadHospitalProfile();
            showBedUpdateModal();
        }
    } catch (error) {
        showNotification(error.message || 'Unable to save hospital profile.', 'error');
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

    if (!beds.length) {
        showNotification('Add at least one bed category before saving.', 'warning');
        return;
    }

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

async function addBedCategory(event) {
    if (event) event.preventDefault();

    const type = document.getElementById('newBedType')?.value;
    const total = Number(document.getElementById('newBedTotal')?.value);
    const available = Number(document.getElementById('newBedAvailable')?.value);

    if (!type || !Number.isInteger(total) || total < 0 || !Number.isInteger(available) || available < 0) {
        showNotification('Enter valid total and available bed counts.', 'warning');
        return;
    }

    if (available > total) {
        showNotification('Available beds cannot exceed total beds.', 'warning');
        return;
    }

    try {
        const response = await apiClient.post('/api/hospitals/beds', { type, total, available });
        if (response.success) {
            showNotification(`${type} beds added successfully.`, 'success');
            document.getElementById('newBedTotal').value = '';
            document.getElementById('newBedAvailable').value = '';
            loadHospitalProfile();
        } else {
            showNotification(response.message || 'Unable to add bed category.', 'error');
        }
    } catch (error) {
        const message = error.status === 409
            ? `${type} beds already exist. Update the existing row instead.`
            : error.message || 'Unable to add bed category.';
        showNotification(message, 'error');
    }
}

async function deleteBedCategory(type) {
    if (!confirm(`Delete ${type} bed category?`)) return;

    try {
        const response = await apiClient.delete(`/api/hospitals/beds/${encodeURIComponent(type)}`);
        if (response.success) {
            showNotification(`${type} beds deleted.`, 'success');
            loadHospitalProfile();
        }
    } catch (error) {
        showNotification(error.message || 'Unable to delete bed category.', 'error');
    }
}

// Accept emergency request
async function acceptRequest(requestId) {
    const availableBeds = getAvailableBedTypes();
    if (!availableBeds.length) {
        showNotification('No beds are available. Update bed capacity before accepting.', 'warning');
        showBedUpdateModal();
        return;
    }

    const defaultBed = availableBeds.find((bed) => bed.type === 'EMERGENCY') || availableBeds[0];
    const bedType = prompt(
        `Bed type to reserve: ${availableBeds.map((bed) => `${bed.type} (${bed.available})`).join(', ')}`,
        defaultBed.type
    );

    if (!bedType) return;
    
    try {
        const data = await apiClient.request(`/api/emergency/${requestId}/accept`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ bedType: bedType.toUpperCase() })
        });
        
        if (data.success) {
            showNotification(`Request accepted and ${data.data.assignedBedType || bedType.toUpperCase()} bed reserved.`, 'success');
            loadEmergencyRequests();
            loadHospitalProfile();
        } else {
            showNotification(data.message, 'error');
        }
    } catch (error) {
        showNotification(error.message || 'Error accepting request', 'error');
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
        const createdAt = new Date(record.createdAt);
        const date = Number.isNaN(createdAt.getTime()) ? 'Unknown' : createdAt.toLocaleDateString();
        const recordUrl = record.viewUrl || record.fileUrl || '#';
        html += `
            <div class="list-group-item">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <h6 class="mb-1">${escapeHtml(record.fileName || 'Medical Record')}</h6>
                        <small>Uploaded: ${escapeHtml(date)}</small>
                        <br><small>Type: ${escapeHtml(record.recordType || 'Document')}</small>
                    </div>
                    <a href="${escapeHtml(recordUrl)}" target="_blank" rel="noopener" class="btn btn-sm btn-primary">View</a>
                </div>
            </div>
        `;
    });
    html += '</div>';
    
    container.innerHTML = html;
}

function toggleAvailability() {
    const btn = document.getElementById('availabilityBtn');
    if (!btn) return;

    // Call backend to toggle availability
    fetch('/api/hospitals/availability', {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            ...csrfHeaders(),
        },
        credentials: 'include',
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            const isAvailable = data.data.isAvailable;
            btn.innerHTML = isAvailable ? 
                '<i class="fas fa-circle me-2"></i>Available' : 
                '<i class="fas fa-circle me-2"></i>Busy';
            btn.className = isAvailable ? 'availability-toggle available' : 'availability-toggle busy';
            showNotification(isAvailable ? 'Set to available' : 'Set to busy', 'success');
        } else {
            showNotification('Failed to update availability', 'danger');
        }
    })
    .catch(error => {
        console.error('Error toggling availability:', error);
        showNotification('Network error', 'danger');
    });
}

function refreshRequests() {
    loadEmergencyRequests();
    showNotification('Refreshing requests...', 'info');
}

function exportData() {
    // Trigger download of hospital data
    const link = document.createElement('a');
    link.href = `/api/hospitals/export?format=json`;
    link.download = 'hospital-data.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showNotification('Data exported successfully', 'success');
}

function viewStatistics() {
    fetch('/api/hospitals/statistics', {
        credentials: 'include',
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showStatisticsModal(data.data);
        } else {
            showNotification('Failed to load statistics', 'danger');
        }
    })
    .catch(error => {
        console.error('Error loading statistics:', error);
        showNotification('Network error', 'danger');
    });
}

function showStatisticsModal(stats) {
    const hospital = stats.hospital || {};
    const requests = stats.requests || {};
    const beds = Array.isArray(stats.beds) ? stats.beds : [];
    const modalHtml = `
        <div class="modal fade" id="statisticsModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Hospital Statistics - ${escapeHtml(hospital.name || 'Hospital')}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="row">
                            <div class="col-md-6">
                                <h6>Hospital Info</h6>
                                <p><strong>Status:</strong> ${escapeHtml(hospital.capacityStatus || 'Unknown')}</p>
                                <p><strong>Available:</strong> ${hospital.isAvailable ? 'Yes' : 'No'}</p>
                                <p><strong>Total Beds:</strong> ${safeNumber(hospital.totalBeds)}</p>
                                <p><strong>Available Beds:</strong> ${safeNumber(hospital.availableBeds)}</p>
                            </div>
                            <div class="col-md-6">
                                <h6>Request Statistics</h6>
                                <p><strong>Total Requests:</strong> ${safeNumber(requests.total)}</p>
                                <p><strong>Completed:</strong> ${safeNumber(requests.completed)}</p>
                                <p><strong>Cancelled:</strong> ${safeNumber(requests.cancelled)}</p>
                                <p><strong>Active:</strong> ${safeNumber(requests.active)}</p>
                            </div>
                        </div>
                        <h6 class="mt-3">Bed Details</h6>
                        <table class="table table-sm">
                            <thead>
                                <tr>
                                    <th>Type</th>
                                    <th>Total</th>
                                    <th>Available</th>
                                    <th>Occupied</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${beds.map(bed => `
                                    <tr>
                                        <td>${escapeHtml(bed.type || 'UNKNOWN')}</td>
                                        <td>${safeNumber(bed.total)}</td>
                                        <td>${safeNumber(bed.available)}</td>
                                        <td>${Math.max(safeNumber(bed.total) - safeNumber(bed.available), 0)}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = new bootstrap.Modal(document.getElementById('statisticsModal'));
    modal.show();
    document.getElementById('statisticsModal').addEventListener('hidden.bs.modal', () => {
        document.getElementById('statisticsModal').remove();
    });
}

async function loadTrackingData() {
    try {
        const response = await fetch('/api/hospital-tracking/tracking-dashboard', {
            credentials: 'include',
        });
        const data = await response.json();
        
        if (data.dashboard) {
            updateTrackingStats(data.dashboard);
            updateAmbulanceList(data.dashboard.ambulancesByPriority);
        }
    } catch (error) {
        console.error('Failed to load tracking data:', error);
    }
}

function updateTrackingStats(dashboard) {
    const statsContainer = document.getElementById('trackingStats');
    if (!statsContainer) return;
    const statistics = dashboard.statistics || {};
    statsContainer.innerHTML = `
        <div class="tracking-stat">
            <div class="stat-number">${safeNumber(dashboard.totalIncoming)}</div>
            <div class="stat-label">Incoming Ambulances</div>
        </div>
        <div class="tracking-stat">
            <div class="stat-number">${safeNumber(statistics.withActiveLocation)}</div>
            <div class="stat-label">With Location</div>
        </div>
        <div class="tracking-stat">
            <div class="stat-number">${safeNumber(statistics.averageETA)}</div>
            <div class="stat-label">Avg ETA (min)</div>
        </div>
        <div class="tracking-stat">
            <div class="stat-number">${safeNumber(statistics.criticalCount)}</div>
            <div class="stat-label">Critical Priority</div>
        </div>
    `;
}

function updateAmbulanceList(ambulancesByPriority) {
    const container = document.getElementById('incomingAmbulances');
    if (!container) return;
    let html = '';
    
    const priorities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    
    priorities.forEach(priority => {
        const ambulances = ambulancesByPriority?.[priority] || [];
        ambulances.forEach(ambulance => {
            const patientName = ambulance.patientName || 'Unknown patient';
            html += `
                <div class="ambulance-item">
                    <div class="ambulance-header">
                        <span class="ambulance-call-sign">${escapeHtml(ambulance.ambulanceCallSign || 'Ambulance')}</span>
                        <span class="ambulance-priority priority-${priority.toLowerCase()}">${priority}</span>
                    </div>
                    <div class="ambulance-details">
                        <div class="detail-item">
                            <span class="detail-label">Patient:</span> ${escapeHtml(patientName)}
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">ETA:</span> ${ambulance.etaMinutes ? `${safeNumber(ambulance.etaMinutes)} min` : 'Unknown'}
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Type:</span> ${escapeHtml(ambulance.type || 'Emergency')}
                        </div>
                        <div class="detail-item">
                            <span class="detail-label">Status:</span> ${escapeHtml(ambulance.status || 'Unknown')}
                        </div>
                    </div>
                    <button type="button" class="prepare-bed-btn" data-request-id="${escapeHtml(ambulance.requestId)}" data-patient-name="${escapeHtml(patientName)}">
                        <i class="fas fa-bed me-1"></i>Prepare Bed
                    </button>
                </div>
            `;
        });
    });
    
    if (!html) {
        html = '<p class="text-center text-muted py-4">No incoming ambulances at this time.</p>';
    }
    
    container.innerHTML = html;
}

async function prepareBed(requestId, patientName) {
    if (!requestId) {
        showNotification('Missing request id for bed preparation.', 'warning');
        return;
    }

    const bedType = prompt(`Prepare bed for ${patientName}. Enter bed type (ICU, EMERGENCY, GENERAL, PEDIATRIC, BURN):`);
    if (!bedType) return;
    
    const status = prompt('Enter preparation status (e.g., "Ready", "Cleaning", "Occupied"):');
    if (!status) return;
    
    try {
        const response = await fetch('/api/hospital-tracking/prepare-bed', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...csrfHeaders(),
            },
            credentials: 'include',
            body: JSON.stringify({ requestId, bedType: bedType.toUpperCase(), status })
        });
        
        if (response.ok) {
            showNotification(`Bed preparation updated for ${patientName}`, 'success');
            loadTrackingData(); // Refresh the list
        } else {
            const error = await response.json();
            showNotification(`Failed to prepare bed: ${error.error}`, 'danger');
        }
    } catch (error) {
        showNotification('Network error while preparing bed', 'danger');
    }
}

function refreshTracking() {
    loadTrackingData();
    showNotification('Refreshing tracking data...', 'info');
}

function showNotification(message, type) {
    const notification = document.createElement('div');
    const alertType = type === 'error' ? 'danger' : (type || 'info');
    notification.className = `alert alert-${alertType} position-fixed top-0 end-0 m-3`;
    notification.style.zIndex = '9999';
    notification.style.minWidth = '300px';
    notification.setAttribute('role', 'status');
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 3000);
}
