'use strict';

/*
 * e-Medicare responder dashboard — SUPABASE EDITION
 * -------------------------------------------------
 * Backend: Supabase (Postgres + Realtime + Auth).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = "https://szxptfuwkmqwcipxpoym.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_9mabckJnVdJ_Z-9km2T7mQ_c9t_XKiR";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let CURRENT_RESPONDER = null; // { id (profile id), name, jurisdiction }
let myFleetRow = null;        // the row in `fleet` linked to this responder
/* ---------------------------------------------------------
   SOS ALARM — loud repeating beep + persistent banner,
   tulad ng ginagawa sa admin dashboard.
--------------------------------------------------------- */
let sosAudioCtx = null;
let sosBeepInterval = null;
let respOriginalTitle = document.title;
let respTitleFlashInterval = null;
let activeSOSId = null;

function playSOSBeep(){
    if(!sosAudioCtx){
        try{ sosAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch(e){ console.warn('AudioContext not supported', e); return; }
    }
    if(sosAudioCtx.state === 'suspended') sosAudioCtx.resume();

    const now = sosAudioCtx.currentTime;
    [0, 0.3, 0.6].forEach(offset => {
        const osc = sosAudioCtx.createOscillator();
        const gain = sosAudioCtx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(880, now + offset);
        gain.gain.setValueAtTime(0.2, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.25);
        osc.connect(gain).connect(sosAudioCtx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.25);
    });
}

function startSOSAlertLoop(){
    stopSOSAlertLoop();
    playSOSBeep();
    sosBeepInterval = setInterval(playSOSBeep, 4000);
    startRespTitleFlash();
}

function stopSOSAlertLoop(){
    if(sosBeepInterval){ clearInterval(sosBeepInterval); sosBeepInterval = null; }
    stopRespTitleFlash();
}

function startRespTitleFlash(){
    if(respTitleFlashInterval) return;
    let toggle = false;
    respTitleFlashInterval = setInterval(() => {
        document.title = toggle ? respOriginalTitle : '🚨 NEW SOS ALERT!';
        toggle = !toggle;
    }, 1000);
}
function stopRespTitleFlash(){
    if(respTitleFlashInterval){ clearInterval(respTitleFlashInterval); respTitleFlashInterval = null; }
    document.title = respOriginalTitle;
}

function showSOSBanner(incident){
    activeSOSId = incident.id;
    let banner = document.getElementById('sosAlertBanner');
    if(!banner){
        banner = document.createElement('div');
        banner.id = 'sosAlertBanner';
        banner.style.cssText = 'position:fixed; top:0; left:0; right:0; z-index:5000; background:#3a1c1c; border-bottom:3px solid #ff4d4d; color:#fff; padding:14px 20px; display:flex; justify-content:space-between; align-items:center; box-shadow:0 6px 20px rgba(0,0,0,.5); animation:sosPulse 1s infinite;';
        document.body.prepend(banner);
    }
    const name = incident?.patient_name || incident?.sender?.name || 'A resident';
    banner.innerHTML = `
        <div style="font-weight:700;">🚨 SOS PANIC BUTTON — ${name} needs help NOW (${incident.category || 'Emergency'})</div>
        <button onclick="acknowledgeResponderSOS()" style="background:#ff4d4d;color:#fff;border:none;padding:8px 16px;border-radius:8px;font-weight:700;cursor:pointer;">Acknowledge</button>
    `;
    banner.style.display = 'flex';
}

function acknowledgeResponderSOS(){
    stopSOSAlertLoop();
    const banner = document.getElementById('sosAlertBanner');
    if(banner) banner.style.display = 'none';
    if(activeSOSId){
        selectIncident(activeSOSId);
    }
    activeSOSId = null;
}
window.acknowledgeResponderSOS = acknowledgeResponderSOS;

function requestRespNotifPermission(){
    if('Notification' in window && Notification.permission === 'default'){
        Notification.requestPermission();
    }
}

/* ---------------------------------------------------------
   ASSIGNMENT NOTIFICATION
--------------------------------------------------------- */
function showAssignmentNotification(incident){
    const name = incident?.patient_name || 'Isang residente';
    const category = incident?.category || 'Emergency Request';

    showToast(`📋 Bagong assignment mula sa admin: ${name} — ${category}`);

    if('Notification' in window && Notification.permission === 'granted'){
        const n = new Notification('📋 Bagong Assignment', {
            body: `Na-assign ka sa: ${name} — ${category}`,
        });
        n.onclick = () => { window.focus(); n.close(); };
    }
}

function showBrowserSOSNotificationResp(incident){
    if('Notification' in window && Notification.permission === 'granted'){
        const n = new Notification('🚨 New SOS Alert', {
            body: `${incident?.patient_name || 'A resident'} needs help — ${incident.category || 'Emergency'}`,
            requireInteraction: true
        });
        n.onclick = () => { window.focus(); n.close(); };
    }
}
let selectedId = null;
let lastCount = 0;
let activeFilter = 'all';
let locationWatchId = null;
let simulatedLocationTimer = null;
let etaTimer = null;
let safetyPollTimer = null;

/* ============================================================
   SESSION CHECK
   ============================================================ */

async function checkResponderSession() {
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
        window.location.href ='/pages/login.html';
        return null;
    }

    const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .single();

    if (error || !profile) {
        console.error('Hindi makuha ang responder profile:', error?.message);
        alert('Hindi makuha ang account profile mo. Makipag-ugnayan sa admin.');
        await supabase.auth.signOut();
        window.location.href = '/pages/login.html';
        return null;
    }

    if (profile.active === false) {
        alert('Ang account na ito ay na-deactivate. Makipag-ugnayan sa barangay admin.');
        await supabase.auth.signOut();
        window.location.href = '/pages/login.html';
        return null;
    }

    if (profile.role !== 'responder') {
        alert('Ang account na ito ay hindi responder account.');
        window.location.href = '/pages/login.html';
        return null;
    }

    return profile;
}

const REQUEST_COLUMN_MAP = {
    serviceType: 'service_type',
    patientName: 'patient_name',
    patientAge: 'patient_age',
    patientSex: 'patient_sex',
    createdAt: 'created_at',
    acceptedAt: 'accepted_at',
    arrivedAt: 'arrived_at',
    completedAt: 'completed_at',
    responderLat: 'responder_lat',
    responderLng: 'responder_lng',
    locationUpdatedAt: 'location_updated_at',
    etaMinutes: 'eta_minutes',
    etaUpdatedAt: 'eta_updated_at',
    assignedResponderId: 'assigned_responder_id',
    assignedResponderName: 'assigned_responder_name',
    messageSentAt: 'message_sent_at',
    responseDurationSeconds: 'response_duration_seconds',
    responseDurationLabel: 'response_duration_label'
};

function toDbChanges(changes) {
    const out = {};
    for (const [key, value] of Object.entries(changes)) {
        out[REQUEST_COLUMN_MAP[key] || key] = value;
    }
    return out;
}

/* ---------------------------------------------------------
   SESSION + FLEET LINKING (responder identity)
--------------------------------------------------------- */
async function handleCredsSubmit(e){
  e.preventDefault();
  const email = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if(error){ showAuthError('Incorrect email or password.'); return false; }


  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .single();

  if(profile.role === 'admin') window.location.href = '/pages/admin.html';
else if(profile.role === 'responder') window.location.href = '/pages/responder.html';
else window.location.href = '/pages/resident.html';
}

async function loadMyFleetRow(profileId){
    const { data, error } = await supabase
        .from('fleet')
        .select('*')
        .eq('profile_id', profileId)
        .maybeSingle();
    if(error) console.error('Hindi makuha ang fleet row:', error.message);
    return data || null;
}

async function loadUnassignedFleetOptions(){
    const { data, error } = await supabase
        .from('fleet')
        .select('*')
        .is('profile_id', null)
        .order('name', { ascending: true });
    if(error) console.error('Hindi makuha ang unassigned units:', error.message);
    return data || [];
}

async function selfAssignFleet(fleetId, profileId){
    const { error } = await supabase.from('fleet').update({ profile_id: profileId }).eq('id', fleetId);
    if(error){ alert('Hindi na-link: ' + error.message); return false; }
    return true;
}

async function promptSelfAssignIfNeeded(profile){
    if(myFleetRow) return;
    const options = await loadUnassignedFleetOptions();
    const unitSelect = document.getElementById('assignedUnit');
    if(!unitSelect) return;

    if(options.length === 0){
        unitSelect.innerHTML = '<option value="">No unassigned unit found — ask admin to register you</option>';
        return;
    }

    unitSelect.innerHTML = '<option value="" disabled selected>Select your unit / personnel entry</option>' +
        options.map(f => `<option value="${f.id}">${f.name} (${f.type})</option>`).join('');

    unitSelect.onchange = async () => {
        const chosenId = unitSelect.value;
        if(!chosenId) return;
        const ok = await selfAssignFleet(chosenId, profile.id);
        if(ok){
            myFleetRow = await loadMyFleetRow(profile.id);
            renderUnitHeader();
            subscribeMyFleetRealtime();
            renderAssignedPersonnel();
            showToast('Na-link na ang account mo sa unit na ito.');
        }
    };
}

function renderUnitHeader(){
    const unitSelect = document.getElementById('assignedUnit');
    const statusSelect = document.getElementById('unitStatus');
    if(myFleetRow && unitSelect){
        unitSelect.innerHTML = `<option value="${myFleetRow.id}" selected>${myFleetRow.name} (${myFleetRow.type})</option>`;
        unitSelect.onchange = null;
    }
    if(myFleetRow && statusSelect){
        statusSelect.value = myFleetRow.status;
    }
}

function subscribeMyFleetRealtime(){
    if(!myFleetRow) return;
    supabase
        .channel('my-fleet-status-' + myFleetRow.id)
        .on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'fleet', filter: `id=eq.${myFleetRow.id}` },
            payload => {
                myFleetRow = payload.new;
                const statusSelect = document.getElementById('unitStatus');
                if(statusSelect) statusSelect.value = myFleetRow.status;
                updateVehicleMetrics();
                renderAssignedPersonnel();
            })
        .subscribe();
}

document.addEventListener('DOMContentLoaded', async () => {
    const profile = await checkResponderSession();
    if(!profile) return;

    requestRespNotifPermission();

    CURRENT_RESPONDER = { id: profile.id, name: profile.name, jurisdiction: profile.barangay || 'Bambang' };
    myFleetRow = await loadMyFleetRow(profile.id);

    if(myFleetRow){
        renderUnitHeader();
        subscribeMyFleetRealtime();
    } else {
        await promptSelfAssignIfNeeded(profile);
    }

    renderAssignedPersonnel();
    bindDashboardEvents();
    updateVehicleMetrics();
    loadData();
    startRealtimeMonitoring();
});

function bindDashboardEvents() {
    document.querySelectorAll('.filter-btn').forEach(button => {
        button.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(item => item.classList.remove('active'));
            button.classList.add('active');
            activeFilter = button.dataset.filter;
            loadData();
        });
    });

    document.getElementById('crossBarangayToggle')?.addEventListener('change', loadData);

    document.getElementById('unitStatus')?.addEventListener('change', event => {
        updateResponderOperationalStatus(event.target.value);
    });

    document.getElementById('completionForm')?.addEventListener('submit', saveServiceCompletion);
}

async function renderAssignedPersonnel() {
    const driverNameEl = document.getElementById('driverName');
    const respondersEl = document.getElementById('assignedResponder');

    if (!myFleetRow) {
        if (driverNameEl) driverNameEl.textContent = 'No unit linked yet';
        if (respondersEl) respondersEl.innerHTML = '<li>No unit linked yet</li>';
        return;
    }

    const isDriver = myFleetRow.type === 'Driver';
    const notOnDuty = myFleetRow.status !== 'On Duty' || !myFleetRow.assigned_to;

    if (notOnDuty) {
        if (driverNameEl) driverNameEl.textContent = isDriver ? CURRENT_RESPONDER.name : 'No driver assigned';
        if (respondersEl) {
            respondersEl.innerHTML = isDriver
                ? '<li>No responder assigned</li>'
                : `<li>${escapeHtml(CURRENT_RESPONDER.name)}</li>`;
        }
        return;
    }

    const driverMatch = myFleetRow.assigned_to.match(/Driver:\s*([^)]+)/);
    const responderMatch = myFleetRow.assigned_to.match(/Responder:\s*([^)]+)/);

    if (isDriver) {
        if (driverNameEl) driverNameEl.textContent = CURRENT_RESPONDER.name;
        if (respondersEl) {
            respondersEl.innerHTML = responderMatch
                ? `<li>${escapeHtml(responderMatch[1].trim())}</li>`
                : '<li>No responder assigned</li>';
        }
    } else {
        if (respondersEl) respondersEl.innerHTML = `<li>${escapeHtml(CURRENT_RESPONDER.name)}</li>`;
        if (driverNameEl) {
            driverNameEl.textContent = driverMatch ? driverMatch[1].trim() : 'No driver assigned';
        }
    }
}

async function updateVehicleMetrics() {
    const { data, error } = await supabase.from('fleet').select('type, status');
    if (error) {
        console.error('Failed to fetch unit statuses from Supabase:', error);
        return;
    }

    const fleet = data || [];
    const vehicleTypes = ['Medical (Full)', 'Transport', 'Rescue/Patrol', 'Auxiliary'];

    const availableDrivers = fleet.filter(f => f.type === 'Driver' && f.status === 'Available').length;
    const availableVehicles = fleet.filter(f => vehicleTypes.includes(f.type) && f.status === 'Available').length;

    const driversEl = document.getElementById('activeDrivers');
    const vehiclesEl = document.getElementById('availableVehicles');
    if (driversEl) driversEl.textContent = availableDrivers;
    if (vehiclesEl) vehiclesEl.textContent = availableVehicles;
}

// ---------------- DATA LOADING (Supabase) ----------------

async function loadData() {
    const incidents = await fetchRequestsFromSupabase();
    const statuses = await fetchResponderStatuses();

    const activeIncidents = incidents.filter(isActiveIncident);
    if (activeIncidents.length > lastCount && activeIncidents.some(item => item.status === 'Pending')) {
        playAlertSound();
        showToast('New medical assistance request received.');
    }
    lastCount = activeIncidents.length;

    updateMetrics(incidents, statuses);
    renderList(incidents);

    if (selectedId) renderDetails(incidents);
}

async function fetchRequestsFromSupabase() {
    const crossBarangay = document.getElementById('crossBarangayToggle')?.checked;

    let query = supabase.from('emergency_requests').select('*')
        .neq('type', 'Medical Assistance')
        .neq('type', 'Transpo')
        .order('created_at', { ascending: false });
    if (!crossBarangay && CURRENT_RESPONDER?.jurisdiction) {
        query = query.eq('jurisdiction', CURRENT_RESPONDER.jurisdiction);
    }

    const { data, error } = await query;
    if (error) {
        console.error('Failed to fetch requests from Supabase:', error);
        showToast('Could not reach Supabase. Check your URL/key and internet connection.');
        return [];
    }

    return (data || []).map(normalizeIncident);
}

async function fetchResponderStatuses() {
    const { data, error } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'responder')
        .eq('active', true);

    if (error) {
        console.error('Failed to fetch active responders:', error);
        return [];
    }

    return (data || []).map(() => ({ status: 'Available' }));
}

function normalizeIncident(row) {
    return {
        id: row.id,
        category: row.category || 'Medical Assistance',
        serviceType: row.service_type || row.category || 'Emergency Response',
        description: row.description || 'No details supplied.',
        sender: row.sender || row.patient_name || 'Resident',
        patientName: row.patient_name || row.sender || 'Resident',
        patientAge: row.patient_age || 'Not provided',
        patientSex: row.patient_sex || 'Not provided',
        timestamp: formatDateTime(row.created_at),
        createdAt: row.created_at,
        acceptedAt: row.accepted_at || null,
        arrivedAt: row.arrived_at || null,
        completedAt: row.completed_at || null,
        status: row.status || 'Pending',
        urgency: row.urgency || 'Normal',
        jurisdiction: row.jurisdiction || null,
        lat: toNullableNumber(row.lat),
        lng: toNullableNumber(row.lng),
        responderLat: toNullableNumber(row.responder_lat),
        responderLng: toNullableNumber(row.responder_lng),
        locationUpdatedAt: row.location_updated_at || null,
        etaMinutes: Number(row.eta_minutes || 0),
        eta: row.eta || null,
        etaUpdatedAt: row.eta_updated_at || null,
        assignedResponderId: row.assigned_responder_id || null,
        assignedResponderName: row.assigned_responder_name || null
    };
}

function isActiveIncident(incident) {
    return !['Resolved', 'Completed'].includes(incident.status);
}

function updateMetrics(incidents, statuses) {
    const completed = incidents.filter(item => ['Resolved', 'Completed'].includes(item.status));
    const durations = completed
        .map(item => calculateDurationMinutes(item.acceptedAt, item.completedAt))
        .filter(Number.isFinite);

    if (durations.length) {
        const average = Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
        document.getElementById('averageResponse').textContent = average;
    }
}

function renderList(incidents) {
    const listDiv = document.getElementById('incidentList');
    const countSpan = document.getElementById('count');
    const crossBarangay = document.getElementById('crossBarangayToggle')?.checked;
    const jurisdictionMatch = item => crossBarangay || !CURRENT_RESPONDER?.jurisdiction || item.jurisdiction === CURRENT_RESPONDER.jurisdiction;

    // BAGO — "Completed Cases" ay ibang landas, dahil dito talaga
    // ipinapakita ang mga case na TINANGGAL sa normal na listahan
    // (Completed/Resolved). Ipinapakita lang dito ang mga completed
    // ng RESPONDER MISMO, sorted pinaka-bago muna.
    let visible;
    if (activeFilter === 'completed') {
        visible = incidents
            .filter(item => ['Completed', 'Resolved'].includes(item.status))
            .filter(item => isAssignedToMe(item))
            .filter(jurisdictionMatch)
            .sort((a, b) => new Date(b.completedAt || b.createdAt) - new Date(a.completedAt || a.createdAt));
    } else {
        visible = incidents
            .filter(isActiveIncident)
            .filter(jurisdictionMatch)
            .filter(isVisibleToResponder)
            .filter(matchesActiveFilter)
            .sort(compareQueuePriority);
    }

    countSpan.textContent = visible.length;

    if (!visible.length) {
        listDiv.innerHTML = '<div class="empty-queue"><i class="fas fa-circle-check"></i><br>No requests match the selected filter.</div>';
        return;
    }

   listDiv.innerHTML = visible.map(incident => {
        const urgent = isUrgent(incident);
        const statusClass = cssStatus(urgent && incident.status === 'Pending' ? 'Urgent' : incident.status);
        const assignedToMe = isAssignedToMe(incident);   // BAGO

        return `
            <div class="incident-list-item ${selectedId === incident.id ? 'active' : ''} ${urgent ? 'urgent' : ''} ${assignedToMe ? 'mine' : ''}"
                 onclick="selectIncident(${JSON.stringify(incident.id)})">
                <div style="display:flex;justify-content:space-between;align-items:start;gap:8px;">
                    <strong>${escapeHtml(incident.category)}</strong>
                    <span class="status-pill status-${statusClass}">
                        ${urgent && incident.status === 'Pending' ? 'Urgent' : escapeHtml(incident.status)}
                    </span>
                </div>

                ${assignedToMe ? `
                <div class="assigned-to-me-badge">
                    <i class="fas fa-user-check"></i> Naka-assign Sa'yo
                </div>
                ` : ''}

                <div class="incident-meta">
                    <i class="fas fa-user"></i> ${escapeHtml(incident.patientName)}<br>
                    <i class="fas fa-location-dot"></i> ${escapeHtml(incident.jurisdiction || 'N/A')}<br>
                    <i class="fas fa-clock"></i> ${escapeHtml(incident.timestamp)}
                </div>
            </div>
        `;
    }).join('');
}

// BAGO — itago ang mga request na naka-assign na sa IBANG responder (hindi sa akin).
// Yung mga wala pang naka-assign (Pending/Waiting List/Unattended) ay dapat
// makita pa rin ng lahat, para may makakuha at makatugon dito.
function isVisibleToResponder(incident) {
    const notYetAssignedStatuses = ['Pending', 'Waiting List', 'Unattended'];
    if (notYetAssignedStatuses.includes(incident.status)) return true;
    if (!incident.assignedResponderId) return true;
    return isAssignedToMe(incident);
}

function matchesActiveFilter(incident) {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'urgent') return isUrgent(incident);
    if (activeFilter === 'pending') return incident.status === 'Pending';
    if (activeFilter === 'assigned') {
        return ['Assigned', 'Accepted', 'In Transit', 'Arrived'].includes(incident.status);
    }
    return true;
}

function matchesActiveFilter(incident) {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'urgent') return isUrgent(incident);
    if (activeFilter === 'pending') return incident.status === 'Pending';
    if (activeFilter === 'assigned') {
        return ['Assigned', 'Accepted', 'In Transit', 'Arrived'].includes(incident.status);
    }
    if (activeFilter === 'unattended') {
        return ['Unattended', 'Waiting List'].includes(incident.status);
    }
    return true;
}

function compareQueuePriority(a, b) {
    const score = item => {
        let value = 0;
        if (isAssignedToMe(item)) value += 1000;
        if (isUrgent(item)) value += 100;
        if (item.status === 'Pending') value += 50;
        if (item.status === 'Unattended' || item.status === 'Waiting List') value += 35;
        if (['Accepted', 'Assigned', 'In Transit'].includes(item.status)) value += 20;
        value -= new Date(item.createdAt).getTime() / 1e13;
        return value;
    };

    return score(b) - score(a);
}

function isUrgent(incident) {
    return ['Urgent', 'Critical', 'High'].includes(String(incident.urgency));
}

function isAssignedToMe(incident) {
    return Boolean(CURRENT_RESPONDER?.id) && String(incident.assignedResponderId) === String(CURRENT_RESPONDER.id);
}

async function selectIncident(id) {
    selectedId = id;
    const incidents = await fetchRequestsFromSupabase();
    renderList(incidents);
    renderDetails(incidents);
    scrollDetailPanelIntoView();
}
// Expose to inline onclick handlers rendered via innerHTML.
window.selectIncident = selectIncident;

/* ---------------------------------------------------------
   MOBILE UX — sa mobile, ang Response Panel ay naka-order na sa
   ITAAS ng buong page (via CSS `order` sa .response-panel-col),
   pero kapag naka-scroll pababa ang user papunta sa listahan ng
   requests bago pumili, kailangan pa rin niyang mag-scroll
   pataas manually para makita ang detalye. I-scroll natin
   papunta doon nang smooth pagkatapos pumili, para agad makita
   ng responder ang detalye ng request na pinindot niya.
--------------------------------------------------------- */
function scrollDetailPanelIntoView(){
    const isMobileLayout = window.matchMedia('(max-width: 900px)').matches;
    if(!isMobileLayout) return;

    const panel = document.getElementById('detailPanel');
    if(!panel) return;

    // Konting delay para siguraduhing na-render na ang bagong content
    // (renderIncidentMap, etc.) bago mag-scroll, para tama ang
    // tinutukoy na height.
    requestAnimationFrame(() => {
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

function renderDetails(incidents) {
    const detailDiv = document.getElementById('incidentDetails');
    const incident = incidents.find(item => String(item.id) === String(selectedId));

    if (!incident) {
        detailDiv.innerHTML = '<p style="opacity:.7;">This request is no longer available.</p>';
        return;
    }

    const mapsUrl = incident.lat && incident.lng
    ? `https://www.google.com/maps/dir/?api=1&destination=${incident.lat},${incident.lng}&travelmode=driving`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${incident.category} ${incident.description}`)}`;

    const eta = getCurrentEta(incident);
    const actionHtml = buildActionButtons(incident, mapsUrl);
    const progress = buildProgressHtml(incident);

    // Sirain muna nang tama ang lumang Leaflet map instance BAGO burahin
    // ang HTML na naglalaman ng container nito, para maiwasan ang crash
    // sa susunod na pagtawag ng renderIncidentMap().
    if (incidentMap) {
        incidentMap.remove();
        incidentMap = null;
        incidentPatientMarker = null;
        incidentResponderMarker = null;
        incidentRouteLine = null;
    }

    detailDiv.innerHTML = `
        <div class="incident-summary">
            <h2>${escapeHtml(incident.category)}</h2>

            <div class="incident-information-grid">
                <p><strong><i class="fas fa-user-circle"></i> Patient:</strong><br>
                    ${escapeHtml(incident.patientName)} (${escapeHtml(incident.patientAge)}, ${escapeHtml(incident.patientSex)})
                </p>
                <p><strong><i class="fas fa-calendar-alt"></i> Date/Time:</strong><br>
                    ${escapeHtml(incident.timestamp)}
                </p>
                <p><strong><i class="fas fa-map-marker-alt"></i> Patient GPS:</strong><br>
                    ${incident.lat && incident.lng ? `${incident.lat.toFixed(5)}, ${incident.lng.toFixed(5)}` : 'No GPS Data'}
                </p>
                <p><strong><i class="fas fa-notes-medical"></i> Service / Urgency:</strong><br>
                    ${escapeHtml(incident.serviceType)} • ${escapeHtml(incident.urgency)}
                </p>
                <p><strong><i class="fas fa-building"></i> Jurisdiction:</strong><br>
                    ${escapeHtml(incident.jurisdiction || 'N/A')}
                </p>
               <p><strong><i class="fas fa-user-doctor"></i> Assigned Responder:</strong><br>
                    ${escapeHtml(incident.assignedResponderName || 'Not assigned')}
                </p>
            </div>

            <div class="incident-map-wrap" style="margin:14px 0;">
                <div id="incidentMap" style="height:240px;border-radius:12px;overflow:hidden;border:1px solid #333;"></div>
            </div>

            <div class="eta-location-grid">
                <div class="eta-card">
                    <small>Resident ETA Update</small>
                    <div class="eta-value">${escapeHtml(eta.label)}</div>
                    <div class="tracking-time">${escapeHtml(eta.updatedLabel)}</div>
                </div>

                <div class="location-card">
                    <small>Live Responder Position</small>
                    <div class="coordinate-line">
                        <i class="fas fa-truck-medical"></i>
                        ${incident.responderLat && incident.responderLng
                            ? `${incident.responderLat.toFixed(6)}, ${incident.responderLng.toFixed(6)}`
                            : 'Waiting for responder GPS permission'}
                    </div>
                    <div class="tracking-time">
                        ${incident.locationUpdatedAt ? `Updated ${formatDateTime(incident.locationUpdatedAt)}` : 'No location update yet'}
                    </div>
                </div>
            </div>

            ${progress}

           <p style="font-weight:bold;margin-bottom:5px;">Report Details:</p>
            <div class="report-description">${escapeHtml(incident.description)}</div>
        </div>

        ${actionHtml}
    `;

    renderIncidentMap(incident);
}

/* ---------------------------------------------------------
   LIVE INCIDENT MAP
--------------------------------------------------------- */
let incidentMap = null;
let incidentPatientMarker = null;
let incidentResponderMarker = null;
let incidentRouteLine = null;

function renderIncidentMap(incident) {
    const mapContainer = document.getElementById('incidentMap');
    if (!mapContainer) return;

    if (!incident.lat || !incident.lng) {
        
        mapContainer.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:0.85rem;text-align:center;padding:10px;">
                <i class="fas fa-map-location-dot"></i>&nbsp; Walang GPS data na isinumite ng resident para sa request na ito.
            </div>`;
        return;
    }

    incidentMap = L.map(mapContainer, { zoomControl: true }).setView([incident.lat, incident.lng], 16);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(incidentMap);

    const patientIcon = L.divIcon({
        className: '',
        html: '<div style="background:#d32f2f;width:16px;height:16px;border-radius:50%;border:3px solid white;box-shadow:0 0 6px rgba(0,0,0,0.5);"></div>',
        iconSize: [16, 16]
    });

    incidentPatientMarker = L.marker([incident.lat, incident.lng], { icon: patientIcon })
        .addTo(incidentMap)
        .bindPopup(`<b>${escapeHtml(incident.patientName)}</b><br>${escapeHtml(incident.category)}`)
        .openPopup();

    const bounds = [[incident.lat, incident.lng]];

    if (incident.responderLat && incident.responderLng) {
        const responderIcon = L.divIcon({
            className: '',
            html: '<div style="background:#0091ea;width:16px;height:16px;border-radius:50%;border:3px solid white;box-shadow:0 0 6px rgba(0,0,0,0.5);"></div>',
            iconSize: [16, 16]
        });

        incidentResponderMarker = L.marker([incident.responderLat, incident.responderLng], { icon: responderIcon })
            .addTo(incidentMap)
            .bindPopup('Responder (Ikaw)');

        incidentRouteLine = L.polyline(
            [[incident.responderLat, incident.responderLng], [incident.lat, incident.lng]],
            { color: '#0091ea', weight: 3, dashArray: '6,6' }
        ).addTo(incidentMap);

        bounds.push([incident.responderLat, incident.responderLng]);
    }

    if (bounds.length > 1) {
        incidentMap.fitBounds(bounds, { padding: [30, 30] });
    }

    setTimeout(() => { if (incidentMap) incidentMap.invalidateSize(); }, 200);
}

function buildProgressHtml(incident) {
    const order = ['Accepted', 'In Transit', 'Arrived', 'Completed'];
    const currentIndex =
        ['Completed', 'Resolved'].includes(incident.status) ? 3 :
        incident.status === 'Arrived' ? 2 :
        ['Accepted', 'Assigned', 'In Transit'].includes(incident.status) ? 1 :
        -1;

    return `
        <div class="progress-track">
            <h3><i class="fas fa-route"></i> Service Progress & Automatic Timestamps</h3>
            <div class="progress-steps">
                ${order.map((step, index) => {
                    const className = index < currentIndex ? 'done' : index === currentIndex ? 'current' : '';
                    const timestamp =
                        step === 'Accepted' ? incident.acceptedAt :
                        step === 'Arrived' ? incident.arrivedAt :
                        step === 'Completed' ? incident.completedAt : null;

                    return `
                        <div class="progress-step ${className}">
                            <i class="fas ${
                                step === 'Accepted' ? 'fa-check' :
                                step === 'In Transit' ? 'fa-truck-medical' :
                                step === 'Arrived' ? 'fa-location-dot' :
                                'fa-flag-checkered'
                            }"></i>
                            <span>${step}</span>
                            <small>${timestamp ? formatShortTime(timestamp) : ''}</small>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function buildActionButtons(incident, mapsUrl) {
    if (['Pending', 'Waiting List', 'Unattended'].includes(incident.status)) {
        return `
            <div class="btn-group">
                <button class="status-btn btn-primary" onclick="acceptAndDeploy()">
                    <i class="fas fa-location-arrow"></i> Accept & Deploy
                </button>
                <button class="status-btn btn-warning" onclick="updateStatus('Waiting List')">
                    Queue Request
                </button>
            </div>
        `;
    }

    // ================= LOCK: may naka-assign na PERO HINDI ako =================
    const hasAssignment = Boolean(incident.assignedResponderId);
    const notAssignedIncidents = ['Pending', 'Waiting List', 'Unattended'];
    if (hasAssignment && !isAssignedToMe(incident) && !notAssignedIncidents.includes(incident.status)) {
        return `
            <div style="padding:20px;text-align:center;background:#fff3e0;border:1px solid #ef6c00;border-radius:15px;margin-top:15px;color:#ef6c00;font-weight:bold;">
                <i class="fas fa-user-shield"></i> Kasalukuyang sinasagot ni <u>${escapeHtml(incident.assignedResponderName || 'ibang responder')}</u>.
                <br><small style="font-weight:normal;">Hindi mo na maaaring galawin o i-update ang request na ito.</small>
            </div>
        `;
    }
    // ================= END LOCK =================

    if (['Accepted', 'Assigned', 'In Transit'].includes(incident.status)) {
        return `
            <div class="quick-sms-area">
                <button class="sms-btn" onclick="sendSMS('On our way')">📲 On our way</button>
                <button class="sms-btn" onclick="sendSMS('Prepare Documents')">📲 Prepare Docs</button>
                <button class="sms-btn" onclick="promptEtaUpdate()">⏱ Update ETA</button>
            </div>

            <div class="vitals-grid">
                <div><small>BP</small><input type="text" id="v_bp" class="vitals-input" placeholder="120/80"></div>
                <div><small>HR</small><input type="text" id="v_hr" class="vitals-input" placeholder="85 bpm"></div>
                <div><small>TEMP</small><input type="text" id="v_temp" class="vitals-input" placeholder="36.5°C"></div>
            </div>

            <div class="btn-group">
                <button class="status-btn btn-map" onclick="window.open('${mapsUrl}', '_blank')">
                    <i class="fas fa-location-arrow"></i> Start GPS Navigation
                </button>
                <button class="status-btn btn-arrived" onclick="markArrived()">
                    <i class="fas fa-location-dot"></i> Mark Arrived
                </button>
            </div>
        `;
    }

    if (incident.status === 'Arrived') {
        return `
            <div class="quick-sms-area">
                <button class="sms-btn" onclick="sendSMS('Responder has arrived')">📲 Notify Arrival</button>
            </div>

            <div class="vitals-grid">
                <div><small>BP</small><input type="text" id="v_bp" class="vitals-input" placeholder="120/80"></div>
                <div><small>HR</small><input type="text" id="v_hr" class="vitals-input" placeholder="85 bpm"></div>
                <div><small>TEMP</small><input type="text" id="v_temp" class="vitals-input" placeholder="36.5°C"></div>
            </div>

            <div class="btn-group">
                <button class="status-btn btn-success" onclick="openCompletionModal()">
                    <i class="fas fa-file-medical"></i> Complete Service Record
                </button>
            </div>
        `;
    }

    return `
        <div style="padding:20px;text-align:center;background:#e8f5e9;border:1px solid #2e7d32;border-radius:15px;margin-top:15px;color:#2e7d32;font-weight:bold;">
            ✅ CASE COMPLETED & RECORDED
        </div>
    `;
}

// ---------------- ACTIONS (write to Supabase) ----------------

async function acceptAndDeploy() {
    const etaInput = prompt('Estimated time of arrival in minutes:', '5');
    if (etaInput === null) return;

    const etaMinutes = Math.max(1, Number.parseInt(etaInput, 10) || 5);
    const now = new Date().toISOString();

    await patchSelectedIncident({
        status: 'In Transit',
        assignedResponderId: CURRENT_RESPONDER.id,
        assignedResponderName: CURRENT_RESPONDER.name,
        acceptedAt: now,
        etaMinutes,
        eta: `${etaMinutes} mins`,
        etaUpdatedAt: now
    });

    await updateResponderOperationalStatus('On Duty');
    startLocationTracking(selectedId);
    startEtaBroadcast(selectedId);
    showToast('Request accepted. GPS tracking and ETA updates are active.');
}
window.acceptAndDeploy = acceptAndDeploy;

async function updateStatus(newStatus) {
    await patchSelectedIncident({ status: newStatus });
    showToast(`Request moved to ${newStatus}.`);
}
window.updateStatus = updateStatus;

async function markArrived() {
    const now = new Date().toISOString();

    await patchSelectedIncident({
        status: 'Arrived',
        arrivedAt: now,
        etaMinutes: 0,
        eta: 'Arrived',
        etaUpdatedAt: now
    });

    stopEtaBroadcast();
    showToast('Arrival timestamp recorded and synced live to the resident.');
}
window.markArrived = markArrived;

function promptEtaUpdate() {
    const minutes = prompt('New estimated arrival time in minutes:', '5');
    if (minutes === null) return;

    const value = Math.max(1, Number.parseInt(minutes, 10) || 5);
    const now = new Date().toISOString();

    patchSelectedIncident({
        etaMinutes: value,
        eta: `${value} mins`,
        etaUpdatedAt: now
    }).then(() => showToast('Updated ETA sent to the resident.'));
}
window.promptEtaUpdate = promptEtaUpdate;

async function patchSelectedIncident(changes) {
    if (!selectedId) return;

    const { error } = await supabase
        .from('emergency_requests')
        .update(toDbChanges(changes))
        .eq('id', selectedId);

    if (error) {
        console.error('Failed to update request in Supabase:', error);
        showToast('Hindi na-save sa Supabase. Subukang ulit.');
        return;
    }

    loadData();
}

function startLocationTracking(requestId) {
    stopLocationTracking();

    if (navigator.geolocation) {
        locationWatchId = navigator.geolocation.watchPosition(
            position => {
                sendLocationUpdate(
                    requestId,
                    position.coords.latitude,
                    position.coords.longitude
                );
            },
            () => startSimulatedLocation(requestId),
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 }
        );
    } else {
        startSimulatedLocation(requestId);
    }
}

async function startSimulatedLocation(requestId) {
    if (simulatedLocationTimer) return;

    const { data } = await supabase.from('emergency_requests').select('*').eq('id', requestId).single();
    const request = data ? normalizeIncident(data) : null;

    let lat = request?.responderLat || (request?.lat ? request.lat - 0.018 : 14.5995);
    let lng = request?.responderLng || (request?.lng ? request.lng - 0.016 : 120.9842);

    simulatedLocationTimer = setInterval(() => {
        if (request?.lat && request?.lng) {
            lat += (request.lat - lat) * 0.13;
            lng += (request.lng - lng) * 0.13;
        } else {
            lat += 0.0002;
            lng += 0.0002;
        }

        sendLocationUpdate(requestId, lat, lng);
    }, 5000);
}

async function sendLocationUpdate(requestId, latitude, longitude) {
    const now = new Date().toISOString();

    const { error } = await supabase
        .from('emergency_requests')
        .update({
            responder_lat: latitude,
            responder_lng: longitude,
            location_updated_at: now
        })
        .eq('id', requestId);

    if (error) {
        console.error('Failed to push location update:', error);
        return;
    }

    if (String(selectedId) === String(requestId)) {
        loadData();
    }
}

function stopLocationTracking() {
    if (locationWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatchId);
        locationWatchId = null;
    }

    if (simulatedLocationTimer) {
        clearInterval(simulatedLocationTimer);
        simulatedLocationTimer = null;
    }
}

function startEtaBroadcast(requestId) {
    stopEtaBroadcast();

    const broadcast = async () => {
        const { data } = await supabase.from('emergency_requests').select('*').eq('id', requestId).single();
        const request = data ? normalizeIncident(data) : null;

        if (!request || !['Accepted', 'Assigned', 'In Transit'].includes(request.status)) {
            stopEtaBroadcast();
            return;
        }

        const eta = getCurrentEta(request);
        await supabase
            .from('emergency_requests')
            .update({
                eta: eta.label,
                eta_minutes: eta.minutes,
                eta_updated_at: new Date().toISOString()
            })
            .eq('id', requestId);
    };

    broadcast();
    etaTimer = setInterval(broadcast, 15000);
}

function stopEtaBroadcast() {
    if (etaTimer) {
        clearInterval(etaTimer);
        etaTimer = null;
    }
}

function getCurrentEta(incident) {
    if (incident.status === 'Arrived') {
        return { minutes: 0, label: 'Arrived', updatedLabel: 'Responder is at the location' };
    }

    if (!incident.etaMinutes || !incident.acceptedAt) {
        return {
            minutes: null,
            label: incident.eta || 'Not set',
            updatedLabel: incident.etaUpdatedAt ? `Updated ${formatDateTime(incident.etaUpdatedAt)}` : 'Waiting for acceptance'
        };
    }

    const elapsedMinutes = Math.floor((Date.now() - new Date(incident.acceptedAt).getTime()) / 60000);
    const remaining = Math.max(1, incident.etaMinutes - elapsedMinutes);

    return {
        minutes: remaining,
        label: `${remaining} min`,
        updatedLabel: incident.etaUpdatedAt ? `Updated ${formatDateTime(incident.etaUpdatedAt)}` : 'Live estimate'
    };
}

function sendSMS(message) {
    if (!selectedId) return;

    patchSelectedIncident({ message, messageSentAt: new Date().toISOString() });
    showToast(`Resident update sent: "${message}"`);
}
window.sendSMS = sendSMS;

function openCompletionModal() {
    document.getElementById('completionTimestamp').value = formatDateTime(new Date());
    document.getElementById('completionModal').classList.add('open');
    document.getElementById('completionModal').setAttribute('aria-hidden', 'false');
}
window.openCompletionModal = openCompletionModal;

function closeCompletionModal() {
    document.getElementById('completionModal').classList.remove('open');
    document.getElementById('completionModal').setAttribute('aria-hidden', 'true');
}
window.closeCompletionModal = closeCompletionModal;

async function saveServiceCompletion(event) {
    event.preventDefault();

    const { data } = await supabase.from('emergency_requests').select('*').eq('id', selectedId).single();
    const incident = data ? normalizeIncident(data) : null;
    if (!incident) return;

    const completedAt = new Date().toISOString();
    const durationSeconds = calculateDurationSeconds(incident.acceptedAt || incident.createdAt, completedAt);

    const record = {
        request_id: incident.id,
        responder_id: CURRENT_RESPONDER.id,
        responder_name: CURRENT_RESPONDER.name,
        patient_name: incident.patientName,
        assistance_provided: document.getElementById('assistanceProvided').value,
        patient_outcome: document.getElementById('patientOutcome').value,
        clinical_observations: document.getElementById('clinicalObservations').value.trim(),
        follow_up_quote: document.getElementById('followUpQuote').value.trim(),
        receiving_facility: document.getElementById('receivingFacility').value.trim(),
        accepted_at: incident.acceptedAt,
        arrived_at: incident.arrivedAt,
        completed_at: completedAt,
        response_duration_seconds: durationSeconds,
        response_duration_label: formatDuration(durationSeconds)
    };

    const { error: insertError } = await supabase.from('service_records').insert(record);
    if (insertError) {
        console.error('Failed to save service record:', insertError);
        showToast('Hindi na-save ang service record sa Supabase.');
        return;
    }

    await patchSelectedIncident({
        status: 'Completed',
        completedAt,
        responseDurationSeconds: durationSeconds,
        responseDurationLabel: formatDuration(durationSeconds)
    });

    stopLocationTracking();
    stopEtaBroadcast();
    await updateResponderOperationalStatus('Available');

    closeCompletionModal();
    event.target.reset();
    showToast(`Case completed. Total response duration: ${formatDuration(durationSeconds)}.`);
}

/* ---------------------------------------------------------
   RESPONDER OPERATIONAL STATUS
--------------------------------------------------------- */
async function updateResponderOperationalStatus(status){
    const select = document.getElementById('unitStatus');
    if(select) select.value = status;

    if(!myFleetRow){
        showToast('Wala pang naka-link na unit sa account mo. Piliin muna sa itaas o i-register ka ng admin.');
        return;
    }

    const updateData = { status };
    if(status !== 'On Duty') updateData.assigned_to = null;

    const { data, error } = await supabase
        .from('fleet')
        .update(updateData)
        .eq('id', myFleetRow.id)
        .select();

    if(error){
        console.error('Failed to update fleet status:', error);
        showToast('Hindi na-save ang status sa Supabase.');
        return;
    }
    if(!data || data.length === 0){
        showToast('Hindi na-apply ang update — posibleng RLS/permissions issue sa fleet table.');
        return;
    }

    myFleetRow.status = status;
    localStorage.setItem('currentResponderStatus', status);
    updateVehicleMetrics();
}

// ---------------- REALTIME ----------------

function startRealtimeMonitoring() {
    supabase
        .channel('emergency_requests_changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'emergency_requests' }, (payload) => {
            if (payload.eventType === 'INSERT' && payload.new?.type === 'SOS') {
                startSOSAlertLoop();
                showSOSBanner(payload.new);
                showBrowserSOSNotificationResp(payload.new);
            }

            const newlyAssignedToMe =
                CURRENT_RESPONDER?.id &&
                payload.new?.assigned_responder_id === CURRENT_RESPONDER.id &&
                payload.old?.assigned_responder_id !== CURRENT_RESPONDER.id;

            if (newlyAssignedToMe) {
                selectedId = payload.new.id;
                playAssignmentNotificationSound();
                showAssignmentNotification(payload.new);
            }

            loadData();
        })
        .subscribe();

    supabase
        .channel('fleet_changes_responder_view')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'fleet' }, () => {
            updateVehicleMetrics();
            renderAssignedPersonnel();
        })
        .subscribe();

    if (CURRENT_RESPONDER?.id) {
        supabase
            .channel('my-notifications-' + CURRENT_RESPONDER.id)
            .on('postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'notifications', filter: `receiver_id=eq.${CURRENT_RESPONDER.id}` },
                payload => {
                    playAlertSound();
                    showToast(`🔔 ${payload.new.title}: ${payload.new.message}`);
                    loadData();
                })
            .subscribe();
    }

    safetyPollTimer = setInterval(loadData, 30000);
}

// ---------------- MISC / UTILITIES ----------------

function playAlertSound() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const audioContext = new AudioContext();
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
        gain.gain.setValueAtTime(0.22, audioContext.currentTime);

        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start();
        setTimeout(() => oscillator.stop(), 500);
    } catch {
        // Browsers may block audio until the first user interaction.
    }
}

function playAssignmentNotificationSound(){
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const audioContext = new AudioContext();
        const now = audioContext.currentTime;

        const playTone = (freq, startOffset, duration) => {
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, now + startOffset);
            gain.gain.setValueAtTime(0.001, now + startOffset);
            gain.gain.exponentialRampToValueAtTime(0.25, now + startOffset + 0.03);
            gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + duration);
            osc.connect(gain).connect(audioContext.destination);
            osc.start(now + startOffset);
            osc.stop(now + startOffset + duration + 0.05);
        };

        playTone(1046.5, 0, 0.25);   // C6
        playTone(783.99, 0.18, 0.35); // G5
    } catch {
        // Browsers may block audio until the first user interaction.
    }
}

function showToast(message) {
    const toast = document.getElementById('dashboardToast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(window.dashboardToastTimer);
    window.dashboardToastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

function logout() {
    console.log("Logout clicked");

    if (confirm("Logout Confirmation: Are you sure you want to log out?")) {
        stopLocationTracking();
        stopEtaBroadcast();

        if (safetyPollTimer) clearInterval(safetyPollTimer);

        supabase.auth.signOut().then(() => {
    window.location.href = "/pages/login.html";
});
    }
}

window.logout = logout;

function calculateDurationSeconds(start, end) {
    if (!start || !end) return 0;
    return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
}

function calculateDurationMinutes(start, end) {
    if (!start || !end) return NaN;
    return calculateDurationSeconds(start, end) / 60;
}

function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Number(totalSeconds) || 0);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    return [
        hours ? `${hours}h` : '',
        `${minutes}m`,
        `${remainingSeconds}s`
    ].filter(Boolean).join(' ');
}

function formatDateTime(value) {
    return new Date(value).toLocaleString();
}

function formatShortTime(value) {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function toNullableNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function cssStatus(status) {
    return String(status).toLowerCase().replace(/\s+/g, '');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

document.getElementById("logoutBtn")?.addEventListener("click", logout);