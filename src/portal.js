import { api, notice, formatMatamorosDateTime, formatMatamorosTime } from './supabase.js';
import { celebrate, unlockSound, closeCelebration } from './celebration.js';
import { membershipTier } from './tiers.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
import { issueWallet, walletStaff } from './wallet.js';
let current = null, walletToken = null, visitRequest = null, scanControls = null, scanRun = 0, busy = false, successTimer = null;

function msg(id, text, error = false) {
  $(id).innerHTML = text ? `<div class="${error ? 'error' : 'ok'}">${text}</div>` : '';
}

function setPin(value) {
  $('code').value = value.replace(/\D/g, '').slice(0, 4);
  document.querySelectorAll('.pin-dots span').forEach((dot, index) => dot.classList.toggle('filled', index < $('code').value.length));
}

function tickClock() {
  $('matamorosClock').textContent = formatMatamorosTime(new Date());
}

function resetKiosk() {
  clearTimeout(successTimer);
  current = null;
  busy = false;
  msg('lookupMessage', '');
  setPin('');
  $('clientArea').classList.add('hidden');
  $('nipStep').classList.remove('hidden');
  $('code').focus();
}

function showKioskMode(mode) {
  stopScan();
  msg('lookupMessage', '');
  msg('registerMessage', '');
  $('visitModeButton').classList.toggle('active', mode === 'visit');
  $('registerModeButton').classList.toggle('active', mode === 'register');
  $('visitStep').classList.toggle('hidden', mode !== 'visit');
  $('registerStep').classList.toggle('hidden', mode !== 'register');
  if (mode === 'visit') resetKiosk();
}

function showClient(client) {
  current = client;
  const n = client.visits;
  const tier = client.membership_tier || membershipTier(n);
  $('clientCard').innerHTML = `<div class="kiosk-client"><img class="kiosk-avatar" alt="Socio AB Premier" src="${esc('assets/logo-ab-premiere.png')}"><div><h2>${esc(client.full_name)}</h2><span class="premium">${esc(tier)}</span><p>Visitas acumuladas: <b>${n}</b></p><p>Ultima visita: <b>${esc(formatMatamorosDateTime(client.last_visit) || 'Sin visitas')}</b></p>${client.next_prize ? `<p>Proximo beneficio: <b>${esc(client.next_prize)}</b></p>` : '<p>Todos tus beneficios estan desbloqueados.</p>'}${client.one_away ? '<p class="kiosk-alert">Te falta un corte para ganar tu proximo beneficio.</p>' : ''}${client.birthday_month ? '<p class="kiosk-alert">Feliz mes de cumpleanos.</p>' : ''}</div></div>`;
  walletActions($('clientWallet'), client.id);
  $('nipStep').classList.add('hidden');
  $('clientArea').classList.remove('hidden');
}

function showSuccess(data) {
  msg('lookupMessage', '');
  const nextText = data.next_prize
    ? `<p>Te faltan <b>${data.remaining_to_next}</b> cortes para desbloquear: <b>${esc(data.next_prize)}</b></p>`
    : '<p>Ya completaste todos los beneficios de Familia AB.</p>';
  $('clientCard').innerHTML = `<div class="visit-success"><p class="success-overline">Visita registrada</p><h2>Bienvenido, ${esc(current.full_name)}</h2><p class="success-number">Visita #${data.visit_number}</p><p>${esc(formatMatamorosDateTime(data.registered_at || new Date()))}</p>${nextText}<p>Gracias por ser parte de AB Premiere.</p><button type="button" onclick="resetKiosk()">Registrar otra visita</button><small>La pantalla volvera al inicio en 25 segundos.</small></div>`;
  successTimer = setTimeout(resetKiosk, 25000);
}

async function lookupClient() {
  if (busy) return;
  const code = $('code').value;
  if (code.length !== 4) return msg('lookupMessage', 'Ingresa tu NIP de 4 digitos.', true);
  busy = true;
  msg('lookupMessage', 'Consultando...');
  try {
    const d = await api('lookup', { code });
    showClient(d.client);
    msg('lookupMessage', '');
  } catch (e) {
    msg('lookupMessage', esc(e.message), true);
  } finally {
    busy = false;
  }
}

async function registerVisit() {
  if (!current || busy) return;
  if (!$('barber').value || !$('service').value) return msg('lookupMessage', 'Selecciona barbero y servicio.', true);
  unlockSound();
  busy = true;
  const button = $('registerVisitButton');
  button.disabled = true;
  button.textContent = 'Registrando...';
  try {
    const selection = { barber_id: $('barber').value, service_id: $('service').value };
    const selectionKey = JSON.stringify(selection);
    if (walletToken && visitRequest?.selection !== selectionKey) {
      visitRequest = { selection: selectionKey, id: crypto.randomUUID() };
    }
    const d = walletToken
      ? await walletStaff('visit', { ...selection, token: walletToken, request_id: visitRequest.id })
      : await api('visit', { ...selection, code: current.code });
    if (d.courtesy_won && d.prize_name) {
      msg('lookupMessage', `Te ganaste <b>${esc(d.prize_name)}</b> en tu visita #${d.visit_number}.`);
      celebrate(d.prize_name, d.visit_number);
      resetKiosk();
    } else {
      const next = walletToken
        ? await walletStaff('lookup', { token: walletToken })
        : await api('lookup', { code: current.code });
      showSuccess({ ...d, registered_at: new Date(), next_prize: next.client.next_prize, remaining_to_next: Math.max(0, (next.client.next_courtesy || d.visit_number) - d.visit_number) });
    }
  } catch (e) {
    msg('lookupMessage', esc(e.message), true);
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = 'Registrar visita';
  }
}

function stopScan() {
  scanRun++;
  scanControls?.stop();
  scanControls = null;
  const video = $('walletVideo');
  video.srcObject?.getTracks().forEach(track => track.stop());
  video.srcObject = null;
  $('scanner').classList.add('hidden');
}

async function startScan() {
  if (busy || !$('scanner').classList.contains('hidden')) return;
  const run = ++scanRun;
  msg('lookupMessage', '');
  $('scanner').classList.remove('hidden');
  try {
    const { BrowserQRCodeReader } = await import('@zxing/browser');
    if (run !== scanRun) return;
    const controls = await new BrowserQRCodeReader().decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' } }, audio: false }, $('walletVideo'),
      async result => {
        if (!result || run !== scanRun || busy) return;
        stopScan();
        const match = /^ABP:([0-9a-f-]{36})$/i.exec(result.getText());
        if (!match) return msg('lookupMessage', 'Escanea un QR de AB Premier.', true);
        busy = true;
        try {
          const { client, available } = await walletStaff('lookup', { token: match[1] });
          walletToken = match[1];
          showClient(client);
          msg('lookupMessage', 'Cortesías disponibles: ' + esc(available));
        } catch (error) {
          msg('lookupMessage', esc(error.message), true);
        } finally {
          busy = false;
        }
      });
    if (run === scanRun) scanControls = controls;
    else controls.stop();
  } catch {
    if (run !== scanRun) return;
    stopScan();
    msg('lookupMessage', 'La cámara requiere permiso y HTTPS. Puedes usar el NIP.', true);
  }
}

function walletActions(area, clientId) {
  area.replaceChildren();
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'kiosk-back';
  button.textContent = 'Generar enlace de Google Wallet';
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  button.onclick = async () => {
    button.disabled = true;
    revoke.disabled = true;
    status.textContent = 'Generando enlace…';
    try {
      const url = await issueWallet(clientId);
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Agregar a Google Wallet';
      const share = document.createElement('button');
      share.type = 'button';
      share.className = 'kiosk-back';
      share.textContent = 'Compartir enlace';
      share.onclick = async () => {
        try {
          if (navigator.share) await navigator.share({ title: 'Tarjeta AB Premier', url });
          else {
            await navigator.clipboard.writeText(url);
            share.textContent = 'Enlace copiado';
          }
        } catch (error) {
          if (error.name !== 'AbortError') share.textContent = 'Copia el enlace de la tarjeta';
        }
      };
      status.replaceChildren(link, share);
      try {
        const { BrowserQRCodeSvgWriter } = await import('@zxing/browser');
        const qr = new BrowserQRCodeSvgWriter().write(url, 240, 240);
        qr.setAttribute('role', 'img');
        qr.setAttribute('aria-label', 'QR para agregar la tarjeta a Google Wallet');
        const figure = document.createElement('figure');
        const caption = document.createElement('figcaption');
        caption.textContent = 'Escanea para agregar tarjeta';
        figure.className = 'wallet-enrollment-qr';
        figure.append(qr, caption);
        status.append(figure);
      } catch {
        // The save link and share button remain available.
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
      revoke.disabled = false;
    }
  };
  const revoke = document.createElement('button');
  revoke.type = 'button';
  revoke.className = 'kiosk-back';
  revoke.textContent = 'Revocar QR';
  revoke.onclick = async () => {
    if (!window.confirm('¿Revocar el QR de este socio?')) return;
    revoke.disabled = true;
    button.disabled = true;
    try {
      await walletStaff('revoke', { client_id: clientId });
      status.textContent = 'QR revocado. Genera un enlace nuevo para reactivar la tarjeta.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      revoke.disabled = false;
      button.disabled = false;
    }
  };
  area.append(button, revoke, status);
}

$('registerForm').onsubmit = async e => {
  e.preventDefault();
  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const d = await api('register', { full_name: $('fullName').value, birth_date: $('birthDate').value, phone: $('phone').value });
    msg('registerMessage', `Socio creado: <b>${esc(d.name)}</b><br>NIP: <b style="font-size:34px">${esc(d.code)}</b>`);
    e.target.reset();
    walletActions($('newWallet'), d.id);
    stopScan();
  } catch (e) {
    msg('registerMessage', esc(e.message), true);
  } finally {
    button.disabled = false;
  }
};

async function loadCatalogs() {
  const d = await api('catalogs');
  for (const [id, rows] of [['barber', d.barbers], ['service', d.services]]) {
    $(id).innerHTML = '<option value="">Selecciona...</option>' + rows.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  }
}

async function signOut() {
  await api('admin_logout');
  location.href = 'admin.html?return=portal';
}

async function init() {
  $('scanWallet').onclick = startScan;
  $('stopWallet').onclick = stopScan;
  tickClock();
  setInterval(tickClock, 1000);
  document.querySelectorAll('[data-key]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.key;
    if (key === 'back') setPin($('code').value.slice(0, -1));
    else setPin($('code').value + key);
  }));
  $('code').addEventListener('input', () => setPin($('code').value));
  $('lookupForm').addEventListener('submit', e => {
    e.preventDefault();
    lookupClient();
  });
  document.addEventListener('keydown', e => {
    if (!$('registerStep').classList.contains('hidden') || ['SELECT', 'BUTTON', 'A'].includes(document.activeElement?.tagName)) return;
    if (document.activeElement?.tagName === 'INPUT' && document.activeElement.id !== 'code') return;
    if (/^\d$/.test(e.key)) setPin($('code').value + e.key);
    if (e.key === 'Backspace') setPin($('code').value.slice(0, -1));
    if (e.key === 'Enter' && !current) lookupClient();
  });
  try {
    await api('admin_session');
    await api('rewards');
    await loadCatalogs();
    $('connection').textContent = '';
    $('connection').classList.add('hidden');
    resetKiosk();
  } catch (e) {
    $('connection').innerHTML = `${esc(/Acci.n desconocida/.test(e.message) ? 'Falta activar los premios por cortes en Supabase.' : e.message)} <a href="admin.html?return=portal">Abrir administracion</a>`;
  }
}

Object.assign(window, { registerVisit, resetKiosk, showKioskMode, signOut });
window.addEventListener('pagehide', () => { closeCelebration(); clearTimeout(successTimer); stopScan(); });
window.addEventListener('unhandledrejection', e => { e.preventDefault(); notice(e.reason?.message || 'No se pudo completar la operacion.'); });
init();
