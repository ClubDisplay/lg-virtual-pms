const API = { base: '/api' };

function api(path, opts = {}) {
  return fetch(API.base + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts
  }).then(r => r.json().then(d => ({ ok: r.ok, data: d, status: r.status })));
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// === Router ===
function navigate(hash) {
  window.location.hash = hash;
  render();
}

let state = { view: 'login', customerId: null, dashboardUsername: '' };
let currentUser = null;

function render() {
  closeModal();
  const hash = window.location.hash.slice(1) || 'dashboard';
  const app = document.getElementById('app');

  if (hash === 'login') { state.view = 'login'; renderLogin(app); }
  else if (hash.startsWith('customer/')) {
    state.view = 'customer';
    state.customerId = hash.split('/')[1];
    renderCustomer(app);
  }
  else if (hash === 'logs') { state.view = 'logs'; renderLogs(app); }
  else { state.view = 'dashboard'; renderDashboard(app); }
}

// === Login ===
function renderLogin(app) {
  app.innerHTML = `
    <div class="login-page">
      <div class="login-box">
        <h1>Virtual PMS</h1>
        <p>Dashboard beheer</p>
        <input type="text" id="username" placeholder="Gebruikersnaam" autocomplete="username">
        <input type="password" id="password" placeholder="Wachtwoord" autocomplete="current-password">
        <button onclick="doLogin()">Inloggen</button>
        <div id="loginError" class="login-error"></div>
      </div>
    </div>
  `;
  document.getElementById('username')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('password')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
}

window.doLogin = async function() {
  const u = document.getElementById('username').value;
  const p = document.getElementById('password').value;
  const res = await api('/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
  if (res.ok) {
    currentUser = { username: res.data.username, role: res.data.role || 'admin', customerId: res.data.customerId || null };
    if (currentUser.role === 'customer' && currentUser.customerId) navigate('customer/' + currentUser.customerId);
    else navigate('dashboard');
  } else {
    document.getElementById('loginError').textContent = res.data.error || 'Fout bij inloggen';
  }
};

// === Dashboard ===
function renderDashboard(app) {
  if (currentUser && currentUser.role === 'customer' && currentUser.customerId) {
    return navigate('customer/' + currentUser.customerId);
  }
  api('/me').then(r => {
    if (!r.ok) return navigate('login');
    api('/stats').then(s => {
      const st = s.data;
      app.innerHTML = layout(`
        <h1>Dashboard</h1>
        <div class="stats">
          <div class="stat-card"><div class="label">Klanten</div><div class="value blue">${st.totalCustomers}</div></div>
          <div class="stat-card"><div class="label">Actieve klanten</div><div class="value green">${st.activeCustomers}</div></div>
          <div class="stat-card"><div class="label">TV's totaal</div><div class="value orange">${st.totalTvs}</div></div>
          <div class="stat-card"><div class="label">Checkouts vandaag</div><div class="value">${st.todayLogs}</div></div>
          <div class="stat-card"><div class="label">Succesvol vandaag</div><div class="value green">${st.successToday}</div></div>
        </div>
      `, 'dashboard');
      loadCustomers();
    });
  });
}

function layout(content, active) {
  const isCustomer = currentUser && currentUser.role === 'customer';
  const customerId = currentUser && currentUser.customerId;
  const nav = isCustomer ? `
          <a class="${active === 'customer' ? 'active' : ''}" onclick="navigate('customer/${customerId}')"><span class="icon">🏨</span> <span>Mijn omgeving</span></a>
          <a class="${active === 'logs' ? 'active' : ''}" onclick="navigate('logs')"><span class="icon">📋</span> <span>Checkout logs</span></a>
        ` : `
          <a class="${active === 'dashboard' ? 'active' : ''}" onclick="navigate('dashboard')"><span class="icon">📊</span> <span>Dashboard</span></a>
          <a class="${active === 'customers' ? 'active' : ''}" onclick="navigate('customers')"><span class="icon">👥</span> <span>Klanten</span></a>
          <a class="${active === 'logs' ? 'active' : ''}" onclick="navigate('logs')"><span class="icon">📋</span> <span>Checkout logs</span></a>
        `;
  return `
    <div class="dashboard">
      <div class="sidebar">
        <div style="padding: 24px 20px 20px; text-align: center;">
          <img src="LogoCDVP.png" alt="CDVP" style="max-width: 140px; height: auto; display: block; margin: 0 auto 10px;">
          <div style="font-size: 16px; color: rgba(255,255,255,0.7); letter-spacing: 2px; font-weight: 600;">Virtual PMS</div>
        </div>
        <nav>${nav}</nav>
        <button class="logout-btn" onclick="doLogout()">Uitloggen</button>
      </div>
      <div class="main">${content}</div>
    </div>
  `;
}

window.doLogout = async function() {
  await api('/logout', { method: 'POST' });
  navigate('login');
};

// === Customers ===
function loadCustomers() {
  const container = document.querySelector('.main');
  container.innerHTML += `
    <div class="toolbar">
      <h2 style="margin:0">Klanten</h2>
      <button class="btn btn-primary" onclick="showAddCustomer()">+ Nieuwe klant</button>
    </div>
    <div class="table-container" id="customerTable"><div class="empty">Laden...</div></div>
  `;
  api('/customers').then(r => {
    if (!r.ok) return;
    const table = document.getElementById('customerTable');
    if (r.data.length === 0) { table.innerHTML = '<div class="empty">Nog geen klanten</div>'; return; }
    table.innerHTML = `
      <table>
        <thead><tr><th>Naam</th><th>Email</th><th>TV's</th><th>Limiet</th><th>Status</th><th>Datum</th><th></th></tr></thead>
        <tbody>${r.data.map(c => `
          <tr>
            <td><a href="javascript:void(0)" onclick="navigate('customer/${c.id}')" style="color:#4361ee;text-decoration:none;font-weight:500">${escapeHtml(c.name)}</a></td>
            <td>${escapeHtml(c.contact_email) || '-'}</td>
            <td>${c.tv_count}</td>
            <td>${c.tv_limit}</td>
            <td><span class="badge ${c.active ? 'active' : 'inactive'}">${c.active ? 'Actief' : 'Inactief'}</span></td>
            <td>${new Date(c.created_at).toLocaleDateString('nl-NL')}</td>
            <td><button class="btn btn-danger btn-sm" onclick="deleteCustomer(${c.id})">Verwijder</button></td>
          </tr>
        `).join('')}</tbody>
      </table>
    `;
  });
}

window.showAddCustomer = function() {
  showModal('Nieuwe klant', `
    <div class="form-group"><label>Klantnaam</label><input id="f_name" placeholder="Bijv. Van der Valk Hotel"></div>
    <div class="form-group"><label>Email</label><input id="f_email" placeholder="contact@hotel.nl"></div>
    <div class="form-group"><label>TV limiet</label><input id="f_limit" type="number" value="5" min="1"></div>
  `, async () => {
    const name = document.getElementById('f_name').value;
    if (!name) return alert('Naam is verplicht');
    const res = await api('/customers', {
      method: 'POST',
      body: JSON.stringify({ name, contact_email: document.getElementById('f_email').value, tv_limit: parseInt(document.getElementById('f_limit').value) || 1 })
    });
    closeModal();
    if (res.ok) { loadCustomers(); }
    else alert(res.data.error || 'Fout bij aanmaken');
  });
};

window.deleteCustomer = async function(id) {
  if (!confirm('Weet je zeker dat je deze klant wilt verwijderen?')) return;
  await api('/customers/' + id, { method: 'DELETE' });
  loadCustomers();
};

// === Customer Detail ===
function renderCustomer(app) {
  api('/me').then(r => {
    if (!r.ok) return navigate('login');
    const cid = state.customerId;
    api('/customers').then(cr => {
      const customer = cr.data.find(c => String(c.id) === cid);
      if (!customer) return app.innerHTML = layout('<div class="empty">Klant niet gevonden</div>', 'customers');
      const isAdmin = !currentUser || currentUser.role !== 'customer';
      state.dashboardUsername = customer.dashboard_username || '';
      api('/customers/' + cid + '/tvs').then(tvr => {
        const tvs = tvr.data;
        app.innerHTML = layout(`
          ${isAdmin ? '<a class="back-link" onclick="navigate(\'customers\')">← Terug naar klanten</a>' : ''}
          <div class="detail-header">
            <h1>${escapeHtml(customer.name)}</h1>
            <div>
              <button class="btn btn-warning" onclick="wipeAll(${customer.id})">Wis alle login's gasten</button>
              ${isAdmin ? `
              <button class="btn btn-ghost" onclick="regenerateKey(${customer.id})">Nieuwe API key</button>
              <button class="btn btn-ghost" onclick="toggleCustomerStatus(${customer.id}, ${customer.active})">${customer.active ? 'Deactiveer' : 'Activeer'}</button>
              ` : ''}
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
            <div class="stat-card"><div class="label">Status</div>
              <div><span class="badge ${customer.active ? 'active' : 'inactive'}">${customer.active ? 'Actief' : 'Inactief'}</span></div>
            </div>
            <div class="stat-card"><div class="label">TV's toegevoegd</div><div class="value orange">${tvs.length} / ${customer.tv_limit}</div></div>
          </div>

          ${isAdmin ? `
          <div class="stat-card" style="margin-bottom:24px">
            <div class="label">Checkout instellingen</div>
            <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px">
              <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer">
                <input type="checkbox" ${customer.daily_checkout ? 'checked' : ''} onchange="setDailyCheckout(${customer.id}, this.checked)">
                Dagelijkse automatische checkout (11:00)
              </label>
              <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer">
                <input type="checkbox" ${customer.checkout_reboot ? 'checked' : ''} onchange="setCheckoutReboot(${customer.id}, this.checked)">
                TV herstarten na checkout
              </label>
            </div>
            <div style="font-size:12px;color:#888;margin-top:8px">"TV herstarten" is alleen nodig bij 24/7 aanstaande TV's (bijv. bioscoop), zodat apps zoals Netflix daadwerkelijk uitloggen.</div>
          </div>

          <div class="stat-card" style="margin-bottom:24px">
            <div class="label">API Key</div>
            <div class="api-key"><span id="apiKeyValue">${customer.api_key}</span>
              <button onclick="copyKey()">Kopiëren</button>
            </div>
          </div>

          <div class="stat-card" style="margin-bottom:24px">
            <div class="label">Widget code — plak dit in PCC tekst widget (HTML modus)</div>
            <div class="api-key"><span id="widgetCode" style="font-size:12px;white-space:pre-wrap;word-break:break-all">&lt;iframe src="https://pms.clubdisplay.nl/?key=${customer.api_key}&amp;hour=11&amp;min=0" sandbox="allow-scripts allow-same-origin" style="width:100%;height:100%;border:none"&gt;&lt;/iframe&gt;</span>
              <button onclick="copyWidget()">Kopieer code</button>
            </div>
          </div>

          <div class="stat-card" style="margin-bottom:24px">
            <div class="label">Dashboard gebruiker (klant-login)</div>
            <div id="dashboardUserInfo" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
              <span>${customer.dashboard_username ? 'Gebruiker: <strong>' + escapeHtml(customer.dashboard_username) + '</strong>' : 'Nog geen login ingesteld'}</span>
              <button class="btn btn-ghost" onclick="showSetUser(${customer.id})">${customer.dashboard_username ? 'Wijzigen' : 'Instellen'}</button>
            </div>
          </div>
          ` : ''}

          <h2 style="margin-bottom:12px">TV's</h2>
          <div class="toolbar" style="margin-bottom:12px">
            <span style="font-size:13px;color:#888">${tvs.length} van ${customer.tv_limit} TV's gebruikt</span>
            ${isAdmin && tvs.length < customer.tv_limit ? '<button class="btn btn-primary btn-sm" onclick="showAddTv(' + customer.id + ')">+ TV toevoegen</button>' : ''}
          </div>
          <div class="table-container">
            ${tvs.length === 0 ? '<div class="empty">Nog geen TV\'s toegevoegd</div>' : `
            <table>
              <thead><tr><th>Label</th><th>Serienummer</th><th>Kamer</th><th>Apparaat-ID</th><th>Laatste checkout</th><th>Status</th><th></th></tr></thead>
              <tbody>${tvs.map(t => `
                <tr>
                  <td>${escapeHtml(t.label)}</td>
                  <td style="font-size:12px;color:#888;font-family:monospace">${escapeHtml(t.serial_number) || '-'}</td>
                  <td>${escapeHtml(t.room_name) || '-'}</td>
                  <td style="font-size:12px;color:#888;font-family:monospace">${t.device_id || '-'}</td>
                  <td>${t.last_checkout ? new Date(t.last_checkout).toLocaleString('nl-NL') : '-'}</td>
                  <td>${t.pending_wipe ? '<span class="badge warn">Wis-verzoek</span>' : (t.last_checkout_ok === 1 ? '<span class="badge success">OK</span>' : t.last_checkout_ok === 0 ? '<span class="badge error">Mislukt</span>' : '-')}</td>
                  <td nowrap>
                    <button class="btn btn-warning btn-sm" onclick="wipeTv(${customer.id}, ${t.id})">Wis login gast</button>
                    ${isAdmin ? `
                    <button class="btn btn-ghost btn-sm" onclick="renameTv(${t.id}, '${escapeHtml(t.label)}')">Hernoem</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteTv(${t.id})">Verwijder</button>
                    ` : ''}
                  </td>
                </tr>
              `).join('')}</tbody>
            </table>`}
          </div>

          <h2 style="margin:24px 0 12px">Checkout logs</h2>
          <div class="table-container" id="customerLogs"><div class="empty">Laden...</div></div>
        `, isAdmin ? 'customers' : 'customer');

        loadCustomerLogs(cid);
      });
    });
  });
}

function loadCustomerLogs(cid) {
  api('/logs?customer_id=' + cid + '&limit=20').then(r => {
    const el = document.getElementById('customerLogs');
    if (!r.ok || r.data.logs.length === 0) { el.innerHTML = '<div class="empty">Nog geen checkout logs</div>'; return; }
    el.innerHTML = `
      <table>
        <thead><tr><th>Tijd</th><th>TV</th><th>Resultaat</th><th>Foutmelding</th></tr></thead>
        <tbody>${r.data.logs.map(l => `
          <tr>
            <td>${new Date(l.created_at).toLocaleString('nl-NL')}</td>
            <td>${escapeHtml(l.tv_label) || '-'}</td>
            <td><span class="badge ${l.success ? 'success' : 'error'}">${l.success ? 'Geslaagd' : 'Mislukt'}</span></td>
            <td style="color:#888;font-size:13px">${escapeHtml(l.error_message) || '-'}</td>
          </tr>
        `).join('')}</tbody>
      </table>
    `;
  });
}

window.showAddTv = function(cid) {
  showModal('TV toevoegen', `
    <div class="form-group"><label>Label</label><input id="f_tv_label" placeholder="Bijv. TV 1 of Lounge TV"></div>
    <div class="form-group"><label>Kamer (optioneel)</label><input id="f_tv_room" placeholder="Bijv. Kamer 101"></div>
  `, async () => {
    const label = document.getElementById('f_tv_label').value;
    if (!label) return alert('Label is verplicht');
    const res = await api('/customers/' + cid + '/tvs', {
      method: 'POST',
      body: JSON.stringify({ label, room_name: document.getElementById('f_tv_room').value })
    });
    closeModal();
    if (res.ok) { navigate('customer/' + cid); }
    else alert(res.data.error || 'Fout bij toevoegen');
  });
};

window.renameTv = function(id, currentLabel) {
  const label = prompt('Nieuw label voor deze TV:', currentLabel);
  if (!label) return;
  api('/tvs/' + id, {
    method: 'PUT',
    body: JSON.stringify({ label })
  }).then(() => navigate('customer/' + state.customerId));
};

window.deleteTv = async function(id) {
  if (!confirm('TV verwijderen?')) return;
  await api('/tvs/' + id, { method: 'DELETE' });
  navigate('customer/' + state.customerId);
};

window.regenerateKey = async function(id) {
  if (!confirm('Nieuwe API key genereren? De oude key werkt niet meer.')) return;
  const res = await api('/customers/' + id + '/regenerate-key', { method: 'POST' });
  if (res.ok) {
    document.getElementById('apiKeyValue').textContent = res.data.api_key;
  }
};

window.copyWidget = function() {
  const el = document.getElementById('widgetCode');
  const code = el.textContent;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(code).then(() => alert('Widget code gekopieerd!'));
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = code;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    alert('Widget code gekopieerd!');
  }
};

window.copyKey = function() {
  const el = document.getElementById('apiKeyValue');
  const key = el.textContent;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(key).then(() => alert('API key gekopieerd!'));
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = key;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    alert('API key gekopieerd!');
  }
};

window.toggleCustomerStatus = async function(id, currentActive) {
  await api('/customers/' + id, {
    method: 'PUT',
    body: JSON.stringify({ active: !currentActive })
  });
  navigate('customer/' + id);
};

window.wipeTv = async function(customerId, tvId) {
  if (!confirm('Weet je zeker dat je de gast-sessies van deze TV nu wilt wissen?')) return;
  const res = await api('/customers/' + customerId + '/wipe', { method: 'POST', body: JSON.stringify({ tv_id: tvId }) });
  if (res.ok) {
    alert('Wis-verzoek verzonden. De TV voert het wissen uit zodra deze de opdracht oppikt (binnen ~30 seconden).\n\nZet de TV daarna even uit en aan om Netflix volledig uit te loggen.');
    navigate('customer/' + customerId);
  } else {
    alert(res.data.error || 'Fout bij verzenden');
  }
};

window.wipeAll = async function(customerId) {
  if (!confirm('Weet je zeker dat je de gast-sessies van alle TV\'s van deze klant nu wilt wissen?')) return;
  const res = await api('/customers/' + customerId + '/wipe', { method: 'POST', body: JSON.stringify({}) });
  if (res.ok) {
    alert('Wis-verzoek verzonden naar alle TV\'s. De TV\'s voeren het wissen uit zodra ze de opdracht oppikken (binnen ~30 seconden).\n\nZet de TV\'s daarna even uit en aan om Netflix volledig uit te loggen.');
    navigate('customer/' + customerId);
  } else {
    alert(res.data.error || 'Fout bij verzenden');
  }
};

window.showSetUser = function(customerId) {
  const currentUsername = state.dashboardUsername || '';
  showModal('Dashboard gebruiker', `
    <div class="form-group"><label>Gebruikersnaam</label><input id="f_username" value="${escapeHtml(currentUsername)}" placeholder="Bijv. bioscoop"></div>
    <div class="form-group"><label>${currentUsername ? 'Nieuw wachtwoord (leeg laten om te behouden)' : 'Wachtwoord'}</label><input id="f_password" type="password" placeholder="Wachtwoord"></div>
    <p style="font-size:12px;color:#888">Deze gebruiker kan inloggen en ziet alleen de eigen omgeving (TV's + handmatig wissen).</p>
  `, async () => {
    const username = document.getElementById('f_username').value.trim();
    const password = document.getElementById('f_password').value;
    const res = await api('/customers/' + customerId + '/user', { method: 'POST', body: JSON.stringify({ username, password }) });
    closeModal();
    if (res.ok) {
      alert('Gebruiker opgeslagen: ' + res.data.username);
      navigate('customer/' + customerId);
    } else {
      alert(res.data.error || 'Fout bij opslaan');
    }
  });
};

window.setDailyCheckout = async function(id, enabled) {
  const res = await api('/customers/' + id, { method: 'PUT', body: JSON.stringify({ daily_checkout: enabled ? 1 : 0 }) });
  if (!res.ok) alert(res.data.error || 'Fout bij opslaan');
};

window.setCheckoutReboot = async function(id, enabled) {
  const res = await api('/customers/' + id, { method: 'PUT', body: JSON.stringify({ checkout_reboot: enabled ? 1 : 0 }) });
  if (!res.ok) alert(res.data.error || 'Fout bij opslaan');
};

// === Logs ===
function renderLogs(app) {
  api('/me').then(r => {
    if (!r.ok) return navigate('login');
    app.innerHTML = layout(`
      <h1>Checkout logs</h1>
      <div class="table-container" id="allLogs"><div class="empty">Laden...</div></div>
    `, 'logs');
    api('/logs?limit=100').then(r => {
      if (!r.ok) return;
      const el = document.getElementById('allLogs');
      if (r.data.logs.length === 0) { el.innerHTML = '<div class="empty">Nog geen logs</div>'; return; }
      el.innerHTML = `
        <table>
          <thead><tr><th>Tijd</th><th>Klant</th><th>TV</th><th>IP</th><th>Resultaat</th><th>Foutmelding</th></tr></thead>
          <tbody>${r.data.logs.map(l => `
            <tr>
              <td>${new Date(l.created_at).toLocaleString('nl-NL')}</td>
              <td>${escapeHtml(l.customer_name) || '-'}</td>
              <td>${escapeHtml(l.tv_label) || '-'} ${l.room_name ? '(' + escapeHtml(l.room_name) + ')' : ''}</td>
              <td style="font-size:12px;color:#888">${l.ip_address || '-'}</td>
              <td><span class="badge ${l.success ? 'success' : 'error'}">${l.success ? 'Geslaagd' : 'Mislukt'}</span></td>
              <td style="color:#888;font-size:13px">${escapeHtml(l.error_message) || '-'}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      `;
    });
  });
}

// === Modal ===
function showModal(title, body, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modalOverlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>${escapeHtml(title)}</h2>
      ${body}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Annuleren</button>
        <button class="btn btn-primary" id="modalSaveBtn">Opslaan</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('modalSaveBtn').onclick = onSave;
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
}

window.closeModal = function() {
  const el = document.getElementById('modalOverlay');
  if (el) el.remove();
};

window.addEventListener('hashchange', render);
window.addEventListener('load', () => {
  api('/me').then(r => {
    if (!r.ok) return navigate('login');
    currentUser = r.data;
    if (currentUser.role === 'customer' && currentUser.customerId) {
      navigate('customer/' + currentUser.customerId);
    } else {
      navigate(window.location.hash.slice(1) || 'customers');
    }
  });
});
