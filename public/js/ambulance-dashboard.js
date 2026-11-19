// ambulance-dashboard.js - Fixed API endpoints
let refreshInterval;
let socket = null;
let isLoadingActiveMissions = false;
let driverHasAmbulance = false;
let driverCoords = null;
let driverWatchId = null;
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

const ROLES = {
    CITIZEN: 'CITIZEN',
    DRIVER: 'DRIVER',
    HOSPITAL: 'HOSPITAL',
    ADMIN: 'ADMIN',
    DISPATCHER: 'DISPATCHER'
};

const STATUS = {
    PENDING: 'PENDING',
    ASSIGNED: 'ASSIGNED',
    EN_ROUTE: 'EN_ROUTE',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED'
};

function normalizeAmbulanceStatus(status) {
    if (typeof status !== 'string') return status;
    const normalized = status.trim().toUpperCase();
    if (normalized === 'ENROUTE' || normalized === 'ENROUT') {
        return STATUS.EN_ROUTE;
    }
    return normalized;
}

function getCurrentUserId() {
    const user = apiClient.authState.getUser();
    return user?.id || user?._id;
}

function setAmbulanceStatusDisplay(status, hasAmbulance = true) {
    const statusEl = document.getElementById('ambulanceStatus');
    const statusBtn = document.getElementById('statusToggle');
    const registerBtn = document.getElementById('registerAmbulanceBtn');
    const updateBtn = document.getElementById('updateLocationBtn');

    driverHasAmbulance = hasAmbulance;

    const normalizedStatus = normalizeAmbulanceStatus(status);
    if (statusEl) {
        statusEl.textContent = hasAmbulance ? normalizedStatus : 'Not registered';
    }

    if (statusBtn) {
        statusBtn.style.display = hasAmbulance ? 'inline-block' : 'none';
        if (hasAmbulance) {
            if (normalizedStatus === 'AVAILABLE') {
                statusBtn.textContent = 'Set Maintenance';
            } else if (normalizedStatus === 'MAINTENANCE') {
                statusBtn.textContent = 'Set Available';
            } else if (['BUSY', 'EN_ROUTE'].includes(normalizedStatus)) {
                statusBtn.textContent = 'Active Ride';
                statusBtn.disabled = true;
            } else {
                statusBtn.textContent = 'Toggle Status';
            }
            statusBtn.disabled = false;
        }
    }

    if (registerBtn) {
        registerBtn.style.display = hasAmbulance ? 'none' : 'inline-block';
    }

    if (updateBtn) {
        updateBtn.disabled = !hasAmbulance;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const user = apiClient.authState.getUser();
    const userId = getCurrentUserId();
    
    if (!user || user.role !== ROLES.DRIVER) {
        window.location.href = '/';
        return;
    }
    
    document.getElementById('driverName').textContent = user.name;
    
    initSocket();
    setupModalAccessibility();
    
    await loadAmbulanceStatus();
    await loadActiveMissions();
    
    // Retain a short polling fallback when real-time socket delivery is unavailable.
    refreshInterval = setInterval(loadActiveMissions, 5000);

    // Global action handler
    document.addEventListener('click', (event) => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (!action) return;

        event.preventDefault();

        switch (action) {
            case 'refreshRequests':
                loadActiveMissions();
                showNotification('Refreshing requests...', 'info');
                break;
            case 'exportData':
                exportData();
                break;
            case 'viewStatistics':
                viewStatistics();
                break;
            case 'findNearestHospital':
                findNearestHospital();
                break;
            default:
                console.warn('Unknown action:', action);
        }
    });

    const missionsBody = document.getElementById('missionsTableBody') || document.getElementById('emergencyTableBody');
    if (missionsBody) {
        missionsBody.addEventListener('click', (event) => {
            const button = event.target.closest('button');
            if (!button) return;

            if (button.matches('.btn-view-location')) {
                const lat = button.dataset.latitude;
                const lng = button.dataset.longitude;
                if (lat && lng) {
                    viewLocation(parseFloat(lat), parseFloat(lng));
                }
            }

            if (button.matches('.btn-respond-assignment')) {
                const requestId = button.dataset.requestId;
                const accept = button.dataset.accept === 'true';
                if (requestId) {
                    respondToAssignment(requestId, accept);
                }
            }

            if (button.matches('.btn-update-location')) {
                const requestId = button.dataset.requestId;
                if (requestId) {
                    trackMission(requestId);
                }
            }

            if (button.matches('.btn-complete-mission')) {
                const requestId = button.dataset.requestId;
                if (requestId) {
                    completeMission(requestId);
                }
            }
        });
    }

    const searchInput = document.getElementById('searchInput');
    const statusFilter = document.getElementById('statusFilter');

    if (searchInput) {
        searchInput.addEventListener('input', () => filterMissionRows());
    }

    if (statusFilter) {
        statusFilter.addEventListener('change', () => filterMissionRows());
    }
});

window.addEventListener('beforeunload', () => {
    cleanup();
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Pause updates when tab is not visible
        if (refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
        }
    } else {
        // Resume updates when tab becomes visible
        if (!refreshInterval) {
            refreshInterval = setInterval(loadActiveMissions, 5000);
            loadActiveMissions(); // Immediate refresh
        }
    }
});

function cleanup() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
    if (socket) {
        socket.off('connect');
        socket.off('reconnect');
        socket.off('connect_error');
        socket.off('disconnect');
        socket.off('dispatchAssigned');
        socket.off('dispatchQueued');
        socket.off('statusUpdate');
        socket.off('etaUpdate');
        socket.off('hospitalAssigned');
        socket.off('locationUpdate');
        socket.disconnect();
        socket = null;
    }
    if (driverWatchId && navigator.geolocation) {
        navigator.geolocation.clearWatch(driverWatchId);
        driverWatchId = null;
    }
}

function joinDriverSocketRooms() {
    if (!socket) return;
    const userId = getCurrentUserId();
    if (!userId) return;
    socket.emit('join', { userId, role: ROLES.DRIVER });
}

let socketConnected = false;
let pollingInterval = null;

function initSocket() {
    if (socket) {
        // Clear existing listeners before creating new socket
        socket.off('connect');
        socket.off('reconnect');
        socket.off('connect_error');
        socket.off('dispatchAssigned');
        socket.off('dispatchQueued');
        socket.off('statusUpdate');
        socket.off('etaUpdate');
        socket.off('hospitalAssigned');
        socket.off('locationUpdate');
        socket.disconnect();
    }
    
    socket = io({
        transports: ['polling', 'websocket'],
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
    });
    
    socket.on('connect', () => {
        socketConnected = true;
        console.log('Socket connected');
        joinDriverSocketRooms();
        loadActiveMissions();
        
        // Stop polling when socket reconnects
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }
    });

    socket.on('reconnect', () => {
        socketConnected = true;
        console.log('Socket reconnected');
        joinDriverSocketRooms();
        loadActiveMissions();
    });

    socket.on('connect_error', (error) => {
        socketConnected = false;
        console.error('Socket connect error:', error);
        
        // Start polling fallback if not already running
        if (!pollingInterval) {
            pollingInterval = setInterval(async () => {
                try {
                    console.log('Polling for updates (socket disconnected)');
                    await loadActiveMissions();
                } catch (err) {
                    console.error('Polling fallback failed', err);
                }
            }, 5000); // Keep active mission state current while disconnected.
        }
    });
    
    socket.on('disconnect', () => {
        socketConnected = false;
        console.log('Socket disconnected');
        
        // Start polling fallback
        if (!pollingInterval) {
            pollingInterval = setInterval(async () => {
                try {
                    console.log('Polling for updates (socket disconnected)');
                    await loadActiveMissions();
                } catch (err) {
                    console.error('Polling fallback failed', err);
                }
            }, 5000); // Keep active mission state current while disconnected.
        }
    });
    
    socket.on('dispatchAssigned', (data) => {
        const hospitalLabel = data.assignedHospital ? ` | Hospital: ${data.assignedHospital.name}` : '';
        showNotification(`New assignment received. Patient: ${data.patientName}. ETA: ${data.eta} min${hospitalLabel}`, 'info');
        if (data.requestId && data.assignedHospital) {
            updateMissionHospital(data.requestId, data.assignedHospital.name);
        }
        loadActiveMissions();
    });

    socket.on('dispatchQueued', (data) => {
        showNotification(data.message || 'A dispatch request is queued.', 'warning');
        loadActiveMissions();
    });

    socket.on('statusUpdate', (data) => {
        if (data.status === 'EN_ROUTE') {
            showNotification(`You are en route. ETA: ${data.eta} min`, 'success');
            updateMissionEta(data.requestId, data.eta);
        }
        if (data.status === 'COMPLETED') {
            showNotification('Mission completed.', 'success');
            loadActiveMissions();
        }
    });

    socket.on('etaUpdate', (data) => {
        if (data.requestId) {
            updateMissionEta(data.requestId, data.eta);
            showNotification(`ETA updated: ${data.eta} min`, 'info');
        }
    });

    socket.on('hospitalAssigned', (data) => {
        if (data.requestId && data.assignedHospital) {
            showNotification(`Hospital assigned: ${data.assignedHospital.name}`, 'info');
            updateMissionHospital(data.requestId, data.assignedHospital.name);
        }
    });

    socket.on('locationUpdate', (data) => {
        if (data.ambulanceId) {
            showNotification('Live location updated for your mission.', 'info');
            updateMissionLocation(data.requestId, data.coordinates);
        }
    });
}

function showAmbulanceRegistrationModal() {
    const modalElement = document.getElementById('registerAmbulanceModal');
    if (modalElement && window.bootstrap && typeof window.bootstrap.Modal === 'function') {
        preserveModalTriggerFocus(modalElement);
        const modal = new window.bootstrap.Modal(modalElement);
        modal.show();
    }
}

async function registerAmbulance(event) {
    event.preventDefault();

    const plateNumber = document.getElementById('plateNumber')?.value?.trim();
    const latitude = document.getElementById('ambulanceLatitude')?.value?.trim();
    const longitude = document.getElementById('ambulanceLongitude')?.value?.trim();
    const status = document.getElementById('ambulanceStatusInput')?.value;
    const capacity = document.getElementById('ambulanceCapacity')?.value;

    if (!plateNumber) {
        showNotification('Plate number is required.', 'warning');
        return;
    }

    const payload = {
        plateNumber,
        status,
        capacity: capacity ? Number(capacity) : undefined,
    };

    if (latitude && longitude) {
        payload.latitude = latitude;
        payload.longitude = longitude;
    }

    try {
        const response = await apiClient.post('/api/ambulances', payload);
        if (response.success) {
            showNotification('Ambulance registered successfully.', 'success');
            const modalElement = document.getElementById('registerAmbulanceModal');
            if (modalElement && window.bootstrap && typeof window.bootstrap.Modal === 'function') {
                window.bootstrap.Modal.getInstance(modalElement)?.hide();
            }
            loadAmbulanceStatus();
            loadActiveMissions();
        } else {
            showNotification(response.message || 'Failed to register ambulance.', 'danger');
        }
    } catch (err) {
        console.error('Ambulance registration failed', err);
        showNotification(err.message || 'Error registering ambulance.', 'danger');
    }
}

async function loadAmbulanceStatus() {
    const userId = getCurrentUserId();
    
    try {
        const data = await apiClient.request('/api/ambulances');
        if (data.success) {
            const myAmbulance = data.data.find(amb => String(amb.driverId?._id || amb.driverId) === String(userId));
            if (myAmbulance) {
                setAmbulanceStatusDisplay(myAmbulance.status, true);
                driverCoords = myAmbulance.currentLocation?.coordinates || null;
                updateDriverLocationDisplay(driverCoords);
                startDriverLocationWatch(myAmbulance._id);
                return myAmbulance;
            } else {
                setAmbulanceStatusDisplay('Not registered', false);
                updateDriverLocationDisplay(null);
            }
        } else {
            setAmbulanceStatusDisplay('Not registered', false);
            updateDriverLocationDisplay(null);
        }
    } catch (error) {
        console.error('Error loading ambulance status:', error);
        setAmbulanceStatusDisplay('Unavailable', false);
        updateDriverLocationDisplay(null);
    }
}

function updateDriverLocationDisplay(coords) {
    const locationEl = document.getElementById('driverLocation');
    if (!locationEl) return;
    if (coords && coords.length === 2) {
        locationEl.textContent = `${coords[1].toFixed(5)}, ${coords[0].toFixed(5)}`;
    } else {
        locationEl.textContent = 'Unknown';
    }
}

function startDriverLocationWatch(ambulanceId) {
    if (!navigator.geolocation || driverWatchId) return;

    const handlePosition = async (position) => {
        const { latitude, longitude } = position.coords;
        const newCoords = [longitude, latitude];
        driverCoords = newCoords;
        updateDriverLocationDisplay(newCoords);

        try {
            await apiClient.request(`/api/ambulances/${ambulanceId}/location`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ latitude, longitude }),
            });
        } catch (err) {
            console.error('Unable to sync driver location:', err);
            showNotification('Unable to sync driver location. Please check your network.', 'warning');
        }
    };

    const handleLocationError = (err) => {
        console.warn('Location watch failed:', err);
        showNotification(
            `Driver location unavailable: ${err.message || 'Please enable location services and try again.'}`,
            'warning'
        );

        if (err.code === 3) {
            // Timeout expired: try a one-time lower-accuracy request before giving up
            navigator.geolocation.getCurrentPosition(handlePosition, (fallbackErr) => {
                console.warn('Fallback location failed:', fallbackErr);
                showNotification(
                    `Unable to get current position: ${fallbackErr.message || 'Please try again.'}`,
                    'warning'
                );
            }, {
                enableHighAccuracy: false,
                maximumAge: 15000,
                timeout: 30000,
            });
        }
    };

    driverWatchId = navigator.geolocation.watchPosition(handlePosition, handleLocationError, {
        enableHighAccuracy: false,
        maximumAge: 10000,
        timeout: 30000,
    });
}

async function toggleStatus() {
    const userId = getCurrentUserId();

    try {
        const response = await apiClient.request('/api/ambulances');
        const myAmbulance = response.data.find(amb => String(amb.driverId?._id || amb.driverId) === String(userId));

        if (!myAmbulance) {
            showNotification('No ambulance found for this driver.', 'warning');
            return;
        }

        const current = normalizeAmbulanceStatus(myAmbulance.status);
        let newStatus;
        if (current === 'AVAILABLE') {
            newStatus = 'MAINTENANCE';
        } else if (current === 'MAINTENANCE') {
            newStatus = 'AVAILABLE';
        } else if (['BUSY', 'EN_ROUTE'].includes(current)) {
            showNotification('Use End Ride when the active emergency is complete.', 'warning');
            return;
        } else if (current === 'ASSIGNED') {
            showNotification('Cannot toggle status while assigned. Please accept or reject the assignment first.', 'warning');
            return;
        } else {
            showNotification(`Cannot toggle ambulance status from ${current}.`, 'warning');
            return;
        }

        const updateData = await apiClient.patch(`/api/ambulances/${myAmbulance._id}/status`, {
            status: newStatus,
        });

        if (updateData.success) {
            showNotification(`Status updated to ${newStatus}`, 'success');
            loadAmbulanceStatus();
        }
    } catch (error) {
        const message = error.response?.message || error.message || 'Error updating status';
        showNotification(message, 'danger');
        console.error('Ambulance status update failed', error);
    }
}

async function updateLocation() {
    if (!navigator.geolocation) {
        alert('Geolocation is not supported');
        return;
    }
    
    navigator.geolocation.getCurrentPosition(async (position) => {
        const { latitude, longitude } = position.coords;
        const userId = getCurrentUserId();
        
        try {
            const response = await apiClient.request('/api/ambulances');
            const myAmbulance = response.data.find(amb => String(amb.driverId?._id || amb.driverId) === String(userId));
            
            if (!myAmbulance) {
                showNotification('No ambulance found for this driver.', 'warning');
                return;
            }

            const updateData = await apiClient.request(`/api/ambulances/${myAmbulance._id}/location`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ latitude, longitude })
            });
            
            if (updateData.success) {
                showNotification('Location updated', 'success');
            }
        } catch (error) {
            showNotification('Error updating location', 'error');
        }
    });
}

async function trackMission(requestId) {
    if (!navigator.geolocation) {
        alert('Geolocation is not supported');
        return;
    }

    navigator.geolocation.getCurrentPosition(async (position) => {
        const { latitude, longitude } = position.coords;
        try {
            const response = await apiClient.patch(`/api/dispatch/${requestId}/track`, {
                latitude,
                longitude,
                status: 'EN_ROUTE'
            });

            if (response.success) {
                showNotification('Mission location updated.', 'success');
                loadActiveMissions();
            } else {
                showNotification(response.message || 'Unable to update mission location.', 'danger');
            }
        } catch (error) {
            console.error('Error tracking mission:', error);
            showNotification('Error tracking mission. Please try again.', 'error');
        }
    }, (err) => {
        console.error('Geolocation error:', err);
        showNotification('Unable to get your current location.', 'warning');
    });
}

async function loadActiveMissions() {
    if (isLoadingActiveMissions) {
        return;
    }

    isLoadingActiveMissions = true;
    try {
        const data = await apiClient.request('/api/dispatch/assignments');
        const missions = Array.isArray(data.data) ? data.data : [];
        
        if (data.success) {
            displayMissions(missions);
            updateStatistics(missions);
        } else {
            displayMissions([]);
            showNotification(data.message || 'No active missions found.', 'info');
        }
    } catch (error) {
        if (error.status === 404) {
            displayMissions([]);
            if (error.message && error.message.includes('Ambulance not registered')) {
                showNotification('No ambulance is registered for this driver yet.', 'warning');
            }
        } else {
            console.error('Error loading missions:', error);
            displayMissions([]);
            showNotification('Error loading missions. Please try again later.', 'error');
        }
    } finally {
        isLoadingActiveMissions = false;
        // Keep the vehicle badge aligned with the server-side assignment state.
        loadAmbulanceStatus();
    }
}

function displayMissions(requests) {
    const tbody = document.getElementById('missionsTableBody') || document.getElementById('emergencyTableBody');
    if (!tbody) {
        console.warn('No mission table body found for displayMissions');
        return;
    }

    if (!driverHasAmbulance) {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center">No ambulance registered. Register an ambulance to receive dispatch assignments.</td></tr>';
        return;
    }

    if (!requests || requests.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center">No active missions found</td></tr>';
        return;
    }
    
    let html = '';
    requests.forEach(request => {
        const time = new Date(request.requestTime || request.createdAt).toLocaleString();
        const locationCoords = request.location?.coordinates || [];
        const hasLocation = locationCoords.length === 2;
        const routeUrl = driverCoords && driverCoords.length === 2 && hasLocation
            ? `https://www.google.com/maps/dir/?api=1&origin=${driverCoords[1]},${driverCoords[0]}&destination=${locationCoords[1]},${locationCoords[0]}&travelmode=driving`
            : null;
        const etaText = request.eta ? `<div class="small text-muted">ETA: ${request.eta} min</div>` : '';
        
        html += `
            <tr data-request-id="${request._id}">
                <td>${time}${etaText}</td>
                <td>${request.userName}</td>
                <td>${request.userPhone}</td>
                <td>
                    ${hasLocation ? `
                        <button class="btn btn-sm btn-info btn-view-location" data-latitude="${locationCoords[1]}" data-longitude="${locationCoords[0]}">
                            View Location
                        </button>
                    ` : 'Location unavailable'}
                </td>
                <td>${request.priority || 'MEDIUM'}</td>
                <td><span class="badge bg-${getStatusBadge(request.status)}">${request.status}</span></td>
                <td>${request.assignedHospital?.name ? request.assignedHospital.name : 'Pending'}</td>
                <td>${request.medicalHistorySummary || 'N/A'}</td>
                <td>
                    ${routeUrl ? `<a class="btn btn-sm btn-secondary me-1" href="${routeUrl}" target="_blank">Route</a>` : ''}
                    ${request.status === 'ASSIGNED' ? 
                        `<button class="btn btn-sm btn-success btn-respond-assignment" data-request-id="${request._id}" data-accept="true">Accept</button>
                         <button class="btn btn-sm btn-danger btn-respond-assignment" data-request-id="${request._id}" data-accept="false">Reject</button>` : 
                        request.status === 'EN_ROUTE' ? 
                        `<button class="btn btn-sm btn-primary btn-update-location" data-request-id="${request._id}">Update Location</button>
                         <button class="btn btn-sm btn-success btn-complete-mission" data-request-id="${request._id}">End Ride</button>` : 
                        request.status === 'COMPLETED' ? 'Completed' : 'In Progress'}
                </td>
            </tr>
        `;
    });
    
    tbody.innerHTML = html;
}

function getStatusBadge(status) {
    switch(status) {
        case 'ASSIGNED': return 'warning';
        case 'EN_ROUTE': return 'info';
        case 'COMPLETED': return 'success';
        default: return 'secondary';
    }
}

function updateStatistics(requests) {
    const active = requests.filter(r => r.status !== 'COMPLETED').length;
    const completed = requests.filter(r => r.status === 'COMPLETED').length;
    const assigned = requests.filter(r => r.status === 'ASSIGNED').length;
    const enRoute = requests.filter(r => r.status === 'EN_ROUTE').length;

    const pendingElement = document.getElementById('pendingCount');
    const acceptedElement = document.getElementById('acceptedCount');
    const incomingElement = document.getElementById('incomingCount');
    const completedElement = document.getElementById('completedCount');

    if (pendingElement) pendingElement.textContent = active;
    if (acceptedElement) acceptedElement.textContent = assigned + enRoute;
    if (incomingElement) incomingElement.textContent = enRoute;
    if (completedElement) completedElement.textContent = completed;
}

function updateMissionEta(requestId, eta) {
    const row = document.querySelector(`tr[data-request-id="${requestId}"]`);
    if (!row) return;
    const timeCell = row.querySelector('td:first-child');
    if (!timeCell) return;
    const existingEta = row.querySelector('.live-eta');
    const etaText = ` <span class="badge bg-info live-eta">ETA: ${eta} min</span>`;
    if (existingEta) {
        existingEta.textContent = `ETA: ${eta} min`;
    } else {
        timeCell.insertAdjacentHTML('beforeend', etaText);
    }
}

function updateMissionHospital(requestId, hospitalName) {
    const row = document.querySelector(`tr[data-request-id="${requestId}"]`);
    if (!row) return;
    const cells = row.querySelectorAll('td');
    if (cells.length < 7) return;
    const hospitalCell = cells[6];
    if (hospitalCell) {
        hospitalCell.textContent = hospitalName || 'Assigned';
    }
}

function updateMissionLocation(requestId, coordinates) {
    if (!coordinates || coordinates.length !== 2) return;
    const row = document.querySelector(`tr[data-request-id="${requestId}"]`);
    if (!row) return;
    const cells = row.querySelectorAll('td');
    if (cells.length < 4) return;
    cells[3].textContent = `Lat: ${coordinates[1].toFixed(4)}, Lng: ${coordinates[0].toFixed(4)}`;
}

function viewLocation(latitude, longitude) {
    const modalBody = document.getElementById('locationModalBody');
    if (modalBody) {
        modalBody.innerHTML = `
            <p><strong>Latitude:</strong> ${latitude}</p>
            <p><strong>Longitude:</strong> ${longitude}</p>
            <a href="https://www.google.com/maps?q=${latitude},${longitude}" target="_blank" class="btn btn-primary">
                Open in Google Maps
            </a>
        `;
    }
    const modalElement = document.getElementById('locationModal');
    if (modalElement && window.bootstrap && typeof window.bootstrap.Modal === 'function') {
        preserveModalTriggerFocus(modalElement);
        new window.bootstrap.Modal(modalElement).show();
    }
}

function filterMissionRows() {
    const searchInput = document.getElementById('searchInput');
    const statusFilter = document.getElementById('statusFilter');
    const rows = document.querySelectorAll('#missionsTableBody tr');
    const searchTerm = searchInput?.value.toLowerCase() || '';
    const filter = statusFilter?.value || 'all';

    rows.forEach(row => {
        if (row.cells.length > 1) {
            const patientName = row.cells[1]?.textContent.toLowerCase() || '';
            const phone = row.cells[2]?.textContent.toLowerCase() || '';
            const status = row.cells[5]?.textContent.trim() || '';
            const matchesSearch = patientName.includes(searchTerm) || phone.includes(searchTerm);
            const matchesFilter = filter === 'all' || status === filter;
            row.style.display = matchesSearch && matchesFilter ? '' : 'none';
        }
    });
}

function refreshRequests() {
    loadActiveMissions();
}

function exportData() {
    // Trigger download of ambulance data
    const link = document.createElement('a');
    link.href = `/api/ambulances/me/export?format=json`;
    link.download = 'ambulance-data.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showNotification('Data exported successfully', 'success');
}

function viewStatistics() {
    fetch('/api/ambulances/me/statistics', {
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
    const modalHtml = `
        <div class="modal fade" id="statisticsModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Ambulance Statistics - ${stats.ambulance.callSign}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="row">
                            <div class="col-md-6">
                                <h6>Ambulance Info</h6>
                                <p><strong>Status:</strong> ${stats.ambulance.status}</p>
                                <p><strong>Capacity:</strong> ${stats.ambulance.capacity}</p>
                            </div>
                            <div class="col-md-6">
                                <h6>Request Statistics</h6>
                                <p><strong>Total Requests:</strong> ${stats.ambulance.totalRequests}</p>
                                <p><strong>Completed:</strong> ${stats.ambulance.completedRequests}</p>
                                <p><strong>Cancelled:</strong> ${stats.ambulance.cancelledRequests}</p>
                                <p><strong>Active:</strong> ${stats.ambulance.activeRequests}</p>
                            </div>
                        </div>
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

async function findNearestHospital() {
    const body = document.getElementById('nearestHospitalBody');
    if (body) {
        body.innerHTML = `
            <div class="text-center py-4">
                <div class="spinner-border text-primary" role="status"></div>
                <p class="mt-2 text-muted">Finding the closest hospital with available beds...</p>
            </div>
        `;
    }

    const modalElement = document.getElementById('nearestHospitalModal');
    if (modalElement && window.bootstrap && typeof window.bootstrap.Modal === 'function') {
        preserveModalTriggerFocus(modalElement);
        window.bootstrap.Modal.getOrCreateInstance(modalElement).show();
    }

    try {
        const response = await apiClient.get('/api/hospitals/nearest-for-driver');
        const hospital = response.data;

        if (!hospital) {
            if (body) {
                body.innerHTML = `<p class="text-muted mb-0">${response.message || 'No nearby hospital with available beds found.'}</p>`;
            }
            return;
        }

        const [lng, lat] = hospital.location?.coordinates || [];
        const beds = Array.isArray(hospital.beds) ? hospital.beds : [];
        const bedRows = beds
            .filter((bed) => Number(bed.available) > 0)
            .map((bed) => `<span class="badge bg-success me-1 mb-1">${bed.type}: ${bed.available}/${bed.total}</span>`)
            .join('');

        if (body) {
            body.innerHTML = `
                <h6 class="mb-1">${hospital.name}</h6>
                <p class="text-muted mb-3">${Math.round((hospital.distanceMetres || 0) / 100) / 10} km away</p>
                <div class="mb-3">${bedRows || '<span class="badge bg-secondary">Beds available</span>'}</div>
                <p class="mb-3"><strong>Capacity:</strong> ${hospital.capacityStatus} (${hospital.availableBeds} available)</p>
                ${hospital.phone ? `<p class="mb-1"><strong>Phone:</strong> ${hospital.phone}</p>` : ''}
                ${lat != null && lng != null ? `<p class="text-muted">Lat: ${Number(lat).toFixed(5)}, Lng: ${Number(lng).toFixed(5)}</p>` : ''}
                <a class="btn btn-primary w-100" href="${hospital.routeUrl}" target="_blank">
                    Open Route
                </a>
            `;
        }
    } catch (error) {
        console.error('Nearest hospital lookup failed:', error);
        if (body) {
            body.innerHTML = `<p class="text-danger mb-0">${error.message || 'Unable to find nearest hospital.'}</p>`;
        }
    }
}

async function respondToAssignment(requestId, accept) {
    try {
        const data = await apiClient.request(`/api/dispatch/${requestId}/response`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ accept })
        });
        if (data.success) {
            showNotification(accept ? 'Assignment accepted' : 'Assignment rejected', 'success');
            loadActiveMissions();
        } else {
            showNotification(data.message, 'error');
        }
    } catch (err) {
        showNotification('Error responding to assignment', 'error');
    }
}

async function completeMission(requestId) {
    if (!confirm('Is the ride over? This will complete the emergency and make your ambulance available.')) {
        return;
    }
    
    try {
        const data = await apiClient.request(`/api/emergency/${requestId}/complete`, {
            method: 'PUT'
        });
        
        if (data.success) {
            showNotification('Mission completed successfully', 'success');
            loadActiveMissions();
        } else {
            showNotification(data.message, 'error');
        }
    } catch (error) {
        showNotification('Error completing mission', 'error');
    }
}

function showNotification(message, type) {
    const alertType = type === 'success' ? 'success' : type === 'warning' ? 'warning' : type === 'info' ? 'info' : 'danger';
    const notification = document.createElement('div');
    notification.className = `alert alert-${alertType} position-fixed top-0 end-0 m-3`;
    notification.style.zIndex = '9999';
    notification.style.minWidth = '300px';
    notification.innerHTML = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 3000);
}
