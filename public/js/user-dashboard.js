// user-dashboard.js - Fixed API endpoints
const ROLES = {
    CITIZEN: 'CITIZEN',
    DRIVER: 'DRIVER',
    HOSPITAL: 'HOSPITAL',
    ADMIN: 'ADMIN',
    DISPATCHER: 'DISPATCHER'
};

let socket = null;
let refreshInterval = null;
let selectedFile = null;
let isCheckingActiveEmergency = false;
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

document.addEventListener('DOMContentLoaded', () => {
    const user = apiClient.authState.getUser();

    if (!user || user.role !== ROLES.CITIZEN) {
        window.location.href = '/';
        return;
    }

    document.getElementById('userName').textContent = user.name;
    document.getElementById('userFullName').textContent = user.name;
    document.getElementById('userInitials').textContent = user.name.charAt(0).toUpperCase();

    initSocket();
    setupModalAccessibility();
    loadMedicalRecords(user.id || user._id);
    checkActiveEmergency();

    refreshInterval = setInterval(() => {
        checkActiveEmergency();
    }, 30000);

    setupDragAndDrop();
});

window.addEventListener('beforeunload', () => {
    if (refreshInterval) clearInterval(refreshInterval);
    if (socket) socket.disconnect();
});

function initSocket() {
    const token = apiClient.authState.getToken();
    socket = io({
        path: '/socket.io',
        transports: ['polling', 'websocket'],
        auth: { token },
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
    });
    
    socket.on('connect', () => {
        console.log('Socket connected');
        const user = apiClient.authState.getUser();
        const userId = user?.id || user?._id;
        if (userId) {
            socket.emit('join', { userId, role: user.role });
        }
    });
    
    socket.on('ambulanceAssigned', (data) => {
        console.log('Ambulance assigned:', data);
        showNotification(`Ambulance assigned! ETA: ${data.eta} minutes`, 'success');
        checkActiveEmergency();
    });
    
    socket.on('ambulanceEnRoute', (data) => {
        console.log('Ambulance en route:', data);
        showNotification(`Ambulance is on the way! ETA: ${data.eta} minutes`, 'info');
        checkActiveEmergency();
    });
    
    socket.on('dispatchQueued', (data) => {
        showNotification(data.message || 'Your request is queued', 'warning');
    });
    
    socket.on('etaUpdate', (data) => {
        const statusDiv = document.getElementById('emergencyStatus');
        if (statusDiv) statusDiv.textContent = `Status: EN_ROUTE | ETA: ${data.eta} minutes`;
    });

    socket.on('requestCancelled', (data) => {
        console.log('Request cancelled:', data);
        showNotification('Your emergency request has been cancelled', 'info');
        checkActiveEmergency();
    });
}

async function loadMedicalRecords(userId) {
    try {
        const data = await apiClient.get(`/medical/user/${userId}`);
        if (data.success) {
            displayMedicalRecords(data.data);
        } else {
            console.error('Failed to load records:', data.message);
            showNotification('Failed to load medical records', 'error');
        }
    } catch (error) {
        console.error('Error loading medical records:', error);
        showNotification('Error loading medical records', 'error');
    }
}

function displayMedicalRecords(records) {
    const container = document.getElementById('medicalRecords');
    
    if (!records || records.length === 0) {
        container.innerHTML = `
            <div class="empty-records">
                <i class="fas fa-folder-open"></i>
                <p>No medical records found. Upload your first record to get started.</p>
            </div>
        `;
        return;
    }
    
    let html = '';
    records.forEach(record => {
        const date = new Date(record.createdAt).toLocaleDateString();
        const fileType = record.recordType === 'image' ? 'Image' : 'PDF';
        const icon = record.recordType === 'image' ? 'fa-file-image' : 'fa-file-pdf';
        
        html += `
            <div class="record-card">
                <div class="record-icon">
                    <i class="fas ${icon}"></i>
                </div>
                <div class="record-info">
                    <h4 title="${escapeHtml(record.fileName || 'Medical Record')}">${escapeHtml(record.fileName || 'Medical Record')}</h4>
                    <p>${fileType} • ${date}</p>
                    ${record.fileSize ? `<small>${(record.fileSize / 1024).toFixed(2)} KB</small>` : ''}
                </div>
                <div class="record-actions">
                    <button class="record-btn" onclick="viewRecord('${record.fileUrl}', '${record.recordType}')">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="record-btn" onclick="deleteRecord('${record._id}')">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
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

function viewRecord(url, recordType) {
    if (!url) {
        showNotification('File URL not found', 'error');
        return;
    }
    
    if (recordType === 'pdf') {
        const googleViewer = `https://docs.google.com/viewer?url=${encodeURIComponent(url)}&embedded=true`;
        window.open(googleViewer, '_blank');
    } else {
        window.open(url, '_blank');
    }
}

async function deleteRecord(recordId) {
    if (!confirm('Are you sure you want to delete this record?')) return;

    try {
        const data = await apiClient.delete(`/medical/record/${recordId}`);
        if (data.success) {
            showNotification('Record deleted successfully', 'success');
            const user = apiClient.authState.getUser();
            loadMedicalRecords(user?.id || user?._id);
        } else {
            showNotification(data.message || 'Error deleting record', 'error');
        }
    } catch (error) {
        console.error('Error deleting record:', error);
        showNotification('Error deleting record', 'error');
    }
}

function showUploadModal() {
    const modalElement = document.getElementById('uploadModal');
    if (modalElement) {
        resetUploadForm();
        preserveModalTriggerFocus(modalElement);
        const modal = new bootstrap.Modal(modalElement);
        modal.show();
    }
}

function resetUploadForm() {
    const fileInput = document.getElementById('medicalFile');
    const selectedFilePreview = document.getElementById('selectedFilePreview');
    const uploadSubmitBtn = document.getElementById('uploadSubmitBtn');
    const uploadProgress = document.getElementById('uploadProgress');
    const uploadArea = document.getElementById('uploadArea');
    
    selectedFile = null;
    if (fileInput) fileInput.value = '';
    if (selectedFilePreview) selectedFilePreview.style.display = 'none';
    if (uploadProgress) uploadProgress.style.display = 'none';
    if (uploadArea) uploadArea.style.display = 'block';
    if (uploadSubmitBtn) uploadSubmitBtn.disabled = true;
    
    const fileValidation = document.getElementById('fileValidation');
    if (fileValidation) fileValidation.style.display = 'none';
}

function clearSelectedFile() {
    const fileInput = document.getElementById('medicalFile');
    const selectedFilePreview = document.getElementById('selectedFilePreview');
    const uploadSubmitBtn = document.getElementById('uploadSubmitBtn');
    const uploadArea = document.getElementById('uploadArea');
    
    selectedFile = null;
    if (fileInput) fileInput.value = '';
    if (selectedFilePreview) selectedFilePreview.style.display = 'none';
    if (uploadArea) uploadArea.style.display = 'block';
    if (uploadSubmitBtn) uploadSubmitBtn.disabled = true;
    
    const fileValidation = document.getElementById('fileValidation');
    if (fileValidation) fileValidation.style.display = 'none';
}

document.getElementById('medicalFile')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const uploadArea = document.getElementById('uploadArea');
    const selectedFilePreview = document.getElementById('selectedFilePreview');
    const uploadSubmitBtn = document.getElementById('uploadSubmitBtn');
    
    if (!file) {
        resetUploadForm();
        return;
    }
    
    selectedFile = file;
    
    if (uploadArea) uploadArea.style.display = 'none';
    if (selectedFilePreview) selectedFilePreview.style.display = 'block';
    
    const fileName = document.getElementById('selectedFileName');
    const fileSize = document.getElementById('selectedFileSize');
    const fileIcon = document.querySelector('.file-icon i');
    
    if (fileName) fileName.textContent = file.name;
    
    const sizeInKB = (file.size / 1024).toFixed(2);
    const sizeInMB = (file.size / (1024 * 1024)).toFixed(2);
    if (fileSize) fileSize.textContent = sizeInKB > 1024 ? `${sizeInMB} MB` : `${sizeInKB} KB`;
    
    if (fileIcon) {
        if (file.type === 'application/pdf') {
            fileIcon.className = 'fas fa-file-pdf fa-2x text-danger';
        } else if (file.type.startsWith('image/')) {
            fileIcon.className = 'fas fa-file-image fa-2x text-primary';
        } else {
            fileIcon.className = 'fas fa-file-alt fa-2x text-secondary';
        }
    }
    
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
    const fileValidation = document.getElementById('fileValidation');
    const validationMessage = document.getElementById('validationMessage');
    
    if (!allowedTypes.includes(file.type)) {
        if (validationMessage) validationMessage.textContent = 'Only JPEG, PNG, GIF images and PDF files are allowed';
        if (fileValidation) fileValidation.style.display = 'block';
        if (uploadSubmitBtn) uploadSubmitBtn.disabled = true;
        return;
    }
    
    if (file.size > 10 * 1024 * 1024) {
        if (validationMessage) validationMessage.textContent = 'File size must be less than 10MB';
        if (fileValidation) fileValidation.style.display = 'block';
        if (uploadSubmitBtn) uploadSubmitBtn.disabled = true;
        return;
    }
    
    if (fileValidation) fileValidation.style.display = 'none';
    if (uploadSubmitBtn) uploadSubmitBtn.disabled = false;
});

document.getElementById('uploadForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!selectedFile) {
        alert('Please select a file first');
        return;
    }
    
    const formData = new FormData();
    formData.append('file', selectedFile);
    
    const progressDiv = document.getElementById('uploadProgress');
    const progressBar = progressDiv?.querySelector('.progress-bar');
    const progressPercentage = document.querySelector('.progress-percentage');
    const uploadStatus = document.getElementById('uploadStatus');
    const uploadSubmitBtn = document.getElementById('uploadSubmitBtn');
    
    if (progressDiv) progressDiv.style.display = 'block';
    if (uploadSubmitBtn) {
        uploadSubmitBtn.disabled = true;
        uploadSubmitBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Uploading...';
    }
    
    try {
        const xhr = new XMLHttpRequest();
        xhr.withCredentials = true;
        
        xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable && progressBar && progressPercentage) {
                const percentComplete = Math.round((event.loaded / event.total) * 100);
                progressBar.style.width = `${percentComplete}%`;
                progressPercentage.textContent = `${percentComplete}%`;
                if (uploadStatus) uploadStatus.textContent = `Uploading... ${percentComplete}%`;
            }
        });
        
        const promise = new Promise((resolve, reject) => {
            xhr.onload = () => {
                if (xhr.status === 200 || xhr.status === 201) {
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch (e) {
                        reject(new Error('Invalid response from server'));
                    }
                } else {
                    reject(new Error(`Upload failed with status ${xhr.status}`));
                }
            };
            xhr.onerror = () => reject(new Error('Network error occurred'));
            xhr.onabort = () => reject(new Error('Upload cancelled'));
            
            xhr.open('POST', '/api/medical/upload');
            xhr.send(formData);
        });
        
        const data = await promise;
        
        if (progressBar) progressBar.style.width = '100%';
        if (progressPercentage) progressPercentage.textContent = '100%';
        if (uploadStatus) uploadStatus.textContent = 'Upload complete! Processing...';
        
        if (data.success) {
            showNotification('File uploaded successfully!', 'success');

            const modalElement = document.getElementById('uploadModal');
            if (modalElement) {
                const modal = bootstrap.Modal.getInstance(modalElement);
                if (modal) modal.hide();
            }

            resetUploadForm();

            const user = apiClient.authState.getUser();
            loadMedicalRecords(user?.id || user?._id);
        } else {
            throw new Error(data.message || 'Upload failed');
        }
        
    } catch (error) {
        console.error('Upload error:', error);
        showNotification(error.message || 'Error uploading file. Please try again.', 'error');
        if (uploadStatus) {
            uploadStatus.textContent = 'Upload failed. Please try again.';
            uploadStatus.style.color = '#ef4444';
        }
    } finally {
        setTimeout(() => {
            if (progressDiv) progressDiv.style.display = 'none';
            if (uploadSubmitBtn) {
                uploadSubmitBtn.disabled = false;
                uploadSubmitBtn.innerHTML = '<i class="fas fa-upload me-2"></i>Upload Record';
            }
            if (uploadStatus) uploadStatus.style.color = '';
            if (progressBar) progressBar.style.width = '0%';
            if (progressPercentage) progressPercentage.textContent = '0%';
        }, 1000);
    }
});

function setupDragAndDrop() {
    const uploadArea = document.getElementById('uploadArea');
    if (!uploadArea) return;
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, preventDefaults, false);
    });
    
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    ['dragenter', 'dragover'].forEach(eventName => {
        uploadArea.addEventListener(eventName, highlight, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, unhighlight, false);
    });
    
    function highlight(e) {
        uploadArea.classList.add('border-primary', 'bg-light');
    }
    
    function unhighlight(e) {
        uploadArea.classList.remove('border-primary', 'bg-light');
    }
    
    uploadArea.addEventListener('drop', handleDrop, false);
    
    function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        const fileInput = document.getElementById('medicalFile');
        
        if (files.length > 0 && fileInput) {
            fileInput.files = files;
            const event = new Event('change', { bubbles: true });
            fileInput.dispatchEvent(event);
        }
    }
}

function showSOSModal() {
    const modalElement = document.getElementById('sosModal');
    if (!modalElement) {
        triggerSOS();
        return;
    }

    if (window.bootstrap && typeof window.bootstrap.Modal === 'function') {
        const modal = new window.bootstrap.Modal(modalElement);
        modal.show();
    }
}

async function triggerSOS() {
    if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser');
        return;
    }

    const sosButton = document.querySelector('.action-card.sos, #quickEmergency');
    let originalText = '';
    if (sosButton) {
        originalText = sosButton.innerHTML;
        sosButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Triggering...';
        sosButton.style.opacity = '0.7';
        sosButton.style.pointerEvents = 'none';
    }

    navigator.geolocation.getCurrentPosition(async (position) => {
        const { latitude, longitude } = position.coords;
        const sosForm = document.getElementById('sosForm');
        const description = document.getElementById('sosDescription')?.value?.trim() || '';
        const allergies = document.getElementById('sosAllergies')?.value?.trim() || '';
        const triageNotes = document.getElementById('sosTriageNotes')?.value?.trim() || '';
        const heartRate = parseInt(document.getElementById('sosHeartRate')?.value, 10);
        const bloodPressure = document.getElementById('sosBloodPressure')?.value?.trim() || '';
        const respiratoryRate = parseInt(document.getElementById('sosRespiratoryRate')?.value, 10);
        const oxygenSaturation = parseInt(document.getElementById('sosOxygenSaturation')?.value, 10);

        const body = {
            latitude,
            longitude,
            priority: 'HIGH',
            type: 'MEDICAL',
            description,
            allergies,
            triageNotes,
            medicalHistorySummary: description || allergies || triageNotes ? `${description} ${allergies} ${triageNotes}`.trim() : '',
            vitals: {
                heartRate: Number.isFinite(heartRate) ? heartRate : undefined,
                bloodPressure: bloodPressure || undefined,
                respiratoryRate: Number.isFinite(respiratoryRate) ? respiratoryRate : undefined,
                oxygenSaturation: Number.isFinite(oxygenSaturation) ? oxygenSaturation : undefined,
            },
        };

        try {
            // FIXED: Use correct API endpoint - /api/emergency instead of /dispatch/request
            const data = await apiClient.post('/api/emergency', body);

            if (data.success) {
                showNotification('Emergency SOS triggered successfully! Help is on the way.', 'success');
                checkActiveEmergency();
                if (sosForm) {
                    sosForm.reset();
                }
                const modalElement = document.getElementById('sosModal');
                if (modalElement && window.bootstrap && typeof window.bootstrap.Modal === 'function') {
                    window.bootstrap.Modal.getInstance(modalElement)?.hide();
                }
            } else if (data.queued) {
                showNotification(data.message || 'Emergency queued offline and will retry when online.', 'warning');
                checkActiveEmergency();
            } else {
                showNotification(data.message || 'Error triggering SOS', 'error');
            }
        } catch (error) {
            console.error('Error triggering SOS:', error);
            showNotification(error.message || 'Error triggering SOS. Please try again.', 'error');
        } finally {
            if (sosButton) {
                sosButton.innerHTML = originalText;
                sosButton.style.opacity = '';
                sosButton.style.pointerEvents = '';
            }
        }
    }, (error) => {
        console.error('Geolocation error:', error);
        showNotification('Error getting your location. Please enable location services.', 'error');
        if (sosButton) {
            sosButton.innerHTML = originalText;
            sosButton.style.opacity = '';
            sosButton.style.pointerEvents = '';
        }
    });
}

async function checkActiveEmergency() {
    if (isCheckingActiveEmergency) {
        return;
    }

    isCheckingActiveEmergency = true;
    try {
        const data = await apiClient.get('/api/dispatch/active');
        const activeDiv = document.getElementById('activeEmergency');
        const cancelBtn = document.getElementById('cancelEmergencyBtn');

        if (data.data && data.data.status !== 'COMPLETED' && data.data.status !== 'CANCELLED') {
            if (activeDiv) activeDiv.style.display = 'flex';
            const statusText = `Status: ${data.data.status}${data.data.eta ? ` | ETA: ${data.data.eta} min` : ''}`;
            const emergencyStatus = document.getElementById('emergencyStatus');
            if (emergencyStatus) emergencyStatus.textContent = statusText;

            const cancellableStatuses = ['PENDING', 'ASSIGNED'];
            if (cancelBtn) {
                cancelBtn.style.display = cancellableStatuses.includes(data.data.status) ? 'inline-block' : 'none';
                cancelBtn.disabled = false;
                cancelBtn.innerHTML = '<i class="fas fa-times me-1"></i>Cancel Request';
            }

            window.activeEmergencyId = data.data._id;

            if (socket && data.data._id) socket.emit('join', { requestId: data.data._id });
        } else {
            if (activeDiv) activeDiv.style.display = 'none';
            if (cancelBtn) cancelBtn.style.display = 'none';
            window.activeEmergencyId = null;
        }
    } catch (error) {
        console.error('Error checking active emergency:', error);
        // If 404, no active emergency
        if (error.status === 404) {
            const activeDiv = document.getElementById('activeEmergency');
            if (activeDiv) activeDiv.style.display = 'none';
            window.activeEmergencyId = null;
        }
    } finally {
        isCheckingActiveEmergency = false;
    }
}

async function viewEmergencyHistory() {
    try {
        const data = await apiClient.get('/api/emergency/history');
        if (data.success) {
            displayEmergencyHistory(data.data);
            const modalElement = document.getElementById('historyModal');
            if (modalElement) {
                preserveModalTriggerFocus(modalElement);
                const modal = new bootstrap.Modal(modalElement);
                modal.show();
            }
        }
    } catch (error) {
        console.error('Error loading history:', error);
        showNotification('Error loading history', 'error');
    }
}

function displayEmergencyHistory(history) {
    const container = document.getElementById('emergencyHistory');
    if (!container) return;
    
    if (!history || history.length === 0) {
        container.innerHTML = '<p class="text-center text-muted">No emergency history found.</p>';
        return;
    }

    let html = '<div class="list-group">';
    history.forEach(item => {
        const date = new Date(item.requestTime || item.createdAt).toLocaleString();
        html += `
            <div class="list-group-item">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <h6 class="mb-1">Emergency Request - ${item.type || 'MEDICAL'}</h6>
                        <small>${date}</small>
                        ${item.location?.coordinates ? `<br><small>Location: ${item.location.coordinates[1].toFixed(4)}, ${item.location.coordinates[0].toFixed(4)}</small>` : ''}
                    </div>
                    <span class="badge bg-${getStatusColor(item.status)}">${item.status}</span>
                </div>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;
}

function getStatusColor(status) {
    switch(status) {
        case 'PENDING': return 'warning';
        case 'ASSIGNED': return 'info';
        case 'EN_ROUTE': return 'primary';
        case 'COMPLETED': return 'success';
        case 'CANCELLED': return 'danger';
        default: return 'secondary';
    }
}

function showNotification(message, type) {
    const notification = document.createElement('div');
    const bgColor = type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#f59e0b';
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 9999;
        min-width: 300px;
        padding: 1rem 1.5rem;
        background: ${bgColor};
        color: white;
        border-radius: 12px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.1);
        animation: slideIn 0.3s ease-out;
        font-weight: 500;
        cursor: pointer;
    `;
    notification.innerHTML = `
        <div class="d-flex align-items-center">
            <i class="fas ${type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle'} me-2"></i>
            <span>${message}</span>
        </div>
    `;
    
    notification.onclick = () => {
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
    };
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        if (notification.parentNode) {
            notification.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => notification.remove(), 300);
        }
    }, 5000);
}

function toggleProfileMenu() {
    console.log('Profile menu clicked');
}

async function cancelEmergency() {
    if (!window.activeEmergencyId) {
        showNotification('No active emergency to cancel', 'error');
        return;
    }

    if (!confirm('Are you sure you want to cancel this emergency request? This action cannot be undone.')) {
        return;
    }

    try {
        const cancelBtn = document.getElementById('cancelEmergencyBtn');
        if (cancelBtn) {
            cancelBtn.disabled = true;
            cancelBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i>Cancelling...';
        }

        // FIXED: Use correct API endpoint
        const response = await apiClient.delete(`/api/emergency/${window.activeEmergencyId}`);
        
        if (response.success) {
            showNotification('Emergency request cancelled successfully', 'success');
            checkActiveEmergency();
        } else {
            throw new Error(response.message || 'Failed to cancel request');
        }
    } catch (error) {
        console.error('Error cancelling emergency:', error);
        showNotification(error.message || 'Failed to cancel emergency request', 'error');
        
        const cancelBtn = document.getElementById('cancelEmergencyBtn');
        if (cancelBtn) {
            cancelBtn.disabled = false;
            cancelBtn.innerHTML = '<i class="fas fa-times me-1"></i>Cancel Request';
        }
    }
}

const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(100%);
            opacity: 0;
        }
    }
    
    .modal {
        pointer-events: auto !important;
    }
    
    .modal-backdrop {
        pointer-events: none !important;
    }
`;
document.head.appendChild(style);