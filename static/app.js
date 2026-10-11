'use strict';

// The frontend uses only trusted server-side slot/booking decisions.
// initDataUnsafe is used for a UX hint (first-name prefill), never for authentication.
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}
const $ = (id) => document.getElementById(id);
const state = {
  step: 1, services: [], service: null, masterId: null, day: null, time: null,
  monthCursor: null, busy: false, config: {}, slotRequestId: 0, finished: false,
  slotsLoading: false,
};
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const formatAMD = (amount) => `${new Intl.NumberFormat('ru-RU').format(amount)} ֏`;
const haptic = () => { try { tg?.HapticFeedback?.impactOccurred('light'); } catch {} };
const dateISO = (day) => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
const getYerevanToday = () => {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Yerevan', year: 'numeric', month: '2-digit', day: '2-digit' });
  const values = Object.fromEntries(formatter.formatToParts(new Date()).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return new Date(values.year, values.month - 1, values.day);
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const friendlyDay = (iso) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date(`${iso}T12:00:00`));
let toastTimer;
function toast(message) {
  const box = $('toast'); box.textContent = message; box.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { box.hidden = true; }, 4200);
}
async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(tg?.initData ? { 'X-Telegram-Init-Data': tg.initData } : {}),
      ...(options.headers || {}) },
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) {
    const detail = result.detail;
    throw new Error(typeof detail === 'string' ? detail : 'Не удалось выполнить запрос');
  }
  return result;
}
function makeEl(tag, className, text) {
  const el = document.createElement(tag); if (className) el.className = className;
  if (text != null) el.textContent = text; return el;
}
function clear(el) { el.replaceChildren(); }

function renderServices() {
  const root = $('services'); clear(root);
  for (const service of state.services) {
    const button = makeEl('button', `service-card${state.service?.id === service.id ? ' selected' : ''}`);
    button.type = 'button'; button.setAttribute('aria-pressed', state.service?.id === service.id);
    button.disabled = !service.masters.length;
    const icon = makeEl('span', 'service-icon', service.icon);
    const info = makeEl('div', 'service-info');
    info.append(makeEl('p', 'service-name', service.title), makeEl('p', 'service-desc', service.masters.length ? service.description : 'Для этой услуги пока нет доступного мастера'));
    const meta = makeEl('div', 'service-meta');
    meta.append(makeEl('span', 'service-price', formatAMD(service.price_amd)), makeEl('span', 'dot-divider'), makeEl('span', '', `${service.duration_minutes} мин`));
    info.append(meta);
    button.append(icon, info, makeEl('span', 'card-check', state.service?.id === service.id ? '✓' : ''));
    button.addEventListener('click', () => {
      haptic(); const changed = state.service?.id !== service.id;
      state.service = service;
      if (changed) { state.masterId = null; state.day = null; state.time = null; }
      renderServices(); updateFooter();
    });
    root.append(button);
  }
  if (!state.services.length) root.append(makeEl('p', 'empty-message', 'Пока нет доступных услуг'));
}
function renderMasters() {
  const root = $('masters'); clear(root);
  if (!state.service) return;
  const any = makeEl('button', `master-card any${state.masterId === null ? ' selected' : ''}`);
  any.type = 'button'; any.setAttribute('aria-pressed', state.masterId === null);
  const anyAvatar = makeEl('div', 'master-avatar', '✳');
  const text = makeEl('div', 'any-text');
  text.append(makeEl('strong', '', 'Любой свободный мастер'), makeEl('span', '', 'Подберём специалиста для вас'));
  any.append(anyAvatar, text);
  any.addEventListener('click', () => { haptic(); state.masterId = null; state.time = null; renderMasters(); updateFooter(); });
  root.append(any);
  for (const master of state.service.masters) {
    const active = state.masterId === master.id;
    const card = makeEl('button', `master-card${active ? ' selected' : ''}`);
    card.type = 'button'; card.setAttribute('aria-pressed', active);
    card.append(makeEl('div', 'master-avatar', master.initials), makeEl('strong', '', master.name), makeEl('span', '', master.specialty));
    card.addEventListener('click', () => { haptic(); state.masterId = master.id; state.time = null; renderMasters(); updateFooter(); });
    root.append(card);
  }
}
function renderCalendar() {
  const now = getYerevanToday(); const end = addDays(now, 30);
  if (!state.monthCursor) state.monthCursor = new Date(now.getFullYear(), now.getMonth(), 1);
  const first = state.monthCursor;
  $('calendar-month').textContent = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(first);
  const earliest = new Date(now.getFullYear(), now.getMonth(), 1);
  const latest = new Date(end.getFullYear(), end.getMonth(), 1);
  $('month-prev').disabled = first <= earliest;
  $('month-next').disabled = first >= latest;
  const root = $('calendar-days'); clear(root);
  const padding = (first.getDay() + 6) % 7;
  for (let n = 0; n < padding; n++) root.append(makeEl('span', 'blank-day'));
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  for (let n = 1; n <= days; n++) {
    const day = new Date(first.getFullYear(), first.getMonth(), n), iso = dateISO(day);
    const button = makeEl('button', `${iso === state.day ? 'active ' : ''}${iso === dateISO(now) ? 'today' : ''}`, String(n));
    button.type = 'button'; button.disabled = day < now || day > end;
    button.setAttribute('aria-label', friendlyDay(iso)); button.setAttribute('aria-pressed', iso === state.day);
    button.addEventListener('click', () => {
      haptic(); state.day = iso; state.time = null; renderCalendar(); updateFooter(); loadSlots();
    });
    root.append(button);
  }
}
async function loadSlots() {
  const serial = ++state.slotRequestId;
  const root = $('slots'); clear(root);
  if (!state.day || !state.service) {
    state.slotsLoading = false; state.time = null; updateFooter();
    root.append(makeEl('p', 'empty-message', 'Выберите дату в календаре')); return;
  }
  state.slotsLoading = true; updateFooter();
  root.append(makeEl('p', 'empty-message', 'Ищем свободное время…'));
  try {
    const params = new URLSearchParams({ service_id: state.service.id, date: state.day });
    if (state.masterId !== null) params.set('master_id', String(state.masterId));
    const result = await request(`/api/slots?${params}`);
    if (serial !== state.slotRequestId) return;
    clear(root);
    state.slotsLoading = false;
    if (!result.slots.some(item => item.time === state.time)) state.time = null;
    updateFooter();
    if (!result.slots.length) {
      root.append(makeEl('p', 'empty-message', 'В этот день нет свободных окошек. Попробуйте другую дату.'));
      return;
    }
    for (const item of result.slots) {
      const active = state.time === item.time;
      const btn = makeEl('button', `time-chip${active ? ' selected' : ''}`, item.time);
      btn.type = 'button'; btn.setAttribute('aria-pressed', active);
      btn.addEventListener('click', () => {
        haptic(); state.time = item.time;
        root.querySelectorAll('button').forEach(b => { b.classList.toggle('selected', b === btn); b.setAttribute('aria-pressed', b === btn); });
        updateFooter();
      });
      root.append(btn);
    }
    updateFooter();
  } catch (error) {
    if (serial !== state.slotRequestId) return;
    state.slotsLoading = false; state.time = null; updateFooter();
    clear(root); root.append(makeEl('p', 'empty-message', error.message));
  }
}
function renderSummary() {
  const root = $('summary'); clear(root);
  const master = state.service?.masters.find(m => m.id === state.masterId);
  for (const [label, value] of [
    ['Услуга', state.service?.title || '—'],
    ['Мастер', master?.name || 'Любой свободный'],
    ['Когда', `${friendlyDay(state.day)}, ${state.time}`],
    ['Длительность', `${state.service?.duration_minutes} мин`],
    ['Стоимость', formatAMD(state.service?.price_amd || 0)],
  ]) {
    const row = makeEl('div', 'summary-row'); row.append(makeEl('span', '', label), makeEl('strong', '', value)); root.append(row);
  }
}
function updateFooter() {
  if (state.finished) return;
  $('footer-total').textContent = state.service ? formatAMD(state.service.price_amd) : '—';
  const button = $('next-button');
  button.disabled = state.busy || (state.step === 1 && !state.service) ||
    (state.step === 3 && (state.slotsLoading || !state.day || !state.time));
  $('next-label').textContent = state.busy ? 'Отправляем…' : state.step === 4 ? 'Подтвердить запись' : 'Продолжить';
}
function goTo(step) {
  state.step = step;
  for (let n = 1; n <= 4; n++) $(`step-${n}`).hidden = n !== step;
  $('step-success').hidden = true;
  $('progress-fill').style.width = `${step * 25}%`;
  $('step-eyebrow').textContent = `ШАГ 0${step} ИЗ 04`;
  $('step-counter').textContent = `0${step} / 04`;
  $('back-top').hidden = step === 1;
  if (tg?.BackButton) { if (step > 1) tg.BackButton.show(); else tg.BackButton.hide(); }
  if (step === 2) renderMasters();
  if (step === 3) { renderCalendar(); loadSlots(); }
  if (step === 4) renderSummary();
  updateFooter(); window.scrollTo({ top: 0, behavior: 'smooth' });
}
function back() {
  if (!state.busy && !state.finished && state.step > 1) { haptic(); goTo(state.step - 1); }
}
async function submitBooking() {
  if (state.busy || state.slotsLoading) return;
  const name = $('client-name').value.trim();
  const phone = $('client-phone').value.trim();
  if (name.length < 2) { toast('Пожалуйста, введите имя'); $('client-name').focus(); return; }
  if (!/^\+?[0-9()\-\s]{7,24}$/.test(phone) || (phone.match(/\d/g) || []).length < 7 || (phone.match(/\d/g) || []).length > 15) {
    toast('Введите корректный номер телефона'); $('client-phone').focus(); return;
  }
  if (!tg?.initData) { toast('Для записи откройте приложение через вашего Telegram-бота'); return; }
  state.busy = true; updateFooter();
  try {
    const result = await request('/api/book', { method: 'POST', body: JSON.stringify({
      service_id: state.service.id, master_id: state.masterId, date: state.day,
      time: state.time, name, phone,
    }) });
    haptic(); state.finished = true;
    for (let n = 1; n <= 4; n++) $(`step-${n}`).hidden = true;
    $('step-success').hidden = false; $('booking-footer').hidden = true;
    $('back-top').hidden = true; tg?.BackButton?.hide();
    $('progress-fill').style.width = '100%'; $('step-eyebrow').textContent = 'ЗАПИСЬ СОЗДАНА'; $('step-counter').textContent = '✓';
    $('success-details').textContent = `Заявка №${result.booking_id} · ${state.service.title} · ${friendlyDay(state.day)}, ${state.time} · ${result.master_name}`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    toast(error.message);
    if (error.message.includes('занято') || error.message.includes('недоступно')) {
      state.time = null; goTo(3);
    }
  } finally { state.busy = false; updateFooter(); }
}
function next() {
  haptic(); if (state.busy) return;
  if (state.step === 1 && !state.service) return;
  if (state.step === 3 && (state.slotsLoading || !state.time)) { toast('Выберите свободное время'); return; }
  if (state.step === 4) { void submitBooking(); return; }
  goTo(state.step + 1);
}
async function init() {
  $('back-top').addEventListener('click', back);
  tg?.BackButton?.onClick(back);
  $('next-button').addEventListener('click', next);
  $('month-prev').addEventListener('click', () => { haptic(); state.monthCursor = new Date(state.monthCursor.getFullYear(), state.monthCursor.getMonth() - 1, 1); renderCalendar(); });
  $('month-next').addEventListener('click', () => { haptic(); state.monthCursor = new Date(state.monthCursor.getFullYear(), state.monthCursor.getMonth() + 1, 1); renderCalendar(); });
  $('book-another').addEventListener('click', () => {
    haptic(); state.finished = false; state.service = null; state.masterId = null; state.day = null; state.time = null;
    state.slotRequestId++; state.monthCursor = null; $('booking-footer').hidden = false;
    renderServices(); goTo(1);
  });
  $('contact-form').addEventListener('submit', e => { e.preventDefault(); void submitBooking(); });
  if (tg?.initDataUnsafe?.user?.first_name) $('client-name').value = tg.initDataUnsafe.user.first_name;
  try {
    const [config, services] = await Promise.all([request('/api/config'), request('/api/services')]);
    state.config = config; state.services = services;
    document.title = `${config.salon_name} — запись`;
    renderServices(); updateFooter();
  } catch (error) { $('services').replaceChildren(makeEl('p', 'empty-message', error.message)); toast('Сервис временно недоступен'); }
}
init();
