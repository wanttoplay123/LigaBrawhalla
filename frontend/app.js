const API_URL = '/api';

function getToken() {
  return localStorage.getItem('token');
}

function isLoggedIn() {
  return !!getToken();
}

function getRole() {
  return localStorage.getItem('role');
}

function getUsername() {
  return localStorage.getItem('username');
}

function getBrawlhallaId() {
  return localStorage.getItem('brawlhalla_id');
}

function setSession(token, username, role, brawlhallaId) {
  localStorage.setItem('token', token);
  localStorage.setItem('username', username);
  localStorage.setItem('role', role);
  if (brawlhallaId) localStorage.setItem('brawlhalla_id', brawlhallaId);
}

function logout() {
  localStorage.clear();
  window.location.href = 'login.html';
}

function updateNav() {
  const loggedIn = isLoggedIn();
  const username = getUsername();
  const role = getRole();

  document.querySelectorAll('.nav-auth-hide').forEach(el => {
    el.style.display = loggedIn ? 'none' : '';
  });
  document.querySelectorAll('.nav-auth-show').forEach(el => {
    el.style.display = loggedIn ? '' : 'none';
  });
  document.querySelectorAll('.nav-auth-username').forEach(el => {
    el.textContent = username || '';
  });
  document.querySelectorAll('.nav-auth-admin').forEach(el => {
    el.style.display = (loggedIn && role === 'admin') ? '' : 'none';
  });
  document.querySelectorAll('.nav-auth-player').forEach(el => {
    el.style.display = (loggedIn && role === 'player') ? '' : 'none';
  });
  document.querySelectorAll('.nav-auth-logout').forEach(el => {
    el.style.display = loggedIn ? '' : 'none';
    el.onclick = (e) => { e.preventDefault(); logout(); };
  });
  document.querySelectorAll('.nav-auth-link').forEach(el => {
    const page = el.dataset.page;
    if (page === 'admin') {
      el.href = (loggedIn && role === 'admin') ? 'admin.html' : 'login.html';
      el.textContent = (loggedIn && role === 'admin') ? 'PANEL ADMIN' : 'INICIAR SESIÓN';
    } else if (page === 'login') {
      el.href = loggedIn ? '#' : 'login.html';
      el.textContent = loggedIn ? 'CERRAR SESIÓN' : 'INICIAR SESIÓN';
      if (loggedIn) el.onclick = (e) => { e.preventDefault(); logout(); };
    } else if (page === 'register') {
      el.style.display = loggedIn ? 'none' : '';
    }
  });
}

async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok && data.error === 'Invalid token') {
    logout();
  }
  return { ok: res.ok, data, status: res.status };
}

async function register(username, brawlhallaId, password) {
  return apiFetch('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, brawlhalla_id: parseInt(brawlhallaId) })
  });
}

async function login(username, password) {
  const { ok, data } = await apiFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  if (ok && data.token) {
    setSession(data.token, data.username, data.role, data.brawlhalla_id);
  }
  return { ok, data };
}

function showNotification(message, type = 'info') {
  const existing = document.querySelector('.notification');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.className = `notification notification-${type}`;
  div.textContent = message;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}
