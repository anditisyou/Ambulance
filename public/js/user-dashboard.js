// role constants used client-side (mirrors server utils/constants.js)
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
    
    if (!token || !user || user.role !== ROLES.CITIZEN) {
        window.location.href = '/';
        return;
    }
    
    // Display user name
    document.getElementById('userName').textContent = `Welcome, ${user.name}`;
    
    // Load medical records
    loadMedicalRecords(user.id);
    
    // Check for active emergency
    checkActiveEmergency();
});

// Load medical records
async function loadMedicalRecords(userId) {
    const token = localStorage.getItem('token');
    
    try {
        const response = await fetch(`/api/medical/${userId}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            displayMedicalRecords(data.data);
        }
    } catch (error) {
        console.error('Error loading medical records:', error);
    }
}

// Display medical records
function displayMedicalRecords(records) {
    const container = document.getElementById('medicalRecords');
    
    if (!records || records.length === 0) {
        container.innerHTML = '<p class="text-muted">No medical records found.</p>';
        return;
    }
    
    let html = '';
    records.forEach(record => {
        html += `
            <div class="col-md-4 mb-3">
                <div class="card">
                    <div class="card-body">
                        <h6 class="card-title">${record.fileName}</h6>
                        <p class="card-text">Uploaded: ${new Date(record.createdAt).toLocaleDateString()}</p>
                        <a href="${record.fileUrl}" target="_blank" class="btn btn-sm btn-primary">View</a>
                    </div>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

// Show upload modal
function showUploadModal() {
    $('#uploadModal').modal('show');
}

// Handle file upload
document.getElementById('uploadForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const fileInput = document.getElementById('medicalFile');
    const file = fileInput.files[0];
    
    if (!file) {
        alert('Please select a file');
        return;
    }
    
    const formData = new FormData();
    formData.append('file', file);
    
    const token = localStorage.getItem('token');
    
    // Show progress bar
    const progressDiv = document.getElementById('uploadProgress');
    const progressBar = progressDiv.querySelector('.progress-bar');
    progressDiv.style.display = 'block';
    
    try {
        const response = await fetch('/api/medical/upload', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('File uploaded successfully');
            $('#uploadModal').modal('hide');
            
            // Reload medical records
            const user = JSON.parse(localStorage.getItem('user'));
            loadMedicalRecords(user.id);
        } else {
            alert(data.message);
        }
    } catch (error) {
        alert('Error uploading file');
    } finally {
        progressDiv.style.display = 'none';
        progressBar.style.width = '0%';
        fileInput.value = '';
    }
});

// Trigger SOS
async function triggerSOS() {
    if (!confirm('Are you sure you want to trigger an emergency SOS? This will notify hospitals immediately.')) {
        return;
    }
    
    // Get user location
    if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser');
        return;
    }
    
    navigator.geolocation.getCurrentPosition(async (position) => {
        const { latitude, longitude } = position.coords;
        
        const token = localStorage.getItem('token');
        const user = JSON.parse(localStorage.getItem('user'));
        
        try {
            const response = await fetch('/api/dispatch/request', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ latitude, longitude })
            });
            
            const data = await response.json();
            
            if (data.success) {
                alert('Emergency SOS triggered successfully');
                checkActiveEmergency();
            } else {
                alert(data.message);
            }
        } catch (error) {
            alert('Error triggering SOS');
        }
    }, (error) => {
        alert('Error getting your location. Please enable location services.');
    });
}

// Check for active emergency
async function checkActiveEmergency() {
    const token = localStorage.getItem('token');
    try {
        const response = await fetch(`/api/dispatch/active`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            const data = await response.json();
            if (data.data) {
                document.getElementById('activeEmergency').style.display = 'block';
                document.getElementById('emergencyStatus').textContent = 
                    `Status: ${data.data.status}`;

                // subscribe to socket updates for this request
                const socket = io();
                socket.emit('join', { requestId: data.data._id });
                socket.on('statusUpdate', (req) => {
                    document.getElementById('emergencyStatus').textContent = `Status: ${req.status}`;
                });
                socket.on('locationUpdate', (loc) => {
                    // TODO: update map marker
                    console.log('location update', loc);
                });
            }
        }
    } catch (error) {
        console.error('Error checking active emergency:', error);
    }
}