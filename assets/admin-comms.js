/* ============================================================
   e-Medicare — Barangay Bambang Admin Control Center
   COMMUNICATIONS MODULE
   External agency directory + mutual-aid / coordination request
   pipeline (Pending -> Acknowledged -> En Route -> Resolved).
   Depends on helpers already defined in admin.js:
   load(), save(), uid(), nowISO(), fmtTime(), timeAgo(),
   logActivity(), statusClass()
   ============================================================ */

/* ---------------------------------------------------------
   STORAGE KEYS
--------------------------------------------------------- */
DB.agencies      = DB.agencies      || 'bmb_agencies';
DB.coordinations = DB.coordinations || 'bmb_coordinations';

/* ---------------------------------------------------------
   SEED DATA (first run only)
--------------------------------------------------------- */
function seedCommsIfEmpty(){
  if(!localStorage.getItem(DB.agencies)){
    save(DB.agencies, [
      { id: uid('agy'), name:'Barangay Malinis DRRMO', category:'Barangay', contact:'0917 111 2233', status:'Available' },
      { id: uid('agy'), name:'City Fire Station 2 (BFP)', category:'Fire', contact:'(044) 123-4567', status:'Available' },
      { id: uid('agy'), name:'Bambang Police Sub-Station (PNP)', category:'Police', contact:'0918 444 5566', status:'Available' },
      { id: uid('agy'), name:'City General Hospital', category:'Hospital', contact:'(044) 890-1122', status:'Busy' },
      { id: uid('agy'), name:'Municipal DRRMO', category:'DRRMO', contact:'0919 777 8899', status:'Available' },
      { id: uid('agy'), name:'Philippine Red Cross Chapter', category:'NGO', contact:'0920 333 4455', status:'Available' },
    ]);
  }
  if(!localStorage.getItem(DB.coordinations)) save(DB.coordinations, []);
}
seedCommsIfEmpty();

/* Add 'comms' activity icon to the shared map used in admin.js */
if(typeof ACTIVITY_ICONS !== 'undefined'){
  ACTIVITY_ICONS.comms = '📡';
}

/* ---------------------------------------------------------
   NOTE: This module does NOT touch TABS or switchTab().
   You must add 'comms' to admin.js yourself — see the 2 edits
   in the setup instructions. This keeps this file safe to load
   even if admin.js's internals differ slightly.
--------------------------------------------------------- */
function renderComms(){
  renderAgencyDirectory();
  populateCoordAgencySelect();
  renderCoordLog();
}

/* Safety net: populate the directory + dropdown as soon as the page
   loads, so the "Send To" list is never empty regardless of whether
   switchTab('comms') has fired yet. */
document.addEventListener('DOMContentLoaded', () => {
  if(document.getElementById('comms-tab')){
    renderComms();
  }
});

/* ---------------------------------------------------------
   AGENCY DIRECTORY
--------------------------------------------------------- */
const AGENCY_CATEGORY_ICONS = {
  Barangay:'🏘️', Fire:'🚒', Police:'🚓', Hospital:'🏥', DRRMO:'⚠️', NGO:'❤️'
};

function renderAgencyDirectory(){
  const wrap = document.getElementById('agencyDirectory');
  if(!wrap) return;
  const list = load(DB.agencies, []);
  if(list.length === 0){
    wrap.innerHTML = '<div class="empty-state">No external agencies registered yet.</div>';
    return;
  }
  wrap.innerHTML = list.map(a => `
    <div class="fleet-quick-row">
      <div>
        <div class="fleet-quick-name">${AGENCY_CATEGORY_ICONS[a.category] || '📍'} ${a.name}</div>
        <div class="fleet-quick-type">${a.category} · ${a.contact}</div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="status-pill ${statusClass(a.status)}"><span class="status-dot"></span>${a.status}</span>
        <button class="primary-btn" style="background:#333;color:#eee;font-size:.68em;padding:5px 8px;" onclick="editAgency('${a.id}')">Edit</button>
        <button class="primary-btn" style="background:#3a1c1c;color:#ff8a8a;font-size:.68em;padding:5px 8px;" onclick="removeAgency('${a.id}')">Remove</button>
      </div>
    </div>
  `).join('');
}

function handleAgencySubmit(e){
  e.preventDefault();
  const id = document.getElementById('agencyId').value;
  const list = load(DB.agencies, []);
  const data = {
    name: document.getElementById('agencyName').value.trim(),
    category: document.getElementById('agencyCategory').value,
    contact: document.getElementById('agencyContact').value.trim(),
    status: document.getElementById('agencyStatus').value,
  };
  if(id){
    const a = list.find(x => x.id === id);
    Object.assign(a, data);
    logActivity('comms', `Agency contact updated: <b>${a.name}</b>`);
  }else{
    const a = { id: uid('agy'), ...data };
    list.push(a);
    logActivity('comms', `New external agency added: <b>${a.name}</b> (${a.category})`);
  }
  save(DB.agencies, list);
  clearAgencyForm();
  renderAgencyDirectory();
  populateCoordAgencySelect();
}

function editAgency(id){
  const a = load(DB.agencies, []).find(x => x.id === id);
  if(!a) return;
  document.getElementById('agencyId').value = a.id;
  document.getElementById('agencyName').value = a.name;
  document.getElementById('agencyCategory').value = a.category;
  document.getElementById('agencyContact').value = a.contact;
  document.getElementById('agencyStatus').value = a.status;
  document.getElementById('formAgencyTitle').textContent = '✏️ Edit Agency / Contact';
}

function removeAgency(id){
  if(!confirm('Remove this agency from the directory?')) return;
  save(DB.agencies, load(DB.agencies, []).filter(x => x.id !== id));
  logActivity('comms', 'An external agency contact was removed from the directory.');
  renderAgencyDirectory();
  populateCoordAgencySelect();
}

function clearAgencyForm(){
  const form = document.getElementById('agencyForm');
  if(form) form.reset();
  document.getElementById('agencyId').value = '';
  document.getElementById('formAgencyTitle').textContent = '➕ Add Agency / Contact';
}

function populateCoordAgencySelect(){
  const sel = document.getElementById('coordAgency');
  if(!sel) return;
  const list = load(DB.agencies, []);
  const current = sel.value;
  sel.innerHTML = '<option value="" disabled selected>Select agency / unit</option>' +
    list.map(a => `<option value="${a.id}">${a.name} (${a.category})</option>`).join('');
  if(current) sel.value = current;
}

/* ---------------------------------------------------------
   COORDINATION REQUESTS (mutual aid / support requests)
--------------------------------------------------------- */
const COORD_STEPS = ['Pending','Acknowledged','En Route','Resolved'];

function handleSendCoordination(e){
  e.preventDefault();
  const agencyId = document.getElementById('coordAgency').value;
  const agency = load(DB.agencies, []).find(a => a.id === agencyId);
  if(!agency){ alert('Select an agency to send the request to.'); return; }

  const req = {
    id: uid('coord'),
    agencyId: agency.id,
    agencyName: agency.name,
    agencyCategory: agency.category,
    supportType: document.getElementById('coordSupportType').value,
    incidentRef: document.getElementById('coordIncidentRef').value.trim(),
    details: document.getElementById('coordDetails').value.trim(),
    urgency: document.getElementById('coordUrgency').value,
    status: 'Pending',
    sentAt: nowISO(),
    history: [{ status:'Pending', at: nowISO(), note:'Request sent' }]
  };

  const list = load(DB.coordinations, []);
  list.unshift(req);
  save(DB.coordinations, list);

  logActivity('comms', `Coordination request sent to <b>${agency.name}</b> for ${req.supportType}${req.incidentRef ? ' — ' + req.incidentRef : ''}.`);

  document.getElementById('coordForm').reset();
  renderCoordLog();
}

function updateCoordStatus(id, newStatus){
  const list = load(DB.coordinations, []);
  const r = list.find(x => x.id === id);
  if(!r) return;
  r.status = newStatus;
  r.history = r.history || [];
  r.history.push({ status: newStatus, at: nowISO(), note: '' });
  save(DB.coordinations, list);
  logActivity('comms', `<b>${r.agencyName}</b> coordination request marked as <b>${newStatus}</b> (${r.supportType}).`);
  renderCoordLog();
}

function declineCoord(id){
  const list = load(DB.coordinations, []);
  const r = list.find(x => x.id === id);
  if(!r) return;
  if(!confirm(`Mark this request to ${r.agencyName} as declined/unavailable?`)) return;
  r.status = 'Declined';
  r.history = r.history || [];
  r.history.push({ status:'Declined', at: nowISO(), note:'' });
  save(DB.coordinations, list);
  logActivity('comms', `<b>${r.agencyName}</b> was unable to support the ${r.supportType} request${r.incidentRef ? ' — ' + r.incidentRef : ''}.`);
  renderCoordLog();
}

function coordStepper(r){
  if(r.status === 'Declined'){
    return `<div class="status-pill status-Unavailable" style="margin-top:6px;">✕ Declined / Unavailable</div>`;
  }
  const idx = COORD_STEPS.indexOf(r.status);
  return `<div class="status-stepper" style="margin-top:8px;">
    ${COORD_STEPS.map((s,i) => `
      <div class="step ${i < idx ? 'done' : i === idx ? 'current' : ''}">
        <div class="dot">${i < idx ? '✓' : i+1}</div>
        <div class="lbl">${s}</div>
      </div>
    `).join('')}
  </div>`;
}

function renderCoordLog(){
  const wrap = document.getElementById('coordLogList');
  const empty = document.getElementById('coordLogEmpty');
  const badge = document.getElementById('coordCountBadge');
  if(!wrap) return;

  const list = load(DB.coordinations, []);
  const active = list.filter(r => r.status !== 'Resolved' && r.status !== 'Declined');
  badge && (badge.textContent = active.length + ' Active');
  empty && (empty.style.display = list.length ? 'none' : 'block');

  wrap.innerHTML = list.map(r => `
    <div class="queue-card">
      <div class="qc-top">
        <div><b>${AGENCY_CATEGORY_ICONS[r.agencyCategory] || '📍'} ${r.agencyName}</b></div>
        <span class="badge">${r.urgency}</span>
      </div>
      <div class="request-card-detail" style="margin-top:6px;">${r.supportType}${r.incidentRef ? ' · ' + r.incidentRef : ''}</div>
      <div class="request-card-detail" style="color:#aaa;">${r.details}</div>
      <div class="queue-score">Sent ${timeAgo(r.sentAt)} · ${fmtTime(r.sentAt)}</div>
      ${coordStepper(r)}
      <div class="queue-actions" style="margin-top:10px;">
        ${r.status === 'Pending' ? `<button class="primary-btn" style="background:var(--blue); color:#fff;" onclick="updateCoordStatus('${r.id}','Acknowledged')">Mark Acknowledged</button>` : ''}
        ${r.status === 'Acknowledged' ? `<button class="primary-btn" style="background:var(--blue); color:#fff;" onclick="updateCoordStatus('${r.id}','En Route')">Mark En Route</button>` : ''}
        ${r.status === 'En Route' ? `<button class="primary-btn" style="background:var(--green); color:#111;" onclick="updateCoordStatus('${r.id}','Resolved')">Mark Resolved</button>` : ''}
        ${(r.status !== 'Resolved' && r.status !== 'Declined') ? `<button class="primary-btn" style="background:#333; color:#eee;" onclick="declineCoord('${r.id}')">Unable to Support</button>` : ''}
      </div>
    </div>
  `).join('');
}