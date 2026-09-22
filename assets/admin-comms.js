/* ============================================================
   e-Medicare — Barangay Bambang Admin Control Center
   COMMUNICATIONS MODULE (v2)


   Daloy:
     1) Pumili ng External Agency  -> matic ang Contact Person
        at ang External Request ID (auto-increment kada request)
     2) I-save ang request          -> status: PENDING (naka-log na,
        pero hindi pa tapos, walang response time pa)
     3) Kapag may update na galing sa agency, i-update ng admin ang
        Response / ETA / Remarks, o i-click ang "Mark Complete"
     4) Sa pag-Complete, doon lang naka-lock ang record at doon
        kinukwenta ang ACTUAL RESPONSE TIME (sent -> completed).
        Lumalabas ito sa Response Time Range (fastest / average /
        slowest) at sa printable report.


   Depende sa helpers ng admin.js:
   DB, load(), save(), uid(), nowISO(), fmtTime(), timeAgo(),
   logActivity(), statusClass()
   ============================================================ */




/* ---------------------------------------------------------
   STORAGE KEYS
--------------------------------------------------------- */
DB.agencies      = DB.agencies      || 'bmb_agencies';
DB.coordinations = DB.coordinations || 'bmb_coordinations';
DB.coordSeq      = DB.coordSeq      || 'bmb_coord_seq';   // BAGO — counter ng request ID




/* ---------------------------------------------------------
   SEED DATA (first run only)
--------------------------------------------------------- */
function seedCommsIfEmpty(){
  if(!localStorage.getItem(DB.agencies)){
    save(DB.agencies, [
      { id: uid('agy'), name:'MDRRMO Bulakan',                  category:'DRRMO',    contactPerson:'MDRRMO Office',           contact:'(044) 760-1111', services:'Ambulance, Rescue Truck, Manpower' },
      { id: uid('agy'), name:'Barangay Malinis DRRMO',           category:'Barangay', contactPerson:'Barangay Malinis Office', contact:'0917 111 2233',  services:'Patrol Vehicle, Manpower' },
      { id: uid('agy'), name:'City Fire Station 2 (BFP)',        category:'Fire',     contactPerson:'BFP Station 2 Desk',      contact:'(044) 123-4567', services:'Fire Truck, Rescue Personnel' },
      { id: uid('agy'), name:'Bambang Police Sub-Station (PNP)', category:'Police',   contactPerson:'PNP Desk Officer',        contact:'0918 444 5566',  services:'Patrol Car, Traffic Assistance' },
      { id: uid('agy'), name:'City General Hospital',            category:'Hospital', contactPerson:'ER Coordinator',          contact:'(044) 890-1122', services:'Ambulance, Patient Referral' },
      { id: uid('agy'), name:'Philippine Red Cross Chapter',     category:'NGO',      contactPerson:'PRC Chapter Office',      contact:'0920 333 4455',  services:'Ambulance, Medical Team' },
    ]);
  }
  if(!localStorage.getItem(DB.coordinations)) save(DB.coordinations, []);
  if(!localStorage.getItem(DB.coordSeq))      localStorage.setItem(DB.coordSeq, '0');


  /* Migration — lumang agency rows na walang contactPerson/services */
  const list = load(DB.agencies, []);
  let changed = false;
  list.forEach(a => {
    if(!a.contactPerson){ a.contactPerson = a.name + ' Office'; changed = true; }
    if(a.services === undefined){ a.services = ''; changed = true; }
  });
  if(changed) save(DB.agencies, list);
}
seedCommsIfEmpty();




if(typeof ACTIVITY_ICONS !== 'undefined'){
  ACTIVITY_ICONS.comms = '📡';
}




/* ---------------------------------------------------------
   REQUEST ID — auto at pataas kada request (EXT-2026-0001)
--------------------------------------------------------- */
function formatCoordRef(n){
  return 'EXT-' + new Date().getFullYear() + '-' + String(n).padStart(4, '0');
}
/* Preview lang — hindi pa kinakain ang numero */
function peekCoordRef(){
  return formatCoordRef(Number(localStorage.getItem(DB.coordSeq) || 0) + 1);
}
/* Aktwal na pagkuha — dito lang tumataas ang counter */
function takeCoordRef(){
  const n = Number(localStorage.getItem(DB.coordSeq) || 0) + 1;
  localStorage.setItem(DB.coordSeq, String(n));
  return formatCoordRef(n);
}




/* ---------------------------------------------------------
   ENTRY POINT
--------------------------------------------------------- */
function renderComms(){
  renderAgencyDirectory();
  populateCoordAgencySelect();
  populateCoordIncidentSelect();
  resetCoordForm();
  renderCoordLog();
}


document.addEventListener('DOMContentLoaded', () => {
  if(document.getElementById('comms-tab')) renderComms();
});




/* ---------------------------------------------------------
   AGENCY DIRECTORY
--------------------------------------------------------- */
const AGENCY_CATEGORY_ICONS = {
  Barangay:'🏘️', Fire:'🚒', Police:'🚓', Hospital:'🏥', DRRMO:'⚠️', NGO:'❤️'
};


function agencySortRank(a){
  const n = a.name.toLowerCase();
  if(n.includes('barangay')) return 0;      // mga barangay muna
  if(n.includes('bagumbayan')) return 1;    // susunod si Bagumbayan
  if(n.includes('mho-rhu') || n.includes('mho rhu')) return 3; // pangalawa sa hulihan
  if(n.includes('hospital')) return 4;      // hospital sa hulihan
  if(n.includes('pnp')) return 5;           // BAGO — PNP pinakahuli, sa ibaba ng hospital
  return 2;                                  // lahat ng iba, sa gitna
}


function renderAgencyDirectory(){
  const wrap = document.getElementById('agencyDirectory');
  if(!wrap) return;
  const list = [...load(DB.agencies, [])].sort((a, b) => agencySortRank(a) - agencySortRank(b));
  if(list.length === 0){
    wrap.innerHTML = '<div class="empty-state">Wala pang naka-rehistrong external agency.</div>';
    return;
  }
  wrap.innerHTML = list.map(a => `
    <div class="fleet-quick-row">
      <div>
        <div class="fleet-quick-name">${AGENCY_CATEGORY_ICONS[a.category] || '📍'} ${a.name}</div>
        <div class="fleet-quick-type">${a.contactPerson || '—'}</div>
        <div class="fleet-quick-type">${a.contact}</div>
        ${a.services ? `<div class="fleet-quick-type" style="color:#00e5ff;">Serbisyo: ${a.services}</div>` : ''}
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
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
    name:          document.getElementById('agencyName').value.trim(),
    contactPerson: document.getElementById('agencyContactPerson').value.trim(),
    contact:       document.getElementById('agencyContact').value.trim(),
    services:      document.getElementById('agencyServices').value.trim(),
  };
  if(id){
    const a = list.find(x => x.id === id);
    Object.assign(a, data);
    logActivity('comms', `Agency contact updated: <b>${a.name}</b>`);
  }else{
    const a = { id: uid('agy'), ...data };
    list.push(a);
    logActivity('comms', `New external agency added: <b>${a.name}</b>`);
  }
  save(DB.agencies, list);
  clearAgencyForm();
  renderAgencyDirectory();
  populateCoordAgencySelect();
}


function editAgency(id){
  const a = load(DB.agencies, []).find(x => x.id === id);
  if(!a) return;
  document.getElementById('agencyId').value            = a.id;
  document.getElementById('agencyName').value          = a.name;
  document.getElementById('agencyContactPerson').value = a.contactPerson || '';
  document.getElementById('agencyContact').value       = a.contact;
  document.getElementById('agencyServices').value      = a.services || '';
  document.getElementById('formAgencyTitle').textContent = '✏️ Edit Agency / Contact';
}


function removeAgency(id){
  if(!confirm('Tanggalin ang agency na ito sa directory?')) return;
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
  sel.innerHTML = '<option value="" disabled selected>Pumili ng agency / unit</option>' +
    list.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  if(current) sel.value = current;
}


/* Matic na fill-up kapag napindot ang agency */
function onCoordAgencyChange(){
  const a = load(DB.agencies, []).find(x => x.id === document.getElementById('coordAgency').value);
  const person   = document.getElementById('coordContactPerson');
  const hotline  = document.getElementById('coordHotline');
  const services = document.getElementById('coordServices');
  if(!a) return;
  if(person)  person.value  = a.contactPerson || (a.name + ' Office');
  if(hotline) hotline.value = a.contact || '';
  /* Serbisyo: isinusuggest ang naka-file na serbisyo, pero pwedeng
     i-type/i-palitan ng admin kung ano talaga ang ipinadala. */
  if(services && !services.value.trim()) services.value = a.services || '';
}




/* ---------------------------------------------------------
   LINK SA AKTWAL NA INCIDENT (SOS / Emergency) — kinukuha ang
   buong resident info (pangalan, contact, address, klase ng
   report) galing sa incidentsCache na pinupuno ng admin.js.
--------------------------------------------------------- */
function populateCoordIncidentSelect(){
  const sel = document.getElementById('coordIncidentSelect');
  if(!sel) return;
  const list = (typeof incidentsCache !== 'undefined' && incidentsCache) ? incidentsCache : [];
  const current = sel.value;


  const ALLOWED_COORD_STATUSES = ['Pending', 'Assigned'];


  const sorted = [...list]
    .filter(i => ALLOWED_COORD_STATUSES.includes(i.status))
    .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  sel.innerHTML = '<option value="">— Manual / Wala sa listahan (hal. tawag lang sa telepono) —</option>' +
    sorted.map(i => {
      const who = i.sender ? i.sender.name : 'Unknown Resident';
      const tag = i.type === 'SOS' ? '🚨 SOS' : '🚨 Emergency';
      return `<option value="${i.id}">${tag} — ${who} · ${i.category || i.type} · ${timeAgo(i.created_at)}</option>`;
    }).join('');


  if(current) sel.value = current;
}


function onCoordIncidentChange(){
  const sel = document.getElementById('coordIncidentSelect');
  const manualWrap = document.getElementById('coordManualIncidentWrap');
  const infoBox = document.getElementById('coordResidentInfoBox');
  if(!sel) return;


  if(!sel.value){
    if(manualWrap) manualWrap.style.display = 'block';
    if(infoBox) infoBox.style.display = 'none';
    return;
  }


  const list = (typeof incidentsCache !== 'undefined' && incidentsCache) ? incidentsCache : [];
  const inc = list.find(i => String(i.id) === String(sel.value));
  if(manualWrap) manualWrap.style.display = 'none';
  if(!inc || !infoBox) return;


  document.getElementById('coordResidentReportType').textContent = inc.type === 'SOS' ? '🚨 SOS Panic Button' : '🚨 Emergency Request';
  document.getElementById('coordResidentName').textContent = inc.sender ? inc.sender.name : 'Unknown Resident';
  document.getElementById('coordResidentContact').textContent = (inc.sender && inc.sender.contact) || 'Walang naitalang numero';
  document.getElementById('coordResidentAddress').textContent = (inc.sender && inc.sender.address) || 'Walang naitalang address';
  infoBox.style.display = 'block';
}




/* ---------------------------------------------------------
   COORDINATION REQUESTS
--------------------------------------------------------- */
const DEFAULT_COORD_REMARKS = 'Confirmed through phone call';




function resetCoordForm(){
  const form = document.getElementById('coordForm');
  if(!form) return;
  form.reset();
  document.getElementById('coordId').value = '';
  const ref = document.getElementById('coordRefDisplay');
  if(ref) ref.value = peekCoordRef();
  document.getElementById('coordContactPerson').value = '';
  document.getElementById('coordHotline').value = '';
  document.getElementById('coordRemarks').value = DEFAULT_COORD_REMARKS;
  const incSel = document.getElementById('coordIncidentSelect');
  if(incSel) incSel.value = '';
  const infoBox = document.getElementById('coordResidentInfoBox');
  if(infoBox) infoBox.style.display = 'none';
  const manualWrap = document.getElementById('coordManualIncidentWrap');
  if(manualWrap) manualWrap.style.display = 'block';
  document.getElementById('coordFormTitle').textContent = '📨Coordination Request';
  document.getElementById('coordSaveBtn').textContent   = '💾 I-save (Pending)';
  const cancel = document.getElementById('coordCancelBtn');
  if(cancel) cancel.style.display = 'none';
}


function handleSendCoordination(e){
  e.preventDefault();


  const list     = load(DB.coordinations, []);
  const editId   = document.getElementById('coordId').value;
  const agencyId = document.getElementById('coordAgency').value;
  const agency   = load(DB.agencies, []).find(a => a.id === agencyId);
  if(!agency){ alert('Pumili muna ng agency na papadalhan ng request.'); return; }


  /* Kaugnay na incident — kung may napiling aktwal na SOS/Emergency
     report, kunin ang buong resident info dito. Kung wala (manual
     entry, hal. tawag lang), gamitin na lang ang malayang text. */
  const incidentSel = document.getElementById('coordIncidentSelect');
  const linkedIncidentId = incidentSel ? incidentSel.value : '';
  let residentName = '', residentContact = '', residentAddress = '', incidentType = '', incidentLabel = '';


  if(linkedIncidentId){
    const incList = (typeof incidentsCache !== 'undefined' && incidentsCache) ? incidentsCache : [];
    const inc = incList.find(i => String(i.id) === String(linkedIncidentId));
    if(inc){
      residentName    = inc.sender ? inc.sender.name : 'Unknown Resident';
      residentContact = (inc.sender && inc.sender.contact) || '';
      residentAddress = (inc.sender && inc.sender.address) || '';
      incidentType    = inc.type === 'SOS' ? 'SOS Panic Button' : 'Emergency Request';
      incidentLabel   = `${inc.category || inc.type} — ${residentName}`;
    }
  }else{
    incidentLabel = document.getElementById('coordIncidentRef').value.trim();
  }


  const data = {
    agencyId:      agency.id,
    agencyName:    agency.name,
    contactPerson: document.getElementById('coordContactPerson').value.trim() || agency.contactPerson,
    hotline:       document.getElementById('coordHotline').value.trim() || agency.contact,
    services:      document.getElementById('coordServices').value.trim(),
    incidentId:      linkedIncidentId || null,
    incidentType:    incidentType,
    incidentRef:     incidentLabel,
    residentName:    residentName,
    residentContact: residentContact,
    residentAddress: residentAddress,
    details:       document.getElementById('coordDetails').value.trim(),
    urgency:       document.getElementById('coordUrgency').value,
    response:      document.getElementById('coordResponse').value,
    eta:           document.getElementById('coordETA').value.trim(),
    remarks:       document.getElementById('coordRemarks').value.trim() || DEFAULT_COORD_REMARKS,
  };




  if(editId){
    /* ---- UPDATE ng existing na Pending request ---- */
    const r = list.find(x => x.id === editId);
    if(!r) return;
    Object.assign(r, data);
    r.history = r.history || [];
    r.history.push({ status:'Updated', at: nowISO(), note:`Response: ${data.response} · ETA: ${data.eta || '—'}` });
    save(DB.coordinations, list);
    logActivity('comms', `Coordination request <b>${r.refId}</b> updated — ${data.response}${data.eta ? ' · ETA ' + data.eta : ''}.`);
  }else{
    /* ---- BAGONG request ---- */
    const req = {
      id: uid('coord'),
      refId: takeCoordRef(),          // auto-increment dito lang
      ...data,
      status: 'Pending',              // hindi pa tapos — hindi pa kasama sa response time
      sentAt: nowISO(),
      completedAt: null,
      responseMs: null,
      history: [{ status:'Pending', at: nowISO(), note:'Request na-log' }]
    };
    list.unshift(req);
    save(DB.coordinations, list);
    logActivity('comms', `Coordination request <b>${req.refId}</b> sent to <b>${agency.name}</b>${req.services ? ' — ' + req.services : ''}.`);
  }


  resetCoordForm();
  renderCoordLog();
}


/* I-load pabalik sa form ang isang Pending request para i-update */
function editCoordRequest(id){
  const r = load(DB.coordinations, []).find(x => x.id === id);
  if(!r) return;
  document.getElementById('coordId').value            = r.id;
  document.getElementById('coordRefDisplay').value    = r.refId;
  document.getElementById('coordAgency').value        = r.agencyId;
  document.getElementById('coordContactPerson').value = r.contactPerson || '';
  document.getElementById('coordHotline').value       = r.hotline || '';
  document.getElementById('coordServices').value      = r.services || '';


  const incSel = document.getElementById('coordIncidentSelect');
  if(r.incidentId && incSel){
    incSel.value = r.incidentId;
    onCoordIncidentChange();
  }else{
    if(incSel) incSel.value = '';
    document.getElementById('coordIncidentRef').value = r.incidentRef || '';
    const manualWrap = document.getElementById('coordManualIncidentWrap');
    if(manualWrap) manualWrap.style.display = 'block';
    const infoBox = document.getElementById('coordResidentInfoBox');
    if(infoBox) infoBox.style.display = 'none';
  }
  document.getElementById('coordDetails').value       = r.details || '';
  document.getElementById('coordUrgency').value       = r.urgency;
  document.getElementById('coordResponse').value      = r.response || 'PENDING';
  document.getElementById('coordETA').value           = r.eta || '';
  document.getElementById('coordRemarks').value       = r.remarks || DEFAULT_COORD_REMARKS;


  document.getElementById('coordFormTitle').textContent = `✏️ I-update ang ${r.refId}`;
  document.getElementById('coordSaveBtn').textContent   = '💾 I-save ang Update';
  document.getElementById('coordCancelBtn').style.display = 'inline-block';
  document.getElementById('coordForm').scrollIntoView({ behavior:'smooth', block:'nearest' });
}


/* TAPOS NA — dito lang nag-fi-final save at dito kinukwenta ang response time */
function completeCoord(id){
  const list = load(DB.coordinations, []);
  const r = list.find(x => x.id === id);
  if(!r) return;
  if(!confirm(`I-mark na TAPOS ang ${r.refId} (${r.agencyName})? Dito na malo-lock ang record at makukuha ang response time.`)) return;


  r.status      = 'Completed';
  r.completedAt = nowISO();
  r.responseMs  = new Date(r.completedAt) - new Date(r.sentAt);
  r.history     = r.history || [];
  r.history.push({ status:'Completed', at: r.completedAt, note:'Natapos ang coordination' });
  save(DB.coordinations, list);


  logActivity('comms', `Coordination <b>${r.refId}</b> completed — ${r.agencyName} · response time ${durationLabel(r.responseMs)}.`);
  renderCoordLog();
}


function declineCoord(id){
  const list = load(DB.coordinations, []);
  const r = list.find(x => x.id === id);
  if(!r) return;
  if(!confirm(`I-mark ang ${r.refId} bilang declined / hindi natuloy?`)) return;
  r.status      = 'Declined';
  r.response    = 'DECLINED';
  r.completedAt = nowISO();
  r.responseMs  = null;   // hindi kasama sa response time stats
  r.history     = r.history || [];
  r.history.push({ status:'Declined', at: r.completedAt, note:'' });
  save(DB.coordinations, list);
  logActivity('comms', `<b>${r.agencyName}</b> hindi nakasuporta sa request <b>${r.refId}</b>.`);
  renderCoordLog();
}




/* ---------------------------------------------------------
   RESPONSE TIME HELPERS
--------------------------------------------------------- */
function durationLabel(ms){
  if(ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  const totalMin = Math.floor(ms / 60000);
  if(totalMin < 1) return Math.max(1, Math.round(ms/1000)) + 's';
  if(totalMin < 60) return totalMin + 'm';
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h + 'h' + (m ? ' ' + m + 'm' : '');
}


/* Ginagamit din ng Reports tab */
function coordinationStats(){
  const list = load(DB.coordinations, []);
  const done = list.filter(r => r.status === 'Completed' && typeof r.responseMs === 'number');
  const times = done.map(r => r.responseMs);
  return {
    total:     list.length,
    pending:   list.filter(r => r.status === 'Pending').length,
    completed: done.length,
    declined:  list.filter(r => r.status === 'Declined').length,
    fastestMs: times.length ? Math.min(...times) : null,
    slowestMs: times.length ? Math.max(...times) : null,
    averageMs: times.length ? Math.round(times.reduce((a,b) => a+b, 0) / times.length) : null,
  };
}
window.coordinationStats = coordinationStats;


function renderCoordSummary(){
  const wrap = document.getElementById('coordSummaryStrip');
  if(!wrap) return;
  const s = coordinationStats();
  const range = (s.fastestMs === null)
    ? 'Wala pang natapos na request'
    : `${durationLabel(s.fastestMs)} – ${durationLabel(s.slowestMs)}`;
  wrap.innerHTML = `
    <div class="fleet-summary-strip">
      <div class="fleet-summary-chip"><div class="n" style="color:var(--blue);">${s.pending}</div><div class="l">Pending</div></div>
      <div class="fleet-summary-chip"><div class="n" style="color:var(--green);">${s.completed}</div><div class="l">Completed</div></div>
      <div class="fleet-summary-chip"><div class="n" style="color:#00e5ff;font-size:.8em;">${range}</div><div class="l">Response Time Range</div></div>
      <div class="fleet-summary-chip"><div class="n" style="color:#ffd700;font-size:.8em;">${durationLabel(s.averageMs)}</div><div class="l">Average</div></div>
    </div>`;
}




/* ---------------------------------------------------------
   COORDINATION LOG (Pending + Completed records)
--------------------------------------------------------- */
function responsePill(resp){
  const map = {
    ACCEPTED: 'background:#123a1c;color:#8aff9c;',
    DECLINED: 'background:#3a1c1c;color:#ff8a8a;',
    PENDING:  'background:#3a2a10;color:#ffcc66;',
  };
  return `<span class="badge" style="${map[resp] || map.PENDING}">${resp || 'PENDING'}</span>`;
}


function coordCardHTML(r, isDone){
  const rows = [
    ['External Request ID', `<b style="color:#00e5ff;">${r.refId}</b>`],
    ['Contact Person', r.contactPerson || '—'],
    ['Available Services', r.services || '—'],
    ['Response', responsePill(r.response)],
    ['ETA', r.eta || '—'],
    ['Remarks', r.remarks || '—'],
  ];
  if(r.incidentRef) rows.splice(3, 0, ['Related Incident', r.incidentRef]);
  if(r.documentName) rows.push(['Dokumento', '📎 ' + r.documentName]);
  if(isDone) rows.push(['Response Time', `<b style="color:${r.responseMs !== null ? 'var(--green)' : '#888'};">${durationLabel(r.responseMs)}</b>`]);


  const residentBox = (r.residentName) ? `
    <div style="margin-top:8px; font-size:.8em; color:#ccc; background:#222; padding:9px 10px; border-radius:6px;">
      <div style="font-weight:600; color:#ffd700;">${r.incidentType ? '🚨 ' + r.incidentType : '🚨 Resident Report'}</div>
      <div>👤 ${r.residentName}</div>
      ${r.residentContact ? `<div>📞 ${r.residentContact}</div>` : ''}
      ${r.residentAddress ? `<div style="color:#aaa;">🏠 ${r.residentAddress}</div>` : ''}
    </div>` : '';


  return `
    <div class="queue-card">
      <div class="qc-top">
        <div><b>${AGENCY_CATEGORY_ICONS[r.agencyCategory] || '📍'} ${r.agencyName}</b></div>
        <span class="badge">${r.urgency}</span>
      </div>
      ${residentBox}
      <div style="font-size:.8em; margin-top:8px;">
        ${rows.map(([l, v]) => `
          <div style="display:flex; justify-content:space-between; gap:12px; padding:4px 0; border-bottom:1px solid #2a2a2a;">
            <span style="color:#888; flex:0 0 140px;">${l}</span>
            <span style="text-align:right; color:#eee; flex:1;">${v}</span>
          </div>`).join('')}
      </div>
      ${r.details ? `<div class="request-card-detail" style="color:#aaa; margin-top:8px;">${r.details}</div>` : ''}
      <div class="queue-score">Na-log ${timeAgo(r.sentAt)} · ${fmtTime(r.sentAt)}${r.completedAt ? ' → tapos ' + fmtTime(r.completedAt) : ''}</div>
      <div class="queue-actions" style="margin-top:10px;">
        ${!isDone ? `
          <button class="primary-btn" style="background:#333; color:#eee;" onclick="editCoordRequest('${r.id}')">✏️ I-update ang Response</button>
          <button class="primary-btn" style="background:var(--green); color:#111;" onclick="completeCoord('${r.id}')">✅ Mark Complete</button>
          <button class="primary-btn" style="background:#3a1c1c; color:#ff8a8a;" onclick="declineCoord('${r.id}')">✕ Hindi Natuloy</button>
        ` : `
          <button class="primary-btn" style="background:#333; color:#eee;" onclick="printCoordRecord('${r.id}')">🖨️ Print</button>
        `}
      </div>
    </div>`;
}


function renderCoordLog(){
  renderCoordSummary();


  const wrap    = document.getElementById('coordLogList');
  const empty   = document.getElementById('coordLogEmpty');
  const badge   = document.getElementById('coordCountBadge');
  const hist    = document.getElementById('coordHistoryList');
  const histBdg = document.getElementById('coordHistoryCountBadge');
  if(!wrap) return;


  const list    = load(DB.coordinations, []);
  const pending = list.filter(r => r.status === 'Pending');
  const done    = list.filter(r => r.status === 'Completed' || r.status === 'Declined');




  badge && (badge.textContent = pending.length + ' Pending');
  empty && (empty.style.display = pending.length ? 'none' : 'block');
  wrap.innerHTML = pending.map(r => coordCardHTML(r, false)).join('');


  if(hist){
    histBdg && (histBdg.textContent = done.length + ' Records');
    hist.innerHTML = done.length
      ? done.map(r => coordCardHTML(r, true)).join('')
      : '<div class="empty-state" style="padding:12px;">Wala pang natapos na coordination request.</div>';
  }
}




/* Ilagay sa Trash ang isang completed/declined na record — hindi pa
   ito tuluyang tinatanggal, para may paraan pang mabawi kung nagkamali. */
function deleteCoordRecord(id){
  const list = load(DB.coordinations, []);
  const r = list.find(x => x.id === id);
  if(!r) return;
  if(!confirm(`Ilipat sa Trash ang record na ${r.refId} (${r.agencyName})? Makikita mo pa rin ito sa Trash kung sakaling kailangan pang ibalik.`)) return;


  r.statusBeforeDelete = r.status;   // para malaman kung saan ibabalik
  r.status = 'Deleted';
  r.deletedAt = nowISO();
  save(DB.coordinations, list);
  logActivity('comms', `Coordination record <b>${r.refId}</b> (${r.agencyName}) inilipat sa Trash.`);
  renderCoordLog();
}


/* Ibalik pabalik sa Completed Records ang isang na-trash na record */
function restoreCoordRecord(id){
  const list = load(DB.coordinations, []);
  const r = list.find(x => x.id === id);
  if(!r) return;


  r.status = r.statusBeforeDelete || 'Completed';
  delete r.statusBeforeDelete;
  delete r.deletedAt;
  save(DB.coordinations, list);
  logActivity('comms', `Coordination record <b>${r.refId}</b> (${r.agencyName}) naibalik mula sa Trash.`);
  renderCoordLog();
  renderCoordTrash();
}


/* Tuluyan nang tanggalin — dito na hindi na mababawi pa */
function permanentlyDeleteCoordRecord(id){
  const r = load(DB.coordinations, []).find(x => x.id === id);
  if(!r) return;
  if(!confirm(`Tuluyan bang tanggalin ang ${r.refId} (${r.agencyName})? Hindi na ito maibabalik pa.`)) return;


  save(DB.coordinations, load(DB.coordinations, []).filter(x => x.id !== id));
  logActivity('comms', `Coordination record <b>${r.refId}</b> (${r.agencyName}) tuluyang tinanggal mula sa Trash.`);
  renderCoordTrash();
  renderCoordLog();
}


function openCoordTrashModal(){
  renderCoordTrash();
  const modal = document.getElementById('coordTrashModal');
  if(modal) modal.style.display = 'flex';
}
function closeCoordTrashModal(){
  const modal = document.getElementById('coordTrashModal');
  if(modal) modal.style.display = 'none';
}


function renderCoordTrash(){
  const wrap = document.getElementById('coordTrashList');
  if(!wrap) return;
  const trashed = load(DB.coordinations, [])
    .filter(r => r.status === 'Deleted')
    .sort((a,b) => new Date(b.deletedAt) - new Date(a.deletedAt));


  const badge = document.getElementById('coordTrashCountBadge');
  badge && (badge.textContent = trashed.length);


  if(trashed.length === 0){
    wrap.innerHTML = '<div class="empty-state" style="padding:14px;">Walang laman ang Trash.</div>';
    return;
  }


  wrap.innerHTML = trashed.map(r => `
    <div class="fleet-quick-row">
      <div>
        <div class="fleet-quick-name">${AGENCY_CATEGORY_ICONS[r.agencyCategory] || '📍'} ${r.agencyName}</div>
        <div class="fleet-quick-type">${r.refId} · na-delete ${timeAgo(r.deletedAt)}</div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <button class="primary-btn" style="background:#123a1c;color:#8aff9c;font-size:.7em;padding:5px 9px;" onclick="restoreCoordRecord('${r.id}')">↩️ Ibalik</button>
        <button class="primary-btn" style="background:#3a1c1c;color:#ff8a8a;font-size:.7em;padding:5px 9px;" onclick="permanentlyDeleteCoordRecord('${r.id}')">🗑️ Tuluyang Tanggalin</button>
      </div>
    </div>
  `).join('');
}




/* ---------------------------------------------------------
   PRINT — isang natapos na coordination record
--------------------------------------------------------- */
function printCoordRecord(id){
  const r = load(DB.coordinations, []).find(x => x.id === id);
  if(!r){ alert('Record not found.'); return; }


  const w = window.open('', '_blank', 'width=800,height=900');
  w.document.write(`
    <html><head><title>Coordination Record - ${r.refId}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 30px; color: #111; }
      h1 { font-size: 18px; border-bottom: 2px solid #333; padding-bottom: 8px; }
      table { width: 100%; border-collapse: collapse; margin-top: 16px; }
      td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; font-size: 13px; }
      th { width: 200px; color: #555; }
      .footer { margin-top: 40px; font-size: 11px; color: #777; }
    </style></head>
    <body>
      <h1>e-Medicare — Barangay Bambang External Coordination Record</h1>
      <table>
        <tr><th>External Request ID</th><td>${r.refId}</td></tr>
        <tr><th>External Agency</th><td>${r.agencyName}</td></tr>
        <tr><th>Contact Person</th><td>${r.contactPerson || 'N/A'}${r.hotline ? ' · ' + r.hotline : ''}</td></tr>
        <tr><th>Available Services</th><td>${r.services || 'N/A'}</td></tr>
        <tr><th>Dokumento / Proof</th><td>${r.documentName || 'Wala'}</td></tr>
        <tr><th>Related Incident</th><td>${r.incidentRef || 'N/A'}</td></tr>
        ${r.residentName ? `
        <tr><th colspan="2" style="background:#f2f2f2; color:#333;">Resident Info (${r.incidentType || 'Report'})</th></tr>
        <tr><th>Resident Name</th><td>${r.residentName}</td></tr>
        <tr><th>Contact Number</th><td>${r.residentContact || 'N/A'}</td></tr>
        <tr><th>Address</th><td>${r.residentAddress || 'N/A'}</td></tr>
        ` : ''}
        <tr><th>Details</th><td>${r.details || 'N/A'}</td></tr>
        <tr><th>Urgency</th><td>${r.urgency}</td></tr>
        <tr><th>Response</th><td>${r.response || 'PENDING'}</td></tr>
        <tr><th>ETA</th><td>${r.eta || 'N/A'}</td></tr>
        <tr><th>Remarks</th><td>${r.remarks || 'N/A'}</td></tr>
        <tr><th>Date Requested</th><td>${fmtTime(r.sentAt)}</td></tr>
        <tr><th>Date Completed</th><td>${r.completedAt ? fmtTime(r.completedAt) : 'Pending'}</td></tr>
        <tr><th>Actual Response Time</th><td>${durationLabel(r.responseMs)}</td></tr>
      </table>
      <div class="footer">Generated ${fmtTime(nowISO())} · e-Medicare Barangay Bambang Control Center</div>
    </body></html>
  `);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

