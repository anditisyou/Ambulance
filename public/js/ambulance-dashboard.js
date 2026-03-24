let refreshInterval;

// role constants
const ROLES = {
    CITIZEN: 'CITIZEN',
    DRIVER: 'DRIVER',
    HOSPITAL: 'HOSPITAL',
    ADMIN: 'ADMIN',
    DISPATCHER: 'DISPATCHER'
};

// statuses mirror server constants (would ideally be fetched from API)
const STATUS = {
    PENDING: 'PENDING',
    ASSIGNED: 'ASSIGNED',
    EN_ROUTE: 'EN_ROUTE',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED'
};

// Check authentication
document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user'));
    
    if (!token || !user || user.role !== ROLES.DRIVER) {
        window.location.href = '/';
        return;
    }
    
    // Display ambulance name
    document.getElementById('ambulanceName').textContent = `Welcome, ${user.name}`;
    
    // Load active missions
    loadActiveMissions();
    
    // Set up auto-refresh every 5 seconds
    refreshInterval = setInterval(loadActiveMissions, 5000);
});

// Clean up interval on page unload
window.addEventListener('beforeunload', () => {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
});

// Load active missions
async function loadActiveMissions() {
    const token = localStorage.getItem('token');
    
    try {
        const response = await fetch('/api/dispatch/assignments', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            displayMissions(data.data);
            updateStatistics(data.data);
        }
    } catch (error) {
        console.error('Error loading missions:', error);
    }
}

// Display missions in table
function displayMissions(requests) {
    const tbody = document.getElementById('missionsTableBody');
    
    if (!requests || requests.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center">No active missions found</td></tr>';
        return;
    }
    
    let html = '';
    requests.forEach(request => {
        const time = new Date(request.createdAt).toLocaleString();
        const hospitalName = request.assignedHospital ? request.assignedHospital.name : 'Pending';
        
        html += `
            <tr>
                <td>${time}</td>
                <td>${request.userName}</td>
                <td>${request.userPhone}</td>
                <td>
                    <button class="btn btn-sm btn-info" onclick="viewLocation(${request.location.coordinates[1]}, ${request.location.coordinates[0]})">
                        View Location
                    </button>
                </td>
                <td>${hospitalName}</td>
                <td><span class="badge badge-success">${request.status}</span></td>
                <td>
                    ${request.status === STATUS.ASSIGNED ? 
                        `
                        <button class="btn btn-sm btn-primary" onclick="respondToAssignment('${request._id}', true)">Accept</button>
                        <button class="btn btn-sm btn-warning" onclick="respondToAssignment('${request._id}', false)">Reject</button>
                        ` : request.status === STATUS.EN_ROUTE ? 
                        `<button class="btn btn-sm btn-success" onclick="completeMission('${request._id}')">
                            Complete Mission
                        </button>` : 
                        'N/A'}
                </td>
            </tr>
        `;
    });
    
    tbody.innerHTML = html;
}

// Update statistics
function updateStatistics(requests) {
    const active = requests.length;
    const completed = requests.filter(r => r.status === 'COMPLETED').length;
    
    document.getElementById('activeMissions').textContent = active;
    document.getElementById('completedToday').textContent = completed;
}

// View location
function viewLocation(latitude, longitude) {
    document.getElementById('coordinates').innerHTML = `
        <p><strong>Latitude:</strong> ${latitude}</p>
        <p><strong>Longitude:</strong> ${longitude}</p>
        <a href="https://www.google.com/maps?q=${latitude},${longitude}" target="_blank" class="btn btn-primary">
            Open in Google Maps
        </a>
    `;
    $('#locationModal').modal('show');
}

// Driver response (accept/reject) to an assignment
async function respondToAssignment(requestId, accept) {
    const token = localStorage.getItem('token');
    try {
        const response = await fetch(`/api/dispatch/${requestId}/response`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ accept })
        });
        const data = await response.json();
        if (data.success) {
            alert(accept ? 'Assignment accepted' : 'Assignment rejected');
            loadActiveMissions();
        } else {
            alert(data.message);
        }
    } catch (err) {
        alert('Error responding to assignment');
    }
}

// Complete mission
async function completeMission(requestId) {
    if (!confirm('Are you sure you want to mark this mission as completed?')) {
        return;
    }
    
    const token = localStorage.getItem('token');
    
    try {
        const response = await fetch(`/api/emergency/${requestId}/complete`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('Mission completed successfully');
            loadActiveMissions(); // Refresh immediately
        } else {
            alert(data.message);
        }
    } catch (error) {
        alert('Error completing mission');
    }
}