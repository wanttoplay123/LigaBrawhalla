const API_URL = '/api';

// ── CANVAS PARTICLES INJECTION ──
function initParticles() {
  if (document.getElementById('particles-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'particles-canvas';
  document.body.prepend(canvas);
  
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];
  const NUM = 55;

  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  resize(); window.addEventListener('resize', resize);

  function rand(a, b) { return a + Math.random() * (b - a); }

  class Particle {
    constructor() {
      this.x = rand(0, W); this.y = rand(0, H);
      this.r = rand(0.6, 2.2);
      this.vx = rand(-0.25, 0.25); this.vy = rand(-0.4, -0.08);
      const colors = ['rgba(168,85,247,', 'rgba(255,215,0,', 'rgba(6,182,212,', 'rgba(255,255,255,'];
      this.color = colors[Math.floor(Math.random() * colors.length)];
      this.alpha = rand(0.15, 0.55);
      this.life = rand(0.003, 0.007);
    }
    draw() {
      ctx.beginPath(); ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
      ctx.fillStyle = this.color + this.alpha + ')'; ctx.fill();
    }
    update() {
      this.x += this.vx; this.y += this.vy;
      this.alpha -= this.life;
      if (this.alpha <= 0 || this.y < -10) { Object.assign(this, new Particle()); this.y = H + 5; this.alpha = rand(0.15, 0.5); }
    }
  }

  for (let i = 0; i < NUM; i++) { const p = new Particle(); p.y = rand(0, H); particles.push(p); }

  function loop() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => { p.update(); p.draw(); });
    requestAnimationFrame(loop);
  }
  loop();
}

// ── GLOBAL ANIMATION ORCHESTRATOR ──
function initGlobalAnimations() {
  // Apply reveal class to generic containers if they don't have it
  if (window.location.pathname.indexOf('index.html') === -1) {
    document.querySelectorAll('.page-section > div, .standings-table, .match-card, .player-profile, .auth-card, .section-header').forEach((el, index) => {
      if (!el.classList.contains('reveal')) {
        el.classList.add('reveal');
        if (index % 3 === 1) el.classList.add('reveal-delay-1');
        if (index % 3 === 2) el.classList.add('reveal-delay-2');
      }
    });
  }

  const revealObs = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); revealObs.unobserve(e.target); } });
  }, { threshold: 0.1 });
  
  document.querySelectorAll('.reveal').forEach(el => revealObs.observe(el));
}

document.addEventListener('DOMContentLoaded', () => {
  initParticles();
  initGlobalAnimations();
});

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

function getPlayerId() {
  const id = localStorage.getItem('player_id');
  return id ? parseInt(id) : null;
}

function setSession(token, username, role, playerId, brawlhallaId) {
  localStorage.setItem('token', token);
  localStorage.setItem('username', username);
  localStorage.setItem('role', role);
  if (playerId) localStorage.setItem('player_id', playerId);
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
    setSession(data.token, data.username, data.role, data.player_id, data.brawlhalla_id);
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

/* ── MOBILE MENU: close on link click ── */
document.addEventListener('DOMContentLoaded', () => {
  const mobileMenu = document.getElementById('mobileMenu');
  if (mobileMenu) {
    mobileMenu.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        mobileMenu.classList.remove('open');
        const ham = document.getElementById('hamburger');
        if (ham) {
          ham.children[0].style.transform = '';
          ham.children[1].style.opacity = '';
          ham.children[2].style.transform = '';
        }
        document.body.style.overflow = '';
      });
    });
  }
});
