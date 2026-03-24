// Check if user is already logged in
document.addEventListener('DOMContentLoaded', function() {
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user'));
    
    if (token && user) {
        redirectToDashboard(user.role);
    }
});

// Login form handler
const loginForm = document.getElementById('loginForm');
if (loginForm) {
    loginForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const credential = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        
        // decide if credential is phone or email
        const payload = { password };
        // ✅ CORRECT — matches 10 digits, or + followed by 7-15 digits
        if (/^\+?[0-9]{7,15}$/.test(credential.replace(/[\s\-]/g, ''))) {
            payload.phone = credential;
        } else {
            payload.email = credential;
        }

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            
            const data = await response.json();
            
            if (data.success) {
                // Save token and user data
                localStorage.setItem('token', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));
                
                // Show success message
                showMessage('Login successful! Redirecting...', 'success');
                
                // Redirect based on role
                setTimeout(function() {
                    redirectToDashboard(data.user.role);
                }, 1000);
            } else {
                showMessage(data.message, 'danger');
            }
        } catch (error) {
            showMessage('Error connecting to server', 'danger');
        }
    });
}

// Register form handler
const registerForm = document.getElementById('registerForm');
if (registerForm) {
    registerForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const name = document.getElementById('registerName').value;
        const email = document.getElementById('registerEmail').value;
        const phone = document.getElementById('registerPhone').value;
        const role = document.getElementById('registerRole').value;
        const password = document.getElementById('registerPassword').value;
        const confirmPassword = document.getElementById('registerConfirmPassword').value;
        
        // Validate passwords match
        if (password !== confirmPassword) {
            showMessage('Passwords do not match', 'danger');
            return;
        }
        
        try {
            const response = await fetch('/api/register', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name, email, phone, role, password })
            });
            
            const data = await response.json();
            
            if (data.success) {
                // Save token and user data
                localStorage.setItem('token', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));
                
                // Show success message
                showMessage('Registration successful! Redirecting...', 'success');
                
                // Redirect based on role
                setTimeout(function() {
                    redirectToDashboard(data.user.role);
                }, 1000);
            } else {
                showMessage(data.message, 'danger');
            }
        } catch (error) {
            showMessage('Error connecting to server', 'danger');
        }
    });
}

// Helper function to show messages
function showMessage(message, type) {
    const messageDiv = document.getElementById('message');
    if (messageDiv) {
        messageDiv.innerHTML = '<div class="alert alert-' + type + '">' + message + '</div>';
    }
}

// Helper function to redirect based on role
// ✅ CORRECT
function redirectToDashboard(role) {
    switch(role) {
        case 'CITIZEN':     window.location.href = '/user-dashboard'; break;
        case 'HOSPITAL':    window.location.href = '/hospital-dashboard'; break;
        case 'DRIVER':      window.location.href = '/ambulance-dashboard'; break;
        case 'ADMIN':       window.location.href = '/admin-dashboard'; break;
        case 'DISPATCHER':  window.location.href = '/admin-dashboard'; break;
        default:            window.location.href = '/';
    }
}

// Logout function (used across dashboards)
function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/';
}