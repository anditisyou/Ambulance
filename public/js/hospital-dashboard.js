// hospital-dashboard.js - Modern Hospital Dashboard
'use strict';

// ==================== GLOBALS ====================
let refreshInterval = null;
let socket = null;
let isLoadingEmergencyRequests = false;
let currentMedicalHistoryUserId = null;
let currentHospitalProfile = null;

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
    ACCEPTED: 'ACCEPTED',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED'
};

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', async () => {
    const user = apiClient.authState.getUser();
    
    if (!user || user.role !== ROLES.HOSPITAL) {
        window.location.href = '/';
        return;
    }
    
    // Display hospital information
    document.getElementById('hospitalName').textContent = user.name || 'Apollo Hospital';
    document.getElementById('doctorName').textContent = user.name || 'Dr. Admin';
    
    // Initialize Socket.IO connection
    initSocket();
    
    // Load initial data
    await loadEmergencyRequests();
    await loadHospitalProfile();
    
    // Set up auto-refresh every 30 seconds
    refreshInterval = setInterval(() => {
        loadEmergencyRequests();
        loadHospitalProfile();
    }, 30000);
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (refreshInterval) clearInterval(refreshInterval);
    if (socket) socket.disconnect();
});

// ==================== SOCKET.IO ====================
function initSocket() {
    const token = apiClient.authState.getToken();
    const user = apiClient.authState.getUser();
    
    socket = io({
        transports: ['polling', 'websocket'],
        auth: { token },
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
    });
    
    socket.on('connect', () => {
        console.log('Socket connected');
        if (user?.id) {
            socket.emit('join', { userId: user.id, role: ROLES.HOSPITAL });
        }
    });
    
    socket.on('newEmergencyRequest', () => {
        console.log('New emergency request received');
        loadEmergencyRequests();
        addActivityLog('🆕 New emergency request received', 'info');
        showToast('New emergency request received!', 'info');
    });
    
    socket.on('hospitalCapacityUpdate', (data) => {
        if (data) {
            loadHospitalProfile();
            addActivityLog('📊 Bed capacity updated', 'info');
        }
    });
    
    socket.on('dispatchAssigned', (data) => {
        if (data?.requestId) {
            loadEmergencyRequests();
            addActivityLog(`🚑 Ambulance assigned to request #${data.requestId.slice(-6)}`, 'success');
        }
    });
}

// ==================== API CALLS ====================
async function loadEmergencyRequests() {
    if (isLoadingEmergencyRequests) return;
    
    isLoadingEmergencyRequests = true;
    
    try {
        const data = await apiClient.request('/api/emergency');
        
        if (data.success) {
            displayEmergencyRequests(data.data);
            updateStatistics(data.data);
        } else {
            console.error('Failed to load emergency requests:', data.message);
            displayEmergencyRequests([]);
        }
    } catch (error) {
        console.error('Error loading emergency requests:', error);
        displayEmergencyRequests([]);
        
        if (error.status === 401) {
            window.location.href = '/';
        }
    } finally {
        isLoadingEmergencyRequests = false;
    }
}

async function loadHospitalProfile() {
    try {
        const data = await apiClient.get('/api/hospitals/me');
        
        if (data.success && data.data) {
            currentHospitalProfile = data.data;
            updateBedCapacityDisplay(data.data);
            updateBedUpdateForm(data.data);
        }
    } catch (error) {
        console.error('Error loading hospital profile:', error);
    }
}

async function updateBedCapacityUI() {
    await loadHospitalProfile();
}

async function submitBedUpdate(event) {
    event.preventDefault();
    
    const form = event.target;
    const formData = new FormData(form);
    const beds = [];
    
    // Parse bed data from form
    let index = 0;
    while (formData.has(`beds[${index}][type]`)) {
        beds.push({
            type: formData.get(`beds[${index}][type]`),
            total: parseInt(formData.get(`beds[${index}][total]`)) || 0,
            available: parseInt(formData.get(`beds[${index}][available]`)) || 0
        });
        index++;
    }
    
    try {
        const response = await apiClient.put('/api/hospitals/beds', { beds });
        
        if (response.success) {
            showToast('Bed capacity updated successfully', 'success');
            addActivityLog('🏥 Bed capacity updated by hospital admin', 'success');
            closeBedUpdateModal();
            await loadHospitalProfile();
        } else {
            showToast(response.message || 'Failed to update bed capacity', 'error');
        }
    } catch (error) {
        console.error('Error updating beds:', error);
        showToast('Error updating bed capacity', 'error');
    }
}

async function acceptRequest(requestId) {
    if (!confirm('Are you sure you want to accept this emergency request?')) return;
    
    try {
        const data = await apiClient.put(`/api/emergency/${requestId}/accept`);
        
        if (data.success) {
            showToast('Request accepted successfully', 'success');
            addActivityLog(`✅ Emergency request #${requestId.slice(-6)} accepted`, 'success');
            await loadEmergencyRequests();
        } else {
            showToast(data.message || 'Failed to accept request', 'error');
        }
    } catch (error) {
        console.error('Error accepting request:', error);
        showToast('Error accepting request', 'error');
    }
}

async function viewMedicalHistory(userId) {
    if (!userId) {
        showToast('Invalid user ID', 'error');
        return;
    }
    
    currentMedicalHistoryUserId = userId;
    
    try {
        const data = await apiClient.get(`/api/medical/user/${userId}`);
        
        if (data.success) {
            displayMedicalHistory(data.data);
            showMedicalHistoryModal();
        } else {
            showToast('No medical records found', 'info');
        }
    } catch (error) {
        console.error('Error loading medical history:', error);
        showToast('Error loading medical history', 'error');
    }
}

// ==================== UI RENDERING ====================
function displayEmergencyRequests(requests) {
    const container = document.getElementById('emergencyCardContainer');
    const emptyState = document.getElementById('emptyFeedState');
    
    if (!container) return;
    
    // Filter out completed requests for the feed
    const activeRequests = requests.filter(r => r.status !== STATUS.COMPLETED && r.status !== STATUS.CANCELLED);
    
    if (!activeRequests || activeRequests.length === 0) {
        container.classList.add('hidden');
        emptyState.classList.remove('hidden');
        return;
    }
    
    container.classList.remove('hidden');
    emptyState.classList.add('hidden');
    
    let html = '';
    
    activeRequests.forEach(request => {
        const priority = request.priority || 'MEDIUM';
        const priorityConfig = getPriorityConfig(priority);
        const timeAgo = getTimeAgo(request.requestTime || request.createdAt);
        const locationText = formatLocation(request.location);
        const statusText = formatStatus(request.status);
        
        html += `
            <div class="emergency-card bg-white rounded-xl shadow-sm border border-gray-100 p-5 transition-all duration-300 ${priorityConfig.cardClass} hover:shadow-md" data-request-id="${request._id}">
                <div class="flex flex-wrap lg:flex-nowrap justify-between gap-4">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-3 flex-wrap mb-3">
                            <span class="font-bold text-gray-900 text-lg">${escapeHtml(request.userName || 'Unknown Patient')}</span>
                            <span class="text-xs font-semibold px-2.5 py-1 rounded-full ${priorityConfig.badgeClass}">${priority}</span>
                            <span class="text-xs text-gray-400 flex items-center gap-1">
                                <i class="far fa-clock"></i> ${timeAgo}
                            </span>
                        </div>
                        
                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-4 text-sm">
                            <div class="flex items-center gap-2 text-gray-600">
                                <i class="fas fa-phone-alt text-gray-400 w-4"></i>
                                <span>${escapeHtml(request.userPhone || 'N/A')}</span>
                            </div>
                            <div class="flex items-center gap-2 text-gray-600">
                                <i class="fas fa-map-marker-alt text-gray-400 w-4"></i>
                                <span class="truncate">${locationText}</span>
                            </div>
                            ${request.medicalHistorySummary ? `
                            <div class="flex items-center gap-2 text-gray-600 col-span-full">
                                <i class="fas fa-notes-medical text-gray-400 w-4"></i>
                                <span class="truncate">${escapeHtml(request.medicalHistorySummary.substring(0, 100))}</span>
                            </div>
                            ` : ''}
                        </div>
                    </div>
                    
                    <div class="flex gap-2 items-start">
                        <span class="text-xs px-2.5 py-1 rounded-full ${statusText.badgeClass} whitespace-nowrap">${statusText.label}</span>
                        <button onclick="viewMedicalHistory('${request.userId?._id || request.userId}')" 
                                class="bg-gray-50 hover:bg-gray-100 text-gray-600 text-sm px-3 py-2 rounded-lg transition-all duration-200">
                            <i class="fas fa-notes-medical"></i>
                        </button>
                        ${request.status === STATUS.PENDING ? `
                        <button onclick="acceptRequest('${request._id}')" 
                                class="bg-green-50 hover:bg-green-100 text-green-700 text-sm font-medium px-4 py-2 rounded-lg transition-all duration-200">
                            <i class="fas fa-check-circle mr-1"></i>Accept
                        </button>
                        ` : ''}
                    </div>
                </div>
                
                <div class="mt-3 pt-3 border-t border-gray-50 flex justify-between text-xs text-gray-400">
                    <span><i class="fas fa-hashtag"></i> ID: ${request._id.slice(-8)}</span>
                    <span><i class="fas fa-ambulance"></i> Assigned: ${request.assignedHospital?.name || 'Pending'}</span>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function updateStatistics(requests) {
    const critical = requests.filter(r => r.priority === 'CRITICAL' && r.status !== STATUS.COMPLETED).length;
    const pending = requests.filter(r => r.status === STATUS.PENDING).length;
    const inProgress = requests.filter(r => r.status === STATUS.ASSIGNED || r.status === STATUS.EN_ROUTE).length;
    const completed = requests.filter(r => r.status === STATUS.COMPLETED).length;
    
    document.getElementById('statCritical').textContent = critical;
    document.getElementById('statPending').textContent = pending;
    document.getElementById('statInProgress').textContent = inProgress;
    document.getElementById('statCompleted').textContent = completed;
}

function updateBedCapacityDisplay(profile) {
    if (!profile || !profile.beds) return;
    
    const beds = profile.beds;
    let totalAvailable = 0;
    let totalCapacity = 0;
    
    beds.forEach(bed => {
        const occupied = bed.total - bed.available;
        const occupancyPercent = (occupied / bed.total) * 100;
        
        if (bed.type === 'ICU') {
            document.getElementById('icuOccupancyText').textContent = `${occupied}/${bed.total}`;
            document.getElementById('icuProgressBar').style.width = `${occupancyPercent}%`;
        } else if (bed.type === 'General') {
            document.getElementById('generalOccupancyText').textContent = `${occupied}/${bed.total}`;
            document.getElementById('generalProgressBar').style.width = `${occupancyPercent}%`;
        } else if (bed.type === 'Pediatric') {
            document.getElementById('pediaOccupancyText').textContent = `${occupied}/${bed.total}`;
            document.getElementById('pediaProgressBar').style.width = `${occupancyPercent}%`;
        }
        
        totalAvailable += bed.available;
        totalCapacity += bed.total;
    });
    
    document.getElementById('statBedAvail').textContent = totalAvailable;
    document.getElementById('totalCapacity').textContent = totalCapacity;
    document.getElementById('bedLastUpdate').textContent = new Date().toLocaleTimeString();
}

function updateBedUpdateForm(profile) {
    const container = document.getElementById('bedFieldsContainer');
    if (!container || !profile?.beds) return;
    
    container.innerHTML = profile.beds.map((bed, index) => `
        <div class="space-y-2">
            <label class="font-semibold text-gray-700 text-sm">${bed.type} Beds</label>
            <div class="grid grid-cols-2 gap-3">
                <div>
                    <input type="number" name="beds[${index}][total]" value="${bed.total}" 
                           class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                           placeholder="Total" required>
                </div>
                <div>
                    <input type="number" name="beds[${index}][available]" value="${bed.available}"
                           class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                           placeholder="Available" required>
                </div>
            </div>
            <input type="hidden" name="beds[${index}][type]" value="${bed.type}">
        </div>
    `).join('');
}

function displayMedicalHistory(records) {
    const container = document.getElementById('medicalHistoryContent');
    
    if (!records || records.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8">
                <i class="fas fa-folder-open text-gray-300 text-5xl mb-3"></i>
                <p class="text-gray-500">No medical records found for this patient</p>
            </div>
        `;
        return;
    }
    
    let html = '<div class="space-y-3">';
    records.forEach(record => {
        const date = new Date(record.createdAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        html += `
            <div class="border border-gray-100 rounded-xl p-4 hover:shadow-sm transition-all">
                <div class="flex justify-between items-start">
                    <div class="flex-1">
                        <h4 class="font-semibold text-gray-800">${escapeHtml(record.fileName || 'Medical Record')}</h4>
                        <p class="text-xs text-gray-500 mt-1">Uploaded: ${date}</p>
                        ${record.recordType ? `<p class="text-xs text-gray-400 mt-1">Type: ${record.recordType}</p>` : ''}
                        ${record.fileSize ? `<p class="text-xs text-gray-400">Size: ${(record.fileSize / 1024).toFixed(2)} KB</p>` : ''}
                    </div>
                    ${record.fileUrl ? `
                    <a href="${record.fileUrl}" target="_blank" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-600 px-4 py-2 rounded-lg text-sm font-medium transition">
                        <i class="fas fa-external-link-alt mr-1"></i>View
                    </a>
                    ` : ''}
                </div>
            </div>
        `;
    });
    html += '</div>';
    
    container.innerHTML = html;
}

function addActivityLog(message, type = 'info') {
    const container = document.getElementById('activityLog');
    if (!container) return;
    
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const icon = type === 'success' ? 'fa-check-circle text-green-500' : 
                 type === 'error' ? 'fa-exclamation-circle text-red-500' : 
                 'fa-info-circle text-blue-500';
    
    const logEntry = document.createElement('div');
    logEntry.className = 'px-6 py-3 hover:bg-gray-50 transition-colors flex items-center gap-3 border-b border-gray-50';
    logEntry.innerHTML = `
        <i class="fas ${icon} text-sm"></i>
        <span class="text-sm text-gray-600 flex-1">${escapeHtml(message)}</span>
        <span class="text-xs text-gray-400">${time}</span>
    `;
    
    container.insertBefore(logEntry, container.firstChild);
    
    // Keep only last 10 entries
    while (container.children.length > 10) {
        container.removeChild(container.lastChild);
    }
    
    // Remove loading placeholder if present
    if (container.children.length === 1 && container.firstChild.textContent.includes('Loading')) {
        container.innerHTML = '';
        container.appendChild(logEntry);
    }
}

// ==================== HELPER FUNCTIONS ====================
function getPriorityConfig(priority) {
    const configs = {
        'CRITICAL': {
            badgeClass: 'bg-red-100 text-red-700',
            cardClass: 'border-l-4 border-l-red-500 critical-pulse',
            icon: 'fa-heartbeat'
        },
        'HIGH': {
            badgeClass: 'bg-orange-100 text-orange-700',
            cardClass: 'border-l-4 border-l-orange-400',
            icon: 'fa-chart-line'
        },
        'MEDIUM': {
            badgeClass: 'bg-blue-100 text-blue-700',
            cardClass: 'border-l-4 border-l-blue-400',
            icon: 'fa-chart-simple'
        },
        'LOW': {
            badgeClass: 'bg-gray-100 text-gray-600',
            cardClass: '',
            icon: 'fa-chart-line'
        }
    };
    return configs[priority] || configs['MEDIUM'];
}

function formatStatus(status) {
    const statuses = {
        'PENDING': { label: 'Pending', badgeClass: 'bg-amber-100 text-amber-700' },
        'ASSIGNED': { label: 'Assigned', badgeClass: 'bg-blue-100 text-blue-700' },
        'EN_ROUTE': { label: 'En Route', badgeClass: 'bg-purple-100 text-purple-700' },
        'COMPLETED': { label: 'Completed', badgeClass: 'bg-green-100 text-green-700' },
        'CANCELLED': { label: 'Cancelled', badgeClass: 'bg-gray-100 text-gray-600' }
    };
    return statuses[status] || statuses['PENDING'];
}

function getTimeAgo(dateString) {
    if (!dateString) return 'Just now';
    
    const date = new Date(dateString);
    const now = new Date();
    const diffSeconds = Math.floor((now - date) / 1000);
    
    if (diffSeconds < 60) return 'Just now';
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)} min ago`;
    if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)} hour ago`;
    return `${Math.floor(diffSeconds / 86400)} days ago`;
}

function formatLocation(location) {
    if (!location) return 'Location unavailable';
    if (location.address) return location.address;
    if (location.coordinates && location.coordinates.length === 2) {
        return `${location.coordinates[1].toFixed(6)}, ${location.coordinates[0].toFixed(6)}`;
    }
    return 'Location pending';
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `fixed bottom-6 right-6 z-50 bg-white rounded-xl shadow-xl border-l-4 ${type === 'success' ? 'border-green-500' : type === 'error' ? 'border-red-500' : 'border-blue-500'} p-4 transform transition-all duration-300 animate-slide-in`;
    toast.innerHTML = `
        <div class="flex items-center gap-3">
            <i class="fas ${type === 'success' ? 'fa-check-circle text-green-500' : type === 'error' ? 'fa-exclamation-circle text-red-500' : 'fa-info-circle text-blue-500'} text-xl"></i>
            <span class="text-gray-700">${escapeHtml(message)}</span>
        </div>
    `;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ==================== MODAL CONTROLS ====================
function showMedicalHistoryModal() {
    const modal = document.getElementById('medicalHistoryModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
}

function closeMedicalHistoryModal() {
    const modal = document.getElementById('medicalHistoryModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        document.getElementById('medicalHistoryContent').innerHTML = '';
    }
}

function showBedUpdateModal() {
    const modal = document.getElementById('bedUpdateModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
}

function closeBedUpdateModal() {
    const modal = document.getElementById('bedUpdateModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

// ==================== PUBLIC FUNCTIONS ====================
window.refreshRequests = function() {
    loadEmergencyRequests();
    showToast('Refreshing emergency requests...', 'info');
};

window.logout = function() {
    if (typeof logout === 'function') {
        logout();
    } else {
        window.location.href = '/';
    }
};

window.acceptRequest = acceptRequest;
window.viewMedicalHistory = viewMedicalHistory;
window.submitBedUpdate = submitBedUpdate;
window.showBedUpdateModal = showBedUpdateModal;
window.closeBedUpdateModal = closeBedUpdateModal;
window.closeMedicalHistoryModal = closeMedicalHistoryModal;