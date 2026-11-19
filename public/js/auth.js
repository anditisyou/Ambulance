// Load constants from server
async function loadConstants() {
    try {
        const response = await apiClient.get('/api/constants');
        if (response.success) {
            window.CONSTANTS = response.data;
            console.log('Constants loaded:', window.CONSTANTS);
        }
    } catch (error) {
        console.error('Failed to load constants:', error);
    }
}

const isLandingPage = () => {
    const path = window.location.pathname.replace(/\/+$/, '');
    return path === '' || path === '/' || path === '/index.html';
};

// Check if user is already logged in
document.addEventListener('DOMContentLoaded', async function() {
    if (isLandingPage()) {
        await loadConstants();
        const user = apiClient.authState.getUser();

        if (user) {
            try {
                const response = await apiClient.get('/api/auth/me');
                if (response.success) {
                    redirectToDashboard(user.role);
                    return;
                }
            } catch (error) {
                apiClient.authState.clear();
            }
        }
    }

    const registerPassword = document.getElementById('registerPassword');
    const strengthBar = document.getElementById('passwordStrength');
    if (registerPassword && strengthBar) {
        registerPassword.addEventListener('input', function(e) {
            const password = e.target.value;
            if (password.length === 0) {
                strengthBar.style.width = '0';
                strengthBar.className = 'password-strength-bar';
            } else if (password.length < 8) {
                strengthBar.style.width = '33%';
                strengthBar.className = 'password-strength-bar weak';
            } else if (password.length < 12) {
                strengthBar.style.width = '66%';
                strengthBar.className = 'password-strength-bar medium';
            } else {
                strengthBar.style.width = '100%';
                strengthBar.className = 'password-strength-bar strong';
            }
        });
    }

    const authTabs = document.querySelectorAll('#authTabs .nav-link');
    const authPanes = document.querySelectorAll('.tab-pane');

    if (authTabs.length && authPanes.length) {
        const activateTab = (targetId) => {
            const normalizedTarget = targetId.startsWith('#') ? targetId : `#${targetId}`;
            const targetPane = document.querySelector(normalizedTarget);
            if (!targetPane) return;

            authTabs.forEach((item) => item.classList.remove('active'));
            authPanes.forEach((pane) => {
                pane.classList.remove('show', 'active');
            });

            const matchingTab = document.querySelector(`#authTabs .nav-link[href="${normalizedTarget}"]`);
            if (matchingTab) {
                matchingTab.classList.add('active');
            }

            targetPane.classList.add('show', 'active');
        };

        authTabs.forEach((tab) => {
            tab.addEventListener('click', function(event) {
                event.preventDefault();
                const targetId = tab.getAttribute('href');
                if (!targetId) return;
                activateTab(targetId);
                window.history.replaceState(null, '', targetId);
            });
        });

        const initialHash = window.location.hash || '#login';
        activateTab(initialHash);
    }
});

// Verify token with server
async function verifyToken(token, user) {
    try {
        const response = await apiClient.get('/api/auth/me');

        if (response.success) {
            redirectToDashboard(user.role);
        } else {
            apiClient.authState.clear();
        }
    } catch (error) {
        console.error('Token verification failed:', error);
        apiClient.authState.clear();
    }
}

// Login form handler
const loginForm = document.getElementById('loginForm');
if (loginForm) {
    loginForm.addEventListener('submit', async function(e) {
        e.preventDefault();

        const submitButton = loginForm.querySelector('button[type="submit"]');
        const credential = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        
        if (!credential || !password) {
            showMessage('Please enter email/phone and password', 'danger');
            return;
        }
        
        const payload = { password };
        // Check if credential is phone (starts with + or contains only digits)
        if (/^\+?[0-9]{7,15}$/.test(credential.replace(/[\s\-]/g, ''))) {
            payload.phone = credential;
        } else {
            payload.email = credential;
        }

        try {
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.setAttribute('aria-busy', 'true');
                submitButton.dataset.originalMarkup = submitButton.innerHTML;
                submitButton.textContent = 'Signing in...';
            }
            const data = await apiClient.post('/api/auth/login', payload);
            apiClient.authState.setUser(data.user, data.token);

            showMessage('Login successful! Redirecting...', 'success');
            setTimeout(() => redirectToDashboard(data.user.role), 1000);
        } catch (error) {
            showMessage(error.message || 'Login failed', 'danger');
        } finally {
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.removeAttribute('aria-busy');
                submitButton.innerHTML = submitButton.dataset.originalMarkup || 'Login';
            }
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
        
        if (!name || !email || !phone || !role || !password) {
            showMessage('All fields are required', 'danger');
            return;
        }
        
        if (password !== confirmPassword) {
            showMessage('Passwords do not match', 'danger');
            return;
        }
        
        if (password.length < 8) {
            showMessage('Password must be at least 8 characters', 'danger');
            return;
        }
        
        try {
            const data = await apiClient.post('/api/auth/register', {
                name,
                email,
                phone,
                role,
                password,
            });

            apiClient.authState.setUser(data.user, data.token);
            showMessage('Registration successful! Redirecting...', 'success');
            setTimeout(() => redirectToDashboard(data.user.role), 1000);
        } catch (error) {
            showMessage(error.message || 'Registration failed', 'danger');
        }
    });
}

// Helper function to show messages
function showMessage(message, type) {
    const messageDiv = document.getElementById('message');
    if (messageDiv) {
        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;
        alert.setAttribute('role', type === 'danger' ? 'alert' : 'status');
        alert.textContent = String(message || 'Something went wrong.');
        messageDiv.replaceChildren(alert);
        messageDiv.style.display = 'block';
        setTimeout(() => {
            messageDiv.style.display = 'none';
        }, 3000);
    }
}

// Helper function to redirect based on role
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

// Logout function
function logout() {
    apiClient.authState.clear();
    apiClient.post('/api/auth/logout').finally(() => {
        window.location.href = '/';
    });
}
