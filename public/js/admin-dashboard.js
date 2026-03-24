// client-side roles mirror server constants
// ✅ CORRECT — matches what server saves to DB
const ROLES = {
    CITIZEN: 'CITIZEN',
    DRIVER: 'DRIVER',
    HOSPITAL: 'HOSPITAL',
    ADMIN: 'ADMIN',
    DISPATCHER: 'DISPATCHER'
};
document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('token');
    const user = JSON.parse(localStorage.getItem('user'));
    if (!token || !user || user.role !== ROLES.ADMIN) {
        window.location.href = '/';
        return;
    }
    document.getElementById('adminWelcome').textContent = `Welcome, ${user.name}`;
    loadMetrics();
    loadEntities();
});

async function loadMetrics() {
    const token = localStorage.getItem('token');
    try {
        const res = await fetch('/api/analytics/latency', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('metrics').innerHTML =
                `<pre>${JSON.stringify(data.data, null, 2)}</pre>`;
        }
    } catch (err) {
        console.error(err);
    }
}

async function loadEntities() {
    const token = localStorage.getItem('token');
    try {
        const usersRes = await fetch('/api/users', { headers: { 'Authorization': `Bearer ${token}` } });
        const ambRes = await fetch('/api/ambulances', { headers: { 'Authorization': `Bearer ${token}` } });
        const users = await usersRes.json();
        const ambs = await ambRes.json();
        const container = document.getElementById('entities');
        container.innerHTML = `<h5>Users</h5><pre>${JSON.stringify(users.data, null, 2)}</pre>
            <h5>Ambulances</h5><pre>${JSON.stringify(ambs.data, null, 2)}</pre>`;
    } catch (err) {
        console.error(err);
    }
}
