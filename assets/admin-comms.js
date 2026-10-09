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
   SUPABASE CACHES
--------------------------------------------------------- */
let agenciesCache = [];
let coordCache = [];

function mapAgency(r){
  return { id:r.id, name:r.name, category:r.category||'', contactPerson:r.contact_person||'',
           contact:r.contact||'', services:r.services||'' };
}
function mapCoord(r){
  return {
    id:r.id, refId:r.ref_id, agencyId:r.agency_id, agencyName:r.agency_name,
    agencyCategory:r.agency_category||'', contactPerson:r.contact_person, hotline:r.hotline,
    services:r.services, incidentId:r.incident_id, incidentType:r.incident_type,
    incidentRef:r.incident_ref, residentName:r.resident_name, residentContact:r.resident_contact,
    residentAddress:r.resident_address, details:r.details, urgency:r.urgency, response:r.response,
    eta:r.eta, remarks:r.remarks, status:r.status, sentAt:r.sent_at, completedAt:r.completed_at,
    responseMs: r.response_ms === null || r.response_ms === undefined ? null : Number(r.response_ms),
    history:r.history||[], documentName:r.document_name,
    statusBeforeDelete:r.status_before_delete, deletedAt:r.deleted_at
  };
}

async function loadAgencies(){
  const { data, error } = await supabase.from('agencies').select('*').order('name');
  if(error){ console.error('Hindi makuha ang agencies:', error.message); return; }
  agenciesCache = (data || []).map(mapAgency);
  renderAgencyDirectory();
  populateCoordAgencySelect();
}

async function loadCoordinations(){
  const { data, error } = await supabase.from('coordinations').select('*').order('sent_at', { ascending:false });
  if(error){ console.error('Hindi makuha ang coordinations:', error.message); return; }
  coordCache = (data || []).map(mapCoord);
  const ref = document.getElementById('coordRefDisplay');
  if(ref && !document.getElementById('coordId').value) ref.value = peekCoordRef();
  renderCoordLog();
}

function subscribeCommsRealtime(){
  supabase.channel('comms-agencies')
    .on('postgres_changes', { event:'*', schema:'public', table:'agencies' }, loadAgencies)
    .subscribe();
  supabase.channel('comms-coordinations')
    .on('postgres_changes', { event:'*', schema:'public', table:'coordinations' }, loadCoordinations)
    .subscribe();
}


if(typeof ACTIVITY_ICONS !== 'undefined'){
  ACTIVITY_ICONS.comms = '📡';
}




/* Preview lang. Ang totoong numero ay ibinibigay ng database kapag nag-save */
function formatCoordRef(n){
  return 'EXT-' + new Date().getFullYear() + '-' + String(n).padStart(4, '0');
}
function peekCoordRef(){
  const nums = coordCache
    .map(r => Number(String(r.refId || '').split('-').pop()))
    .filter(n => !Number.isNaN(n));
  return formatCoordRef((nums.length ? Math.max(...nums) : 0) + 1);
}




/* ---------------------------------------------------------
   ENTRY POINT
--------------------------------------------------------- */
function renderComms(){
  renderAgencyDirectory();
  populateCoordAgencySelect();
  populateCoordIncidentSelect();
    if(!document.getElementById('coordRefDisplay').value) resetCoordForm();
  renderCoordLog();
}


document.addEventListener('DOMContentLoaded', async () => {
  if(!document.getElementById('comms-tab')) return;
  await loadAgencies();
  await loadCoordinations();
  subscribeCommsRealtime();
  renderComms();
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
    const list = [...agenciesCache].sort((a, b) => agencySortRank(a) - agencySortRank(b));
  if(list.length === 0){
    wrap.innerHTML = '<div class="empty-state">Wala pang naka-rehistrong external agency.</div>';
    return;
  }
  wrap.innerHTML = list.map(a => `
    <div class="fleet-quick-row">
      <div>
        <div class="fleet-quick-name">${AGENCY_CATEGORY_ICONS[a.category] || '📍'} ${esc(a.name)}</div>
        <div class="fleet-quick-type">${esc(a.contactPerson || '—')}</div>
        <div class="fleet-quick-type">${esc(a.contact)}</div>
        ${a.services ? `<div class="fleet-quick-type" style="color:#00e5ff;">Serbisyo: ${esc(a.services)}</div>` : ''}
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <button class="primary-btn" style="background:#333;color:#eee;font-size:.68em;padding:5px 8px;" onclick="editAgency('${a.id}')">Edit</button>
        <button class="primary-btn" style="background:#3a1c1c;color:#ff8a8a;font-size:.68em;padding:5px 8px;" onclick="removeAgency('${a.id}')">Remove</button>
      </div>
    </div>
  `).join('');
}


async function handleAgencySubmit(e){
  e.preventDefault();
  const id = document.getElementById('agencyId').value;
  const data = {
    name:           document.getElementById('agencyName').value.trim(),
    category:       document.getElementById('agencyCategory').value,
    contact_person: document.getElementById('agencyContactPerson').value.trim(),
    contact:        document.getElementById('agencyContact').value.trim(),
    services:       document.getElementById('agencyServices').value.trim(),
  };
  if(id){
    const { error } = await supabase.from('agencies').update(data).eq('id', id);
    if(error){ alert('Hindi na-update: ' + error.message); return; }
    logActivity('comms', `Agency contact updated: <b>${esc(data.name)}</b>`);
  }else{
    const { error } = await supabase.from('agencies').insert(data);
    if(error){ alert('Hindi naidagdag: ' + error.message); return; }
    logActivity('comms', `New external agency added: <b>${esc(data.name)}</b>`);
  }
  clearAgencyForm();
  await loadAgencies();
}


function editAgency(id){
  const a = agenciesCache.find(x => x.id === id);
  if(!a) return;
  document.getElementById('agencyId').value            = a.id;
  document.getElementById('agencyName').value          = a.name;
    document.getElementById('agencyCategory').value      = a.category || '';
  document.getElementById('agencyContactPerson').value = a.contactPerson || '';
  document.getElementById('agencyContact').value       = a.contact;
  document.getElementById('agencyServices').value      = a.services || '';
  document.getElementById('formAgencyTitle').textContent = '✏️ Edit Agency / Contact';
}


async function removeAgency(id){
  if(!confirm('Tanggalin ang agency na ito sa directory?')) return;
  const { error } = await supabase.from('agencies').delete().eq('id', id);
  if(error){ alert('Hindi matanggal: ' + error.message); return; }
  logActivity('comms', 'An external agency contact was removed from the directory.');
  await loadAgencies();
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
  const list = agenciesCache;
  const current = sel.value;
  sel.innerHTML = '<option value="" disabled selected>Pumili ng agency / unit</option>' +
    list.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  if(current) sel.value = current;
}


/* Matic na fill-up kapag napindot ang agency */
function onCoordAgencyChange(){
  const a = agenciesCache.find(x => x.id === document.getElementById('coordAgency').value);
  const person   = document.getElementById('coordContactPerson');
  const hotline  = document.getElementById('coordHotline');
  const services = document.getElementById('coordServices');
  if(!a) return;
  if(person)  person.value  = a.contactPerson || (a.name + ' Office');
  if(hotline) hotline.value = a.contact || '';
  /* Serbisyo: isinusuggest ang naka-file na serbisyo, pero pwedeng
     i-type/i-palitan ng admin kung ano talaga ang ipinadala. */
    if(services) services.value = a.services || '';
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
   sel.innerHTML = '<option value="">— Manual / Wala sa listahan —</option>' +
    '<option value="__phone">📞 Phone Call</option>' +
    '<option value="__message">💬 Message</option>' +
    sorted.map(i => {
      const who = i.sender ? i.sender.name : 'Unknown Resident';
      const tag = i.type === 'SOS' ? '🚨 SOS' : '🚨 Emergency';
      return `<option value="${i.id}">${tag} — ${esc(who)} · ${esc(i.category || i.type)} · ${timeAgo(i.created_at)}</option>`;
    }).join('');


  if(current) sel.value = current;
}


function onCoordIncidentChange(){
  const sel = document.getElementById('coordIncidentSelect');
  const manualWrap = document.getElementById('coordManualIncidentWrap');
  const infoBox = document.getElementById('coordResidentInfoBox');
  if(!sel) return;


    if(!sel.value || sel.value.startsWith('__')){
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


async function handleSendCoordination(e){
  e.preventDefault();
   guardSubmit(e); 

  const editId   = document.getElementById('coordId').value;
  const agencyId = document.getElementById('coordAgency').value;
  const agency   = agenciesCache.find(a => String(a.id) === String(agencyId));
  if(!agency){ alert('Pumili muna ng agency na papadalhan ng request.'); return; }

    const incidentSel = document.getElementById('coordIncidentSelect');
  const rawIncidentValue = incidentSel ? incidentSel.value : '';
  const reportSource = rawIncidentValue === '__phone' ? 'Phone Call'
                     : rawIncidentValue === '__message' ? 'Message' : '';
  const linkedIncidentId = rawIncidentValue.startsWith('__') ? '' : rawIncidentValue;
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
    const typed = document.getElementById('coordIncidentRef').value.trim();
    incidentLabel = reportSource ? (typed ? `[${reportSource}] ${typed}` : `[${reportSource}]`) : typed;
  }

  const data = {
    agency_id:        agency.id,
    agency_name:      agency.name,
    agency_category:  agency.category || '',
    contact_person:   document.getElementById('coordContactPerson').value.trim() || agency.contactPerson,
    hotline:          document.getElementById('coordHotline').value.trim() || agency.contact,
    services:         document.getElementById('coordServices').value.trim(),
    incident_id:      linkedIncidentId || null,
    incident_type:    incidentType,
    incident_ref:     incidentLabel,
    resident_name:    residentName,
    resident_contact: residentContact,
    resident_address: residentAddress,
    details:          document.getElementById('coordDetails').value.trim(),
    urgency:          document.getElementById('coordUrgency').value,
    response:         document.getElementById('coordResponse').value,
    eta:              document.getElementById('coordETA').value.trim(),
    remarks:          document.getElementById('coordRemarks').value.trim() || DEFAULT_COORD_REMARKS,
  };

  if(editId){
    const r = coordCache.find(x => x.id === editId);
    if(!r) return;
    if(r.incidentId && !linkedIncidentId){
      data.incident_id      = r.incidentId;
      data.incident_type    = r.incidentType;
      data.incident_ref     = r.incidentRef;
      data.resident_name    = r.residentName;
      data.resident_contact = r.residentContact;
      data.resident_address = r.residentAddress;
    }
    const history = [...(r.history || []), { status:'Updated', at: nowISO(), note:`Response: ${data.response} · ETA: ${data.eta || '—'}` }];
    const { error } = await supabase.from('coordinations').update({ ...data, history }).eq('id', editId);
    if(error){ alert('Hindi na-update: ' + error.message); return; }
    logActivity('comms', `Coordination request <b>${r.refId}</b> updated — ${data.response}${data.eta ? ' · ETA ' + data.eta : ''}.`);
  }else{
    const { data: created, error } = await supabase.from('coordinations')
      .insert({ ...data, status:'Pending', history:[{ status:'Pending', at: nowISO(), note:'Request na-log' }] })
      .select().single();
    if(error){ alert('Hindi na-save: ' + error.message); return; }
    logActivity('comms', `Coordination request <b>${created.ref_id}</b> sent to <b>${esc(agency.name)}</b>${data.services ? ' — ' + esc(data.services) : ''}.`);
  }

  resetCoordForm();
  await loadCoordinations();
}


/* I-load pabalik sa form ang isang Pending request para i-update */
function editCoordRequest(id){
  const r = coordCache.find(x => x.id === id);
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
    const refText = r.incidentRef || '';
    const srcMatch = refText.match(/^\[(Phone Call|Message)\]\s*/);
    if(srcMatch && incSel) incSel.value = srcMatch[1] === 'Phone Call' ? '__phone' : '__message';
    document.getElementById('coordIncidentRef').value = srcMatch ? refText.replace(srcMatch[0], '') : refText;
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
async function completeCoord(id){
  const r = coordCache.find(x => x.id === id);
  if(!r) return;
  if(!confirm(`I-mark na TAPOS ang ${r.refId} (${r.agencyName})? Dito na malo-lock ang record at makukuha ang response time.`)) return;

  const completedAt = nowISO();
  const responseMs = new Date(completedAt) - new Date(r.sentAt);
  const history = [...(r.history || []), { status:'Completed', at: completedAt, note:'Natapos ang coordination' }];

  const { error } = await supabase.from('coordinations')
    .update({ status:'Completed', completed_at: completedAt, response_ms: responseMs, history })
    .eq('id', id);
  if(error){ alert('Hindi na-update: ' + error.message); return; }

  logActivity('comms', `Coordination <b>${r.refId}</b> completed — ${esc(r.agencyName)} · response time ${durationLabel(responseMs)}.`);

  // Awtomatikong isara ang naka-link na SOS/Emergency kung wala pang sariling team na naka-dispatch
  if(r.incidentId){
    const { data: closed, error: incError } = await supabase
      .from('emergency_requests')
      .update({
        status: 'Resolved',
        completed_at: completedAt,
        eta: `Hinawakan ng external agency: ${r.agencyName} (${r.refId})`
      })
      .eq('id', r.incidentId)
      .in('status', ['Pending', 'Waiting List'])
      .select('id, sender_id, category, type');

    if(incError){
      console.error('Hindi na-close ang naka-link na incident:', incError.message);
      alert('Natapos ang coordination, pero hindi na-close ang naka-link na incident: ' + incError.message);
    }else if(closed && closed.length){
      const inc = closed[0];
      logActivity('dispatch', `${esc(inc.category || inc.type)} incident awtomatikong na-resolve — hinawakan ng <b>${esc(r.agencyName)}</b> (${r.refId}).`);

      if(inc.sender_id){
        await supabase.from('notifications').insert({
          receiver_id: inc.sender_id,
          title: 'Emergency Report Update',
          message: `Natugunan ang iyong emergency report sa tulong ng ${r.agencyName}.`
        });
      }

      if(typeof stopSOSAlertLoop === 'function') stopSOSAlertLoop();
      if(typeof loadIncidentsFromSupabase === 'function') await loadIncidentsFromSupabase();
    }
  }

  await loadCoordinations();
}


async function declineCoord(id){
  const r = coordCache.find(x => x.id === id);
  if(!r) return;
  if(!confirm(`I-mark ang ${r.refId} bilang declined / hindi natuloy?`)) return;

  const at = nowISO();
  const history = [...(r.history || []), { status:'Declined', at, note:'' }];
  const { error } = await supabase.from('coordinations')
    .update({ status:'Declined', response:'DECLINED', completed_at: at, response_ms: null, history })
    .eq('id', id);
  if(error){ alert('Hindi na-update: ' + error.message); return; }

  logActivity('comms', `<b>${esc(r.agencyName)}</b> hindi nakasuporta sa request <b>${r.refId}</b>.`);
  await loadCoordinations();
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
  const list = coordCache;
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
  if(r.incidentRef) rows.splice(3, 0, ['Related Incident', esc(r.incidentRef)]);
  if(r.documentName) rows.push(['Dokumento', '📎 ' + r.documentName]);
  if(isDone) rows.push(['Response Time', `<b style="color:${r.responseMs !== null ? 'var(--green)' : '#888'};">${durationLabel(r.responseMs)}</b>`]);


  const residentBox = (r.residentName) ? `
    <div style="margin-top:8px; font-size:.8em; color:#ccc; background:#222; padding:9px 10px; border-radius:6px;">
      <div style="font-weight:600; color:#ffd700;">${r.incidentType ? '🚨 ' + r.incidentType : '🚨 Resident Report'}</div>
      <div>👤 ${esc(r.residentName)}</div>
      ${r.residentContact ? `<div>📞 ${esc(r.residentContact)}</div>` : ''}
      ${r.residentAddress ? `<div style="color:#aaa;">🏠 ${esc(r.residentAddress)}</div>` : ''}
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
      ${r.details ? `<div class="request-card-detail" style="color:#aaa; margin-top:8px;">${esc(r.details)}</div>` : ''}
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


  const list    = coordCache;
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
async function deleteCoordRecord(id){
  const r = coordCache.find(x => x.id === id);
  if(!r) return;
  if(!confirm(`Ilipat sa Trash ang record na ${r.refId} (${r.agencyName})?`)) return;

  const { error } = await supabase.from('coordinations')
    .update({ status:'Deleted', status_before_delete: r.status, deleted_at: nowISO() })
    .eq('id', id);
  if(error){ alert('Hindi na-update: ' + error.message); return; }

  logActivity('comms', `Coordination record <b>${r.refId}</b> (${esc(r.agencyName)}) inilipat sa Trash.`);
  await loadCoordinations();
  renderCoordTrash();
}

/* Ibalik pabalik sa Completed Records ang isang na-trash na record */
async function restoreCoordRecord(id){
  const r = coordCache.find(x => x.id === id);
  if(!r) return;

  const { error } = await supabase.from('coordinations')
    .update({ status: r.statusBeforeDelete || 'Completed', status_before_delete: null, deleted_at: null })
    .eq('id', id);
  if(error){ alert('Hindi na-update: ' + error.message); return; }

  logActivity('comms', `Coordination record <b>${r.refId}</b> (${esc(r.agencyName)}) naibalik mula sa Trash.`);
  await loadCoordinations();
  renderCoordTrash();
}


/* Tuluyan nang tanggalin — dito na hindi na mababawi pa */
async function permanentlyDeleteCoordRecord(id){
  const r = coordCache.find(x => x.id === id);
  if(!r) return;
  if(!confirm(`Tuluyan bang tanggalin ang ${r.refId} (${r.agencyName})? Hindi na ito maibabalik pa.`)) return;

  const { error } = await supabase.from('coordinations').delete().eq('id', id);
  if(error){ alert('Hindi matanggal: ' + error.message); return; }

  logActivity('comms', `Coordination record <b>${r.refId}</b> (${esc(r.agencyName)}) tuluyang tinanggal mula sa Trash.`);
  await loadCoordinations();
  renderCoordTrash();
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
  const trashed = coordCache
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
  const r = coordCache.find(x => x.id === id);
  if(!r){ alert('Record not found.'); return; }


  const w = window.open('', '_blank', 'width=800,height=900');
  w.document.write(`
    <html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'"><meta http-equiv="Content-Security-Policy" content="script-src 'none'"><title>Coordination Record - ${r.refId}</title>
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

