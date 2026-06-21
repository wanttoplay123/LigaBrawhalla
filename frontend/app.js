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
function initScrollProgress() {
  if (document.querySelector('.scroll-progress')) return;
  const bar = document.createElement('div');
  bar.className = 'scroll-progress';
  document.body.appendChild(bar);

  const update = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pct = max > 0 ? (window.scrollY / max) * 100 : 0;
    bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  };

  update();
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
}

function initGlobalAnimations() {
  // Apply reveal class to generic containers if they don't have it
  if (window.location.pathname.indexOf('index.html') === -1) {
    document.querySelectorAll('.page-section > div, .standings-table, .match-card, .player-profile, .auth-card, .section-header, .admin-card, .tournament-card, .group-card, .t-match-card, .player-card-sm, .hof-card, .hof-stat').forEach((el, index) => {
      if (!el.classList.contains('reveal')) {
        el.classList.add('reveal');
        el.style.setProperty('--reveal-index', index % 8);
        if (index % 4 === 1) el.classList.add('reveal-delay-1');
        if (index % 4 === 2) el.classList.add('reveal-delay-2');
        if (index % 4 === 3) el.classList.add('reveal-delay-3');
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
  initScrollProgress();
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

/* ── MOBILE MENU: toggle ── */
function toggleMenu() {
  const menu = document.getElementById('mobileMenu');
  const ham = document.getElementById('hamburger');
  if (!menu || !ham) return;
  const open = menu.classList.toggle('open');
  ham.children[0].style.transform = open ? 'rotate(45deg) translate(5px,5px)' : '';
  ham.children[1].style.opacity = open ? '0' : '1';
  ham.children[2].style.transform = open ? 'rotate(-45deg) translate(5px,-5px)' : '';
  document.body.style.overflow = open ? 'hidden' : '';
}

/* ══════════════════════════════════════════════════════════════════
   SPA ROUTER — AJAX page transitions with History API
   ══════════════════════════════════════════════════════════════════ */
(function () {
  if (window.__spaInit) return;
  window.__spaInit = true;

  /* ── Interval / Timeout tracking for per-page cleanup ── */
  var _origSetInterval = window.setInterval;
  var _origClearInterval = window.clearInterval;
  var _pageIntervals = [];

  window.setInterval = function () {
    var id = _origSetInterval.apply(window, arguments);
    _pageIntervals.push(id);
    return id;
  };
  window.clearInterval = function (id) {
    _pageIntervals = _pageIntervals.filter(function (i) { return i !== id; });
    return _origClearInterval.call(window, id);
  };

  function clearAllPageIntervals() {
    _pageIntervals.forEach(function (id) { _origClearInterval.call(window, id); });
    _pageIntervals = [];
  }

  /* ── Helpers ── */
  function isLocalLink(el) {
    if (!el || el.tagName !== 'A') return false;
    if (el.target === '_blank' || el.hasAttribute('download')) return false;
    var href = el.getAttribute('href');
    if (!href || href === '#' || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return false;
    if (el.classList.contains('nav-auth-logout')) return false;
    try {
      var url = new URL(href, location.origin);
      if (url.origin !== location.origin) return false;
      var p = url.pathname;
      return p.endsWith('.html') || p === '/' || p.endsWith('/');
    } catch (e) { return false; }
  }

  function fileFromPath(path) {
    return path.split('/').pop() || 'index.html';
  }

  function syncActiveLinks(fileName) {
    document.querySelectorAll('.nav-links a, #mobileMenu a').forEach(function (a) {
      var lh = a.getAttribute('href');
      if (!lh) return;
      var match = (lh === fileName) || (fileName === 'index.html' && (lh === '/' || lh === './'));
      if (match) a.classList.add('active');
      else a.classList.remove('active');
    });
  }

  function closeMobileMenu() {
    var menu = document.getElementById('mobileMenu');
    var ham = document.getElementById('hamburger');
    if (menu && menu.classList.contains('open')) {
      menu.classList.remove('open');
      if (ham) {
        ham.children[0].style.transform = '';
        ham.children[1].style.opacity = '';
        ham.children[2].style.transform = '';
      }
      document.body.style.overflow = '';
    }
  }

  /* ── Core navigation ── */
  function navigateTo(url, pushState) {
    if (typeof pushState === 'undefined') pushState = true;
    var container = document.getElementById('app-content');
    if (!container) { window.location.href = url; return; }

    // Fade out
    container.classList.add('fade-out');

    setTimeout(function () {
      fetch(url).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      }).then(function (html) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(html, 'text/html');
        var newContent = doc.getElementById('app-content');
        if (!newContent) { window.location.href = url; return; }

        // 1 — Clear page intervals
        clearAllPageIntervals();

        // 2 — Update page title
        var title = doc.querySelector('title');
        if (title) document.title = title.textContent;

        // 3 — Swap page-specific styles
        document.querySelectorAll('style[data-page-style]').forEach(function (el) { el.remove(); });
        doc.head.querySelectorAll('style[data-page-style]').forEach(function (el) {
          var s = document.createElement('style');
          s.setAttribute('data-page-style', '');
          s.textContent = el.textContent;
          document.head.appendChild(s);
        });

        // 4 — Swap content
        container.innerHTML = newContent.innerHTML;

        // 5 — Push history
        if (pushState) history.pushState({ spaUrl: url }, '', url);

        // 6 — Sync navigation
        var pageName = fileFromPath(new URL(url, location.origin).pathname);
        syncActiveLinks(pageName);
        closeMobileMenu();
        if (typeof updateNav === 'function') updateNav();

        // 7 — Scroll to top
        window.scrollTo({ top: 0, behavior: 'instant' });

        // 8 — Execute page-specific inline scripts
        var scripts = doc.querySelectorAll('script');
        scripts.forEach(function (orig) {
          if (orig.src) return;                 // skip external scripts (app.js, etc.)
          if (orig.closest && orig.closest('head')) return;
          var code = (orig.textContent || '').trim();
          if (!code) return;
          // Replace let/const with var to prevent redeclaration errors on re-visit
          code = code.replace(/\blet\s+/g, 'var ').replace(/\bconst\s+/g, 'var ');
          var el = document.createElement('script');
          el.textContent = code;
          document.body.appendChild(el);
          el.remove(); // DOM element removed, but code already executed
        });

        // 9 — Re-initialise reveal animations
        if (typeof initGlobalAnimations === 'function') initGlobalAnimations();

        // 10 — Fade in
        container.classList.remove('fade-out');

      }).catch(function (err) {
        console.error('[SPA] navigation error:', err);
        window.location.href = url;      // fallback to full reload
      });
    }, 230); // matches the CSS transition duration
  }

  /* ── Click delegation ── */
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a') : null;
    if (!a) return;
    if (!isLocalLink(a)) return;
    e.preventDefault();
    if (a.href === location.href) return; // same page, do nothing
    navigateTo(a.href);
  });

  /* ── Browser back / forward ── */
  window.addEventListener('popstate', function () {
    navigateTo(location.href, false);
  });

  /* ── Seed initial state ── */
  history.replaceState({ spaUrl: location.href }, '', location.href);

  /* ── Expose for programmatic navigation ── */
  window.spaNavigateTo = navigateTo;
})();
