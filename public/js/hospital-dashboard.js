let refreshInterval;

// mirror server status constants for client use
const STATUS = {
    PENDING: 'PENDING',
    ASSIGNED: 'ASSIGNED',
    EN_ROUTE: 'EN_ROUTE',
    ACCEPTED: 'ACCEPTED',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED'
};

// role constants
const ROLES = {
    CITIZEN: 'CITIZEN',
    DRIVER: 'DRIVER',
    HOSPITAL: 'HOSPITAL',
    ADMIN: 'ADMIN',
    DISPATCHER: 'DISPATCHER'
};

// Check authentication
document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user'));
    
    if (!token || !user || user.role !== ROLES.HOSPITAL) {
        window.location.href = '/';
        return;
    }
    
    // Display hospital name
    document.getElementById('hospitalName').textContent = `Welcome, ${user.name}`;
    
    // Load emergency requests
    loadEmergencyRequests();
    
    // Set up auto-refresh every 5 seconds
    refreshInterval = setInterval(loadEmergencyRequests, 5000);
});

// Clean up interval on page unload
window.addEventListener('beforeunload', () => {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
});

// Load emergency requests
async function loadEmergencyRequests() {
    const token = localStorage.getItem('token');
    
    try {
        const response = await fetch('/api/emergency', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            displayEmergencyRequests(data.data);
            updateStatistics(data.data);
        }
    } catch (error) {
        console.error('Error loading emergency requests:', error);
    }
}

// Display emergency requests in table
function displayEmergencyRequests(requests) {
    const tbody = document.getElementById('emergencyTableBody');
    
    if (!requests || requests.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center">No emergency requests found</td></tr>';
        return;
    }
    
    let html = '';
    requests.forEach(request => {
        const time = new Date(request.createdAt).toLocaleString();
        const coords = request.location && request.location.coordinates ? request.location.coordinates : [0,0];
        const location = `Lat: ${coords[1].toFixed(4)}, Lng: ${coords[0].toFixed(4)}`;
        
        html += `
            <tr>
                <td>${time}</td>
                <td>${request.userName}</td>
                <td>${request.userPhone}</td>
                <td>${location}</td>
                <td><span class="badge badge-${getStatusBadge(request.status)}">${request.status}</span></td>
                <td>
                    <button class="btn btn-sm btn-info" onclick="viewMedicalHistory('${request.userId._id}')">
                        View History
                    </button>
                </td>
                <td>
                    ${request.status === STATUS.PENDING ? 
                        `<button class="btn btn-sm btn-success" onclick="acceptRequest('${request._id}')">Accept</button>` : 
                        'N/A'}
                </td>
            </tr>
        `;
    });
    
    tbody.innerHTML = html;
}

// Get badge class based on status
function getStatusBadge(status) {
    switch(status) {
        case STATUS.PENDING: return 'warning';
        case STATUS.ACCEPTED: return 'success';
        case STATUS.COMPLETED: return 'info';
        default: return 'secondary';
    }
}

// Update statistics
function updateStatistics(requests) {
    const pending = requests.filter(r => r.status === STATUS.PENDING).length;
    const accepted = requests.filter(r => r.status === 'ACCEPTED').length;
    const completed = requests.filter(r => r.status === 'COMPLETED').length;
    
    document.getElementById('pendingCount').textContent = pending;
    document.getElementById('acceptedCount').textContent = accepted;
    document.getElementById('completedCount').textContent = completed;
}

// Accept emergency request
async function acceptRequest(requestId) {
    if (!confirm('Are you sure you want to accept this emergency request?')) {
        return;
    }
    
    const token = localStorage.getItem('token');
    
    try {
        const response = await fetch(`/api/emergency/${requestId}/accept`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('Request accepted successfully');
            loadEmergencyRequests(); // Refresh immediately
        } else {
            alert(data.message);
        }
    } catch (error) {
        alert('Error accepting request');
    }
}

// View medical history
async function viewMedicalHistory(userId) {
    const token = localStorage.getItem('token');
    
    try {
        const response = await fetch(`/api/medical/${userId}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            displayMedicalHistory(data.data);
            $('#medicalHistoryModal').modal('show');
        } else {
            alert('Error loading medical history');
        }
    } catch (error) {
        alert('Error loading medical history');
    }
}

// Display medical history in modal
function displayMedicalHistory(records) {
    const container = document.getElementById('medicalHistoryContent');
    
    if (!records || records.length === 0) {
        container.innerHTML = '<p class="text-muted">No medical records found for this patient.</p>';
        return;
    }
    
    let html = '<div class="list-group">';
    records.forEach(record => {
        html += `
            <div class="list-group-item">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <h6>${record.fileName}</h6>
                        <small>Uploaded: ${new Date(record.createdAt).toLocaleDateString()}</small>
                    </div>
                    <a href="${record.fileUrl}" target="_blank" class="btn btn-sm btn-primary">View</a>
                </div>
            </div>
        `;
    });
    html += '</div>';
    
    container.innerHTML = html;
}