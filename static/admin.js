'use strict';
// Signed initData is always verified again on the server. Never trust initDataUnsafe for permissions.
const tg = window.Telegram?.WebApp;
tg?.ready(); tg?.expand();
const $ = id => document.getElementById(id);
const state = { services: [], masters: [], bookings: [], serviceId: null, masterId: null };
const mk = (tag, text = '', cls = '') => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; };
let noticeHandle;
const haptic = () => { try { tg?.HapticFeedback?.impactOccurred('light'); } catch {} };
function notify(message, error = false) {
  const node = $('notice'); node.textContent = message; node.className = error ? 'notice error' : 'notice'; node.hidden = false;
  clearTimeout(noticeHandle); noticeHandle = setTimeout(() => { node.hidden = true; }, 5500);
}
async function api(path, options = {}) {
  if (!tg?.initData) throw new Error('Откройте панель через Telegram-бота, а не обычный браузер');
  const response = await fetch(path, {
    ...options,
    headers: {'X-Telegram-Init-Data': tg.initData,
      ...(options.body ? {'Content-Type': 'application/json'} : {}), ...options.headers}
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Ошибка сервера (${response.status})`);
  return data;
}
const json = (method, body) => ({method, body: JSON.stringify(body)});
function tab(name) {
  for (const button of document.querySelectorAll('[data-tab]')) button.classList.toggle('active', button.dataset.tab === name);
  for (const part of ['bookings', 'services', 'masters', 'hours']) $(`panel-${part}`).hidden = part !== name;
  haptic();
}
function statusWord(value) { return {pending:'Ожидает',confirmed:'Подтверждена',cancelled:'Отменена'}[value] || value; }
async function overview() {
  const r = await api('/api/admin/overview');
  for (const key of ['pending','confirmed','cancelled']) $(`stat-${key}`).textContent = r[key];
}
function empty(root, message) { root.replaceChildren(mk('p', message, 'entry')); }
async function loadBookings() {
  const params = new URLSearchParams();
  if ($('filter-date').value) params.set('day', $('filter-date').value);
  if ($('filter-status').value) params.set('status', $('filter-status').value);
  state.bookings = await api(`/api/admin/bookings?${params.toString()}`);
  const root = $('booking-list'); root.replaceChildren();
  if (!state.bookings.length) { empty(root, 'Записей по фильтру пока нет'); return; }
  for (const booking of state.bookings) {
    const card = mk('article', '', 'entry');
    const top = mk('div', '', 'row');
    const header = mk('div');
    header.append(mk('strong', `${booking.date} · ${booking.time}`), mk('small', `${booking.service} · ${booking.master}`));
    top.append(header, mk('span', statusWord(booking.status), `status ${booking.status}`));
    card.append(top, mk('p', `${booking.client_name} · ${booking.phone}`), mk('small', `Запись №${booking.id} · Telegram ID ${booking.telegram_id}`));
    if (booking.status !== 'cancelled') {
      const buttons = mk('div', '', 'actions');
      if (booking.status === 'pending') {
        const confirm = mk('button', '✓ Подтвердить', 'approve'); confirm.type = 'button';
        confirm.addEventListener('click', () => decide(booking.id, 'confirmed')); buttons.append(confirm);
      }
      const cancel = mk('button', '✕ Отменить'); cancel.type = 'button';
      cancel.addEventListener('click', () => decide(booking.id, 'cancelled'));
      buttons.append(cancel); card.append(buttons);
    }
    root.append(card);
  }
}
async function decide(id, status) {
  if (!window.confirm(status === 'cancelled' ? 'Отменить эту запись? Клиент получит уведомление.' : 'Подтвердить эту запись?')) return;
  try { await api(`/api/admin/bookings/${id}`, json('PATCH', {status})); haptic(); notify('Статус записи обновлён'); await Promise.all([loadBookings(),overview()]); }
  catch (err) { notify(err.message, true); }
}
async function loadServices() {
  state.services = await api('/api/admin/services');
  const root = $('service-list'); root.replaceChildren();
  if (!state.services.length) empty(root, 'Услуг ещё нет');
  for (const service of state.services) {
    const card = mk('button', '', 'entry'); card.type = 'button';
    card.append(mk('strong', `${service.icon} ${service.title}`),
      mk('small', `${service.duration_minutes} мин · ${Number(service.price_amd).toLocaleString('ru-RU')} ֏ · ${service.active ? 'Активна' : 'Скрыта'}`));
    card.addEventListener('click', () => { editService(service); haptic(); }); root.append(card);
  }
  const selections = $('master-service-options'); selections.replaceChildren();
  const selected = state.masterId != null ? state.masters.find(m => m.id === state.masterId)?.service_ids ?? [] : [];
  for (const service of state.services) {
    const label = mk('label'); const input = document.createElement('input'); input.type = 'checkbox';
    input.value = service.id; input.checked = selected.includes(service.id); input.name = 'services';
    label.append(input, document.createTextNode(service.title)); selections.append(label);
  }
}
function editService(service = null) {
  state.serviceId = service?.id ?? null;
  const form = $('service-form'); form.reset();
  $('service-form-title').textContent = service ? `Услуга №${service.id}` : 'Новая услуга';
  if (service) for (const key of ['title','description','category','icon','duration_minutes','price_amd','active']) form.elements[key][key === 'active' ? 'checked' : 'value'] = service[key];
}
async function saveService(e) {
  e.preventDefault(); const form = e.currentTarget;
  const fields = Object.fromEntries(new FormData(form).entries());
  const data = {title:fields.title.trim(),description:fields.description.trim(),category:fields.category.trim(),
    icon:fields.icon.trim(),duration_minutes:Number(fields.duration_minutes),price_amd:Number(fields.price_amd),
    active:form.elements.active.checked};
  try {
    if (state.serviceId == null) await api('/api/admin/services', json('POST',data));
    else await api(`/api/admin/services/${state.serviceId}`, json('PATCH',data));
    notify('Услуга сохранена'); haptic(); editService(); await loadServices();
  } catch(err) { notify(err.message,true); }
}
async function loadMasters() {
  state.masters = await api('/api/admin/masters');
  const root = $('master-list'); root.replaceChildren();
  if (!state.masters.length) empty(root, 'Мастеров ещё нет');
  for (const master of state.masters) {
    const card = mk('button', '', 'entry'); card.type = 'button';
    card.append(mk('strong', `${master.initials} · ${master.name}`),
      mk('small', `${master.specialty} · ${master.active ? 'Работает' : 'Скрыт'} · ${master.service_ids.length} услуг`));
    card.addEventListener('click', () => { editMaster(master); haptic(); }); root.append(card);
  }
  const selector = $('hours-master'); const existing = Number(selector.value); selector.replaceChildren();
  for (const master of state.masters) { const o = document.createElement('option'); o.value = master.id; o.textContent = master.name; selector.append(o); }
  if (state.masters.some(m=>m.id===existing)) selector.value = String(existing);
  renderHours();
}
function editMaster(master = null) {
  state.masterId = master?.id ?? null; const form = $('master-form'); form.reset();
  $('master-form-title').textContent = master ? `Мастер №${master.id}` : 'Новый мастер';
  if (master) for (const key of ['name','specialty','initials','active']) form.elements[key][key === 'active' ? 'checked' : 'value'] = master[key];
  for (const input of $('master-service-options').querySelectorAll('input[type=checkbox]'))
    input.checked = master?.service_ids?.includes(Number(input.value)) ?? false;
}
async function saveMaster(e) {
  e.preventDefault(); const form = e.currentTarget;
  const data = {name:form.elements.name.value.trim(),specialty:form.elements.specialty.value.trim(),
    initials:form.elements.initials.value.trim(),active:form.elements.active.checked,
    service_ids:Array.from($('master-service-options').querySelectorAll('input:checked'),input=>Number(input.value))};
  try {
    if (state.masterId == null) await api('/api/admin/masters',json('POST',data));
    else await api(`/api/admin/masters/${state.masterId}`,json('PATCH',data));
    notify('Мастер сохранён');haptic();editMaster();await loadMasters();
  } catch(err) { notify(err.message,true); }
}
const weekdays = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
function renderHours() {
  const master = state.masters.find(m=>m.id===Number($('hours-master').value));
  const root = $('hours-grid'); root.replaceChildren();
  for (let day=0; day<7; day++) {
    const current = master?.hours.find(h=>h.weekday===day);
    const row = mk('div','','hours-row');row.dataset.day = day;
    row.append(mk('span',weekdays[day]));
    const enabledLabel = mk('label'); const active = document.createElement('input');active.type='checkbox';active.checked=!!current;active.className='hours-enabled';
    enabledLabel.append(active,document.createTextNode('Раб.'));row.append(enabledLabel);
    for (const [cls,value] of [['hours-start',current?.start_time||'10:00'],['hours-end',current?.end_time||'19:00']]) {
      const input=document.createElement('input');input.type='time';input.value=value;input.className=cls;input.setAttribute('aria-label',`${weekdays[day]} ${cls==='hours-start'?'начало':'конец'}`);row.append(input);
    }
    root.append(row);
  }
  $('days-off').value = master?.days_off.join(', ') || '';
}
async function saveHours(e) {
  e.preventDefault();const id=Number($('hours-master').value);if(!id) return notify('Сначала добавьте мастера',true);
  const hours=[];
  for (const row of $('hours-grid').children) if(row.querySelector('.hours-enabled').checked)
    hours.push({weekday:Number(row.dataset.day),start_time:row.querySelector('.hours-start').value,end_time:row.querySelector('.hours-end').value});
  const raw=$('days-off').value.trim();const days=raw ? raw.split(',').map(s=>s.trim()).filter(Boolean) : [];
  if(days.some(d=>!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d))) return notify('Выходные: формат ГГГГ-ММ-ДД, через запятую',true);
  try {
    await api(`/api/admin/masters/${id}/schedule`,json('PUT',{hours,days}));
    notify('График и выходные обновлены');haptic();await loadMasters();
  } catch(err) { notify(`Проверь график: ${err.message}`,true);await loadMasters(); }
}
async function start() {
  document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>tab(b.dataset.tab)));
  $('refresh').addEventListener('click',()=>Promise.all([loadBookings(),overview()]).catch(err=>notify(err.message,true)));
  $('filter-date').addEventListener('change',()=>loadBookings().catch(err=>notify(err.message,true)));
  $('filter-status').addEventListener('change',()=>loadBookings().catch(err=>notify(err.message,true)));
  $('clear-filters').addEventListener('click',()=>{$('filter-date').value='';$('filter-status').value='';void loadBookings().catch(err=>notify(err.message,true));});
  $('service-form').addEventListener('submit',saveService);$('service-reset').addEventListener('click',()=>editService());
  $('master-form').addEventListener('submit',saveMaster);$('master-reset').addEventListener('click',()=>editMaster());
  $('hours-master').addEventListener('change',renderHours);$('hours-form').addEventListener('submit',saveHours);
  try { await Promise.all([overview(),loadBookings(),loadServices()]); await loadMasters(); }
  catch(err) { notify(err.message,true); }
}
start();
