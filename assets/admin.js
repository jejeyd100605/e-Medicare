/* ============================================================
    e-Medicare — Barangay Bambang Admin Control Center
    Handles: incident feed, fleet/responder real-time status,
    assistance request pipeline (pending -> completed),
    budget-aware financial assistance queue with priority scoring,
    system activity log, and resident notifications.
    ============================================================ */

    /* ---------------------------------------------------------
    SUPABASE SETUP
    --------------------------------------------------------- */
    const SUPABASE_URL = "https://szxptfuwkmqwcipxpoym.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_9mabckJnVdJ_Z-9km2T7mQ_c9t_XKiR";
    var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let fleetCache = [];
let incidentsCache = [];
let transpoCache = [];
let medicalRequestsCache = [];
let serviceRecordsCache = []; // BAGO — mula sa 'service_records' table (Responder's Service Completion Record)
let activeIncidentId = null;
let responderProfilesCache = [];

/* ---------------------------------------------------------
   TAB UPDATE INDICATORS — red dot sa tab button kapag may
   bagong (INSERT) record habang naka-ibang tab ang admin.
   --------------------------------------------------------- */
function setTabDot(tab, show){
    const btn = document.getElementById('btn-' + tab);
    if(!btn) return;
    let dot = btn.querySelector('.tab-dot');
    if(show && !dot){
        dot = document.createElement('span');
        dot.className = 'tab-dot';
        btn.appendChild(dot);
    } else if(!show && dot){
        dot.remove();
    }
}

// BAGO — hindi na basta nawawala ang dot pag binuksan lang ang tab.
// Nananatili ito hanggang aktwal na na-review/na-click ng admin yung
// partikular na bagong record. Bawat tab (maliban activity) may
// sariling Set ng "unseen" record IDs.
const unseenIds = {
    dashboard: new Set(),
    fleet: new Set(),
    docs: new Set(),
    queue: new Set(),
    users: new Set(),
};

function refreshTabDot(tab){
    setTabDot(tab, unseenIds[tab].size > 0);
}

function markTabUpdated(tab, id){
    if(unseenIds[tab]){
        if(id !== undefined && id !== null) unseenIds[tab].add(String(id));
        refreshTabDot(tab);
    } else {
        setTabDot(tab, true); // fallback para sa 'activity' — walang per-item tracking
    }
}

function markSeen(tab, id){
    if(unseenIds[tab] && unseenIds[tab].delete(String(id))){
        refreshTabDot(tab);
    }
}

// inilalagay sa taas ng listahan ang mga item na "unseen" pa
function sortUnseenFirst(list, tab){
    const unseen = unseenIds[tab];
    if(!unseen || unseen.size === 0) return list;
    return [...list].sort((a,b) => {
        const au = unseen.has(String(a.id)) ? 0 : 1;
        const bu = unseen.has(String(b.id)) ? 0 : 1;
        return au - bu;
    });
}

/* BAGO — Live Response Tracking map (Dispatch modal). Ginagamit kapag
   naka-assign na ang isang team sa isang incident, para makita ng admin
   ang lokasyon ng resident at ng responder nang magkatabi sa isang mapa. */
let trackingMap = null;
let trackingResidentMarker = null;
let trackingResponderMarker = null;
let trackingRouteLine = null;

   async function checkAdminSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        window.location.href = '/pages/adminlogin.html';
        return null;
    }
        const { data: profile } = await supabase
            .from('profiles')
            .select('role, name')
            .eq('id', session.user.id)
            .single();
        return profile;
    }

    /* ---------------------------------------------------------
    STORAGE KEYS + STATE
    --------------------------------------------------------- */
    const DB = {
    incidents:     'bmb_incidents',
    fleet:         'bmb_fleet',
    requests:      'bmb_requests',
    budget:        'bmb_budget',
    activity:      'bmb_activity',
    notifications: 'bmb_notifications',
    users:         'bmb_users',
    session:       'bmb_session'
    };

    function load(key, fallback){
    try{
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    }catch(e){ return fallback; }
    }
    function save(key, value){ localStorage.setItem(key, JSON.stringify(value)); }
    function uid(prefix){ return prefix + '-' + Math.random().toString(36).slice(2,8); }
    function nowISO(){ return new Date().toISOString(); }
    function fmtTime(iso){
    const d = new Date(iso);
    return d.toLocaleString('en-PH', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    }
    function timeAgo(iso){
    const s = Math.floor((Date.now() - new Date(iso).getTime())/1000);
    if(s < 60) return 'just now';
    if(s < 3600) return Math.floor(s/60) + 'm ago';
    if(s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
    }

    /* ---------------------------------------------------------
    SOS ALERT — beep + visual/browser notification for new emergencies
    --------------------------------------------------------- */
    let sosAudioCtx = null;
    let sosBeepInterval = null;
    let originalTitle = document.title;
    let titleFlashInterval = null;

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
            gain.gain.setValueAtTime(0.15, now + offset);
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
        startTitleFlash();
    }

    function stopSOSAlertLoop(){
        if(sosBeepInterval){ clearInterval(sosBeepInterval); sosBeepInterval = null; }
        stopTitleFlash();
    }

    function startTitleFlash(){
        if(titleFlashInterval) return;
        let toggle = false;
        titleFlashInterval = setInterval(() => {
            document.title = toggle ? originalTitle : '🚨 NEW SOS ALERT!';
            toggle = !toggle;
        }, 1000);
    }
    function stopTitleFlash(){
        if(titleFlashInterval){ clearInterval(titleFlashInterval); titleFlashInterval = null; }
        document.title = originalTitle;
    }

    function showSOSToast(incident){
        const callerName = incident?.sender?.name || 'A resident';
        const container = document.getElementById('sosToastContainer') || (() => {
            const c = document.createElement('div');
            c.id = 'sosToastContainer';
            c.style.cssText = 'position:fixed; top:16px; right:16px; z-index:9999; display:flex; flex-direction:column; gap:10px;';
            document.body.appendChild(c);
            return c;
        })();

        const toast = document.createElement('div');
        toast.style.cssText = 'background:#3a1c1c; border:1px solid #ff4d4d; color:#fff; padding:14px 16px; border-radius:10px; width:300px; box-shadow:0 6px 20px rgba(0,0,0,.5); animation:sosPulse 1s infinite;';
        toast.innerHTML = `
            <div style="font-weight:700; color:#ff8a8a; margin-bottom:4px;">🚨 NEW SOS / EMERGENCY</div>
            <div style="font-size:.85em; margin-bottom:8px;">${callerName} needs help — ${incident.category || incident.type || 'Emergency'}</div>
            <div style="display:flex; gap:8px;">
                <button class="primary-btn" style="background:#ff4d4d;color:#fff;flex:1;font-size:.78em;" onclick="acknowledgeSOS('${incident.id}', this)">Acknowledge</button>
            </div>
        `;
        container.appendChild(toast);
    }

    function acknowledgeSOS(incidentId, btnEl){
        stopSOSAlertLoop();
        const toast = btnEl.closest('div[style*="animation"]');
        if(toast) toast.remove();
        switchTab('dashboard');
        openAssignModal(incidentId);
    }

    function requestNotifPermission(){
        if('Notification' in window && Notification.permission === 'default'){
            Notification.requestPermission();
        }
    }

    function showBrowserSOSNotification(incident){
        if('Notification' in window && Notification.permission === 'granted'){
            const n = new Notification('🚨 New SOS Alert', {
                body: `${incident?.sender?.name || 'A resident'} needs help — ${incident.category || incident.type}`,
                requireInteraction: true
            });
            n.onclick = () => { window.focus(); n.close(); };
        }
    }

    /* ---------------------------------------------------------
    SEED DATA (first run only)
    Fleet ay galing na sa Supabase — hindi na dito ini-seed.
    --------------------------------------------------------- */
    function seedIfEmpty(){
    if(!localStorage.getItem(DB.incidents)){
        save(DB.incidents, [
        { id: uid('inc'), type:'Motorcycle Accident', caller:'Aling Nena', location:'Purok 3, near chapel', status:'Open', reportedAt: nowISO() },
        { id: uid('inc'), type:'Stroke', caller:'Mang Doming', location:'Blk 5 Lot 12', status:'Assigned', reportedAt: nowISO() },
        ]);
    }
    if(!localStorage.getItem(DB.requests)){
        save(DB.requests, [
        {
            id: uid('req'), residentName:'Marites Villanueva', contact:'0917 555 0142',
            purpose:'Hospital bill assistance for dialysis treatment', category:'Financial Assistance',
            priority:'Critical', estimatedCost: 8500, documents:['Medical Certificate.pdf','Indigency Form.pdf','Hospital Bill.pdf'],
            eligibility:{ residentOfBambang:true, noPriorClaimThisQuarter:true, indigencyVerified:true },
            status:'Pending', notes:'', submittedAt: nowISO(),
            history:[{status:'Pending', at: nowISO(), note:'Request submitted by resident'}]
        },
        {
            id: uid('req'), residentName:'Rico Bautista', contact:'0918 222 7781',
            purpose:'Maintenance medicine for hypertension', category:'Non-Emergency',
            priority:'Routine', estimatedCost: 1200, documents:['Prescription.pdf'],
            eligibility:{ residentOfBambang:true, noPriorClaimThisQuarter:true, indigencyVerified:false },
            status:'Pending', notes:'', submittedAt: nowISO(),
            history:[{status:'Pending', at: nowISO(), note:'Request submitted by resident'}]
        },
        {
            id: uid('req'), residentName:'Corazon Dizon', contact:'0920 341 9087',
            purpose:'Emergency C-section hospital bill', category:'Financial Assistance',
            priority:'Urgent', estimatedCost: 15000, documents:['Medical Certificate.pdf','Indigency Form.pdf'],
            eligibility:{ residentOfBambang:true, noPriorClaimThisQuarter:false, indigencyVerified:true },
            status:'Pending', notes:'', submittedAt: nowISO(),
            history:[{status:'Pending', at: nowISO(), note:'Request submitted by resident'}]
        }
        ]);
    }
    if(!localStorage.getItem(DB.budget)){
        save(DB.budget, { total: 30000, allocated: 0, quarter:'Q3 2026' });
    }
    if(!localStorage.getItem(DB.activity)) save(DB.activity, []);
    if(!localStorage.getItem(DB.notifications)) save(DB.notifications, []);
    if(!localStorage.getItem(DB.users)){
        save(DB.users, [
    { id: uid('usr'), name:'Barangay Captain Reyes', role:'Admin / Barangay Captain', contact:'0917 000 1111', tempPassword:false, active:true }
    ]);
    }
    }
    seedIfEmpty();

    /* ---------------------------------------------------------
    ACTIVITY LOG + NOTIFICATIONS (core cross-cutting features)
    --------------------------------------------------------- */
    function logActivity(type, message){
    const list = load(DB.activity, []);
    list.unshift({ id: uid('act'), type, message, at: nowISO() });
    save(DB.activity, list.slice(0, 300));
   renderActivity();
    renderDashboardCounts();
    markTabUpdated('activity');   // BAGO
    }

    const ACTIVITY_ICONS = {
    dispatch: '🚑', fleet: '🚒', request: '📄', budget: '💰',
    user: '👤', advisory: '📢', notify: '🔔', comms: '📡'
    };

    function renderActivity(){
    const wrap = document.getElementById('activityList');
    if(!wrap) return;
    const filter = wrap.dataset.filter || 'all';
    const list = load(DB.activity, []).filter(a => filter === 'all' || a.type === filter);
    document.getElementById('activityCountBadge') && (document.getElementById('activityCountBadge').textContent = list.length + ' Events');

    if(list.length === 0){
        wrap.innerHTML = '<div class="empty-state">No system activity recorded yet.</div>';
        return;
    }
    wrap.innerHTML = list.slice(0, 60).map(a => `
        <div class="activity-item">
        <div class="activity-icon">${ACTIVITY_ICONS[a.type] || '•'}</div>
        <div>
            <div class="activity-text">${a.message}</div>
            <div class="activity-meta">${fmtTime(a.at)} · ${timeAgo(a.at)}</div>
        </div>
        </div>
    `).join('');
    }

    function filterActivity(type, btn){
    const wrap = document.getElementById('activityList');
    wrap.dataset.filter = type;
    document.querySelectorAll('.activity-filters button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderActivity();
    }

   async function notifyResident(request, message){
    if (!request.sender_id) return;
    const { error } = await supabase.from('notifications').insert({
        receiver_id: request.sender_id,
        title: 'Request Update',
        message: message
    });
    if (error) console.error('Hindi na-send ang notification:', error.message);
    }

    function renderNotifications(requestId){
    const wrap = document.getElementById('evalNotifications');
    if(!wrap) return;
    const list = load(DB.notifications, []).filter(n => n.requestId === requestId);
    if(list.length === 0){
        wrap.innerHTML = '<div class="empty-state" style="padding:14px;">No notifications sent for this request yet.</div>';
        return;
    }
    wrap.innerHTML = list.map(n => `
        <div class="notif-item">
        <div class="n-head"><span>To ${n.residentName}</span><span class="notif-channel-tag">${n.channel}</span></div>
        <div class="n-body">${n.message}</div>
        <div class="n-time">${fmtTime(n.at)}</div>
        </div>
    `).join('');
    }

    /* ---------------------------------------------------------
    TAB NAVIGATION
    --------------------------------------------------------- */
    const TABS = ['dashboard','fleet','docs','queue','activity','users','comms','reports'];
    function switchTab(tab){
    TABS.forEach(t => {
        const panel = document.getElementById(t + '-tab');
        const btn = document.getElementById('btn-' + t);
        if(panel) panel.style.display = (t === tab) ? 'block' : 'none';
        if(btn) btn.classList.toggle('active', t === tab);
    });
   if(tab === 'dashboard') renderDashboardCounts();
    if(tab === 'fleet') loadFleetFromSupabase();
    if(tab === 'docs') loadTranspoFromSupabase();
if(tab === 'queue') loadMedicalRequestsFromSupabase();
    if(tab === 'activity'){ renderActivity(); setTabDot('activity', false); }
   if(tab === 'users') loadUsersFromSupabase();
    if(tab === 'comms' && typeof renderComms === 'function') renderComms();
    if(tab === 'reports' && typeof renderReports === 'function') renderReports();
    }

    /* ---------------------------------------------------------
    ROLE / SESSION BADGE
    --------------------------------------------------------- */
   function initRoleBadge(profile){
    const badge = document.getElementById('activeRoleBadge');
    if(badge) badge.textContent = profile.role === 'admin' ? 'Admin / Barangay Captain' : profile.role;
    if(profile.role === 'admin'){
        const usersBtn = document.getElementById('btn-users');
        if(usersBtn) usersBtn.style.display = 'inline-block';
        const mutualAidBtn = document.getElementById('btn-mutual-aid');
        if(mutualAidBtn) mutualAidBtn.style.display = 'inline-block';
    }
}

   function logout(){
    if(confirm('Log out of the Barangay Bambang control center?')){
        supabase.auth.signOut().then(() => {
            window.location.href = '/pages/adminlogin.html';
        });
    }
}

    /* ---------------------------------------------------------
    DASHBOARD: SUMMARY COUNTS + INCIDENT FEED
    --------------------------------------------------------- */
    function renderDashboardCounts(){
    const incidents = incidentsCache;
    const requests = load(DB.requests, []);

    const open = incidents.filter(i => i.status === 'Pending').length;
    const assigned = incidents.filter(i => i.status === 'Assigned').length;
    const resolved = incidents.filter(i => i.status === 'Resolved').length;

    const openCountEl = document.getElementById('openCount');
    const assignedCountEl = document.getElementById('assignedCount');
    const resolvedCountEl = document.getElementById('resolvedCount');
    if(openCountEl) openCountEl.textContent = open;
    if(assignedCountEl) assignedCountEl.textContent = assigned;
    if(resolvedCountEl) resolvedCountEl.textContent = resolved;

    renderIncidentFeed();
    renderQuickFleetStatus();
    renderDocumentationHistory();
}
/* BAGO — priority order ng Incoming Emergency Feed:
      0) SOS na Pending           — pinaka-agarang kailangan ng aksyon
      1) Emergency na Pending     — kasunod na priyoridad
      2) Assigned                 — meron nang team, dinidispatch pa lang
      3) In Transit                — papunta na ang responder
      4) Arrived                  — nasa lokasyon na, malapit nang matapos
      5) iba pa (hal. Waiting List) — panghuli
      Ang kani-kanilang orden sa loob ng parehong ranggo ay unseen-first,
      tapos pinakabago. */
   function incidentFeedRank(i){
        if(i.type === 'SOS' && i.status === 'Pending') return 0;
        if(i.type === 'Emergency' && i.status === 'Pending') return 1;
        if(i.status === 'Assigned') return 2;
        if(i.status === 'In Transit') return 3;
        if(i.status === 'Arrived') return 4;
        return 5;
    }

   function renderIncidentFeed(){
    const wrap = document.getElementById('reportsList');
    const empty = document.getElementById('reportsEmpty');
    const badge = document.getElementById('reportCountBadge');
    if(!wrap) return;

    const open = incidentsCache
        .filter(i => !TERMINAL_INCIDENT_STATUSES.includes(i.status))
        .slice()
        .sort((a, b) => {
            const rankDiff = incidentFeedRank(a) - incidentFeedRank(b);
            if(rankDiff !== 0) return rankDiff;

            const unseen = unseenIds.dashboard;
            const aUnseen = unseen.has(String(a.id)) ? 0 : 1;
            const bUnseen = unseen.has(String(b.id)) ? 0 : 1;
            if(aUnseen !== bUnseen) return aUnseen - bUnseen;

            return new Date(b.created_at) - new Date(a.created_at);
        });

    badge && (badge.textContent = open.length + ' Reports');
    empty && (empty.style.display = open.length ? 'none' : 'block');

    wrap.innerHTML = open.map(i => {
        const callerName = i.sender ? i.sender.name : 'Unknown Resident';
        const mapLink = (i.lat && i.lng)
            ? `<a href="https://www.google.com/maps?q=${i.lat},${i.lng}" target="_blank" onclick="event.stopPropagation();" style="color:#00b0ff;">View on Map</a>`
            : 'No GPS data';
        return `
        <div class="report-card" onclick="openAssignModal(${i.id})">
        <div class="report-card-top">
            <span class="report-card-name">🚨 ${i.category || i.type}</span>
            <span class="status-pill ${statusClass(i.status)}"><span class="status-dot"></span>${i.status}</span>
        </div>
        <div class="report-card-detail">${callerName} · ${mapLink}</div>
        <div class="report-card-detail" style="color:#aaa;">${i.description || ''}</div>
        <div class="timestamp">${timeAgo(i.created_at)}</div>
        </div>
    `;}).join('');
}

    async function loadIncidentsFromSupabase() {
    const { data, error } = await supabase
        .from('emergency_requests')
       .select('*, sender:profiles!emergency_requests_sender_id_fkey(name, contact)')
        .in('type', ['Emergency', 'SOS'])
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Hindi makuha ang emergency requests:', error.message);
        return;
    }

    incidentsCache = data;
    renderDashboardCounts();
    refreshTrackingModalIfOpen();
}

function subscribeIncidentsRealtime() {
    supabase
        .channel('emergency-requests-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'emergency_requests' }, (payload) => {
            const isSOSorEmergency = ['Emergency', 'SOS'].includes(payload.new?.type || payload.old?.type);
            if (!isSOSorEmergency) return;

            if(payload.eventType === 'INSERT'){
                // Bagong SOS mula sa resident — i-refresh ang cache muna
                // para makuha yung sender info, tapos i-trigger ang alerts.
                loadIncidentsFromSupabase().then(() => {
                    const inc = incidentsCache.find(i => String(i.id) === String(payload.new.id)) || payload.new;
                    startSOSAlertLoop();
                    showSOSToast(inc);
                    showBrowserSOSNotification(inc);
                   markTabUpdated('dashboard', payload.new.id);   // BAGO
                    const label = inc.type === 'SOS' ? '🚨 SOS Panic Button' : '🚨 New emergency';
                    logActivity('notify', `${label} received from <b>${inc?.sender?.name || 'resident'}</b>.`);
                });
            } else {
                loadIncidentsFromSupabase();
            }
        })
        .subscribe();
}

    /* ---------------------------------------------------------
    SERVICE COMPLETION RECORDS — sinasagot ng responder gamit ang
    "Service Completion Record" form sa responder.html. Naka-save ito
    sa hiwalay na 'service_records' table (hindi sa emergency_requests),
    kaya kinukuha natin ito nang hiwalay at pinapares sa kani-kanilang
    incident gamit ang request_id, para makita ng admin sa Documentation
    Tracker ang buong detalye ng ginawang assistance ng responder.
    --------------------------------------------------------- */
    async function loadServiceRecordsFromSupabase() {
        const { data, error } = await supabase
            .from('service_records')
            .select('*')
            .order('completed_at', { ascending: false });

        if (error) {
            console.error('Hindi makuha ang service records:', error.message);
            return;
        }

        serviceRecordsCache = data || [];
        renderDocumentationHistory();
    }

    function subscribeServiceRecordsRealtime() {
        supabase
            .channel('service-records-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'service_records' }, () => {
                loadServiceRecordsFromSupabase();
            })
            .subscribe();
    }

    function findServiceRecordForIncident(incidentId){
        return serviceRecordsCache.find(sr => String(sr.request_id) === String(incidentId)) || null;
    }


    /*FLEET & PERSONNEL — REAL-TIME AVAILABILITY MONITORING
    (Ngayon ay galing na sa Supabase, hindi na sa localStorage)
    --------------------------------------------------------- */
 async function loadFleetFromSupabase() {
        const { data, error } = await supabase
            .from('fleet')
            .select('*')
            .order('name', { ascending: true });

        if (error) {
            console.error('Hindi makuha ang fleet:', error.message);
            return;
        }

        fleetCache = data.map(f => ({
            id: f.id,
            name: f.name,
            type: f.type,
            plate: f.plate_number,
            status: f.status,
            assignedTo: f.assigned_to,
            profileId: f.profile_id,
            lastUpdated: f.updated_at || f.created_at
        }));

        await loadResponderProfilesForFleet();
        await syncMissingPersonnelToFleet();   // BAGO
        renderFleet();
        renderQuickFleetStatus();
    }

    // BAGO — hinahanap ang Driver/Responder accounts na wala pang
    // kaukulang row sa 'fleet' table (hal. matagal nang gawa, bago
    // pa nailagay ang auto-register), at ginagawan ng fleet row.
    async function syncMissingPersonnelToFleet(){
        const linkedProfileIds = new Set(fleetCache.filter(f => f.profileId).map(f => f.profileId));
        const missing = responderProfilesCache.filter(p => !linkedProfileIds.has(p.id));
        if(missing.length === 0) return;

        const rows = missing.map(p => ({
            name: p.name,
          type: (p.position || '').toLowerCase() === 'driver' ? 'Driver' : 'Medical Personnel',
            status: 'Available',
            profile_id: p.id
        }));

        const { error } = await supabase.from('fleet').insert(rows);
        if(error){
            console.error('Hindi na-sync ang ilang personnel sa fleet:', error.message);
            return;
        }

        logActivity('fleet', `${missing.length} personnel account(s) auto-synced sa fleet roster.`);

        // ulitin ang fetch para makuha yung bagong naidagdag na rows
        const { data: refreshed } = await supabase.from('fleet').select('*').order('name', { ascending: true });
        if(refreshed){
            fleetCache = refreshed.map(f => ({
                id: f.id, name: f.name, type: f.type, plate: f.plate_number,
                status: f.status, assignedTo: f.assigned_to, profileId: f.profile_id,
                lastUpdated: f.updated_at || f.created_at
            }));
        }
    }

 async function loadResponderProfilesForFleet(){
        const { data, error } = await supabase
            .from('profiles')
            .select('id, name, role, position')
            .eq('role', 'responder')
            .order('name', { ascending: true });
        if(error){ console.error('Hindi makuha ang responder accounts:', error.message); return; }
        responderProfilesCache = data || [];

        const sel = document.getElementById('fleetLinkedProfile');
        if(sel){
            const current = sel.value;
            sel.innerHTML = '<option value="">— No linked account —</option>' +
                responderProfilesCache.map(p => `<option value="${p.id}">${p.name} (${p.position || 'Responder'})</option>`).join('');
            if(current) sel.value = current;
        }
    }


   function subscribeFleetRealtime() {
        supabase
            .channel('fleet-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'fleet' }, (payload) => {
            if(payload.eventType === 'INSERT') markTabUpdated('fleet', payload.new.id);   // BAGO
                loadFleetFromSupabase();
            })
            .subscribe();
    }

    function fleetSummary(list){
    return {
        available: list.filter(f => f.status === 'Available').length,
        onDuty: list.filter(f => f.status === 'On Duty').length,
        unavailable: list.filter(f => f.status === 'Unavailable').length
    };
    }

    function statusClass(status){ return 'status-' + status.replace(/\s+/g,''); }

    function renderQuickFleetStatus(){
    const list = fleetCache;
    const wrap = document.getElementById('quickFleetStatus');
    if(!wrap) return;
    const s = fleetSummary(list);
    const stripHtml = `
        <div class="fleet-summary-strip">
        <div class="fleet-summary-chip"><div class="n" style="color:var(--green);">${s.available}</div><div class="l">Available</div></div>
        <div class="fleet-summary-chip"><div class="n" style="color:var(--blue);">${s.onDuty}</div><div class="l">On Duty</div></div>
        <div class="fleet-summary-chip"><div class="n" style="color:var(--red);">${s.unavailable}</div><div class="l">Unavailable</div></div>
        </div>
        <div style="text-align:right; margin-bottom:6px;">
        <span class="live-indicator"><span class="status-dot pulse"></span>Live · updated ${timeAgo(new Date().toISOString())}</span>
        </div>
    `;
    const rows = list.map(f => {
        // BAGO: i-shorten yung assignedTo para di masyadong mahaba sa compact row
        const shortAssign = f.assignedTo ? f.assignedTo.split(' (')[0] : ''; // tanggalin yung "(Vehicle: X, Driver: Y)" part dito
        return `
        <div class="fleet-quick-row">
        <div>
            <div class="fleet-quick-name">${f.name}</div>
            <div class="fleet-quick-type">${f.type}${shortAssign ? ' · ' + shortAssign : ''}</div>
        </div>
        <span class="status-pill ${statusClass(f.status)}"><span class="status-dot"></span>${f.status}</span>
        </div>
    `;}).join('');
    wrap.innerHTML = stripHtml + rows;
}

  const FLEET_VEHICLE_TYPES = ['Medical (Full)', 'Transport', 'Rescue/Patrol', 'Auxiliary'];
  const FLEET_PERSONNEL_TYPES = ['Driver', 'Medical Personnel'];

  function fleetRowHTML(f){
    const linked = f.profileId ? responderProfilesCache.find(p => p.id === f.profileId) : null;
    return `
        <tr>
        <td>
            <div style="font-weight:600;">${f.name}</div>
            <div class="timestamp">${f.plate || 'N/A'} · updated ${timeAgo(f.lastUpdated)}${linked ? ' · 🔗 ' + linked.name : ''}</div>
        </td>
        <td>${f.type}</td>
        <td>
            ${f.assignedTo
                ? `<span class="status-pill status-OnDuty" style="white-space:normal; display:inline-block; line-height:1.4;">👥 ${f.assignedTo}</span>`
                : '<span style="color:#666;font-size:.8em;">— Unassigned —</span>'}
        </td>
        <td>
            <select class="mini-select" onchange="updateFleetStatus('${f.id}', this.value)">
            ${['Available','On Duty','Unavailable'].map(st => `<option value="${st}" ${f.status===st?'selected':''}>${st}</option>`).join('')}
            </select>
        </td>
        <td>
            <button class="primary-btn" style="background:#333;color:#eee;font-size:.72em;padding:6px 10px;" onclick="editFleet('${f.id}')">Edit</button>
            <button class="primary-btn" style="background:#3a1c1c;color:#ff8a8a;font-size:.72em;padding:6px 10px;" onclick="removeFleet('${f.id}')">Remove</button>
        </td>
        </tr>
    `;
  }

  // BAGO — hinati ang isang table dati na naghahalo ng sasakyan at tao
  // sa dalawang magkahiwalay na listahan, para mas malinaw.
 function renderFleet(){
    const vehicles = sortUnseenFirst(fleetCache.filter(f => FLEET_VEHICLE_TYPES.includes(f.type)), 'fleet');   // BAGO
    const personnel = sortUnseenFirst(fleetCache.filter(f => FLEET_PERSONNEL_TYPES.includes(f.type)), 'fleet');   // BAGO

    const vehicleTbody = document.getElementById('fleetVehicleList');
    if(vehicleTbody) vehicleTbody.innerHTML = vehicles.map(fleetRowHTML).join('');

    const personnelTbody = document.getElementById('fleetPersonnelList');
    if(personnelTbody) personnelTbody.innerHTML = personnel.map(fleetRowHTML).join('');

    renderQuickFleetStatus();
    populateDispatchSelects();
}

   async function updateFleetStatus(id, newStatus){
     const f = fleetCache.find(x => String(x.id) === String(id));
    if(!f) return;
    markSeen('fleet', id);   // BAGO
    const oldStatus = f.status;

    const updateData = { status: newStatus };
    if (newStatus !== 'On Duty') updateData.assigned_to = null;

    const { data, error } = await supabase
        .from('fleet')
        .update(updateData)
        .eq('id', id)
        .select();

    if (error) {
        alert('Hindi na-update ang status: ' + error.message);
        loadFleetFromSupabase();
        return;
    }

    if (!data || data.length === 0) {
        alert('Hindi talaga na-apply ang update sa fleet table. Malamang RLS/permissions issue — i-check ang UPDATE policy sa Supabase para sa "fleet" table.');
        loadFleetFromSupabase();
        return;
    }

    logActivity('fleet', `<b>${f.name}</b> status changed: ${oldStatus} → ${newStatus}`);
    loadFleetFromSupabase();
}

    async function handleFleetSubmit(e){
    e.preventDefault();
    const id = document.getElementById('fleetId').value;
    const data = {
        name: document.getElementById('fleetName').value.trim(),
        type: document.getElementById('fleetType').value,
        plate_number: document.getElementById('fleetPlate').value.trim(),
        status: document.getElementById('fleetStatus').value,
        profile_id: document.getElementById('fleetLinkedProfile').value || null
    };

    if(id){
        const { error } = await supabase.from('fleet').update(data).eq('id', id);
        if (error) { alert('Hindi na-update: ' + error.message); return; }
        logActivity('fleet', `Resource updated: <b>${data.name}</b> (${data.type})`);
    }else{
        const { error } = await supabase.from('fleet').insert(data);
        if (error) { alert('Hindi naidagdag: ' + error.message); return; }
        logActivity('fleet', `New resource registered: <b>${data.name}</b> (${data.type})`);
    }

    clearFleetForm();
    loadFleetFromSupabase();
    }

    function editFleet(id){
   const f = fleetCache.find(x => String(x.id) === String(id));
    if(!f) return;
    markSeen('fleet', id);   // BAGO
    document.getElementById('fleetId').value = f.id;
    document.getElementById('fleetName').value = f.name;
    document.getElementById('fleetType').value = f.type;
    document.getElementById('fleetPlate').value = f.plate;
    document.getElementById('fleetStatus').value = f.status;
    document.getElementById('fleetLinkedProfile').value = f.profileId || '';
    document.getElementById('formFleetTitle').textContent = '🚒 Edit Resource Unit';
    }

    async function removeFleet(id){
    if(!confirm('Remove this resource from the fleet roster?')) return;

      const { error } = await supabase.from('fleet').delete().eq('id', id);
    if (error) { alert('Hindi matanggal: ' + error.message); return; }

    logActivity('fleet', 'A resource unit was removed from the roster.');
    loadFleetFromSupabase();
    }

    function clearFleetForm(){
    document.getElementById('fleetForm').reset();
    document.getElementById('fleetId').value = '';
    document.getElementById('formFleetTitle').textContent = '🚒 Register Ambulance / Resource Unit';
    }

function populateDispatchSelects(){
    const vehicleSel = document.getElementById('dispatchVehicle');
    const responderSel = document.getElementById('dispatchResponder');
    if(!vehicleSel || !responderSel) return;

    const vehicles = fleetCache.filter(f => ['Medical (Full)','Transport','Rescue/Patrol','Auxiliary'].includes(f.type));
    const responders = fleetCache.filter(f => f.type === 'Medical Personnel' || f.type === 'Driver');

    const statusTag = (f) => f.status === 'Available' ? '🟢 Available'
        : f.status === 'On Duty' ? '🟡 On Duty'
        : '🔴 Unavailable';

    const buildOptions = (list) => list.map(f =>
        `<option value="${f.id}" ${f.status !== 'Available' ? 'disabled' : ''}>${f.name} — ${statusTag(f)}</option>`
    ).join('');

    vehicleSel.innerHTML = '<option value="">— None —</option>' + buildOptions(vehicles);
    responderSel.innerHTML = '<option value="">— None —</option>' + buildOptions(responders);
}

function buildCrewTag(member, vehicle, responder, assignmentTag){
    const partners = [];
    if(vehicle && String(member.id) !== String(vehicle.id)) partners.push(`Vehicle: ${vehicle.name}`);
    if(responder && String(member.id) !== String(responder.id)) partners.push(`Responder: ${responder.name}`);
    const partnerStr = partners.length ? ` (${partners.join(', ')})` : '';
    return assignmentTag + partnerStr;
}

async function handleQuickDispatch(e){
    e.preventDefault();

    const vehicleId = document.getElementById('dispatchVehicle').value;
    const responderId = document.getElementById('dispatchResponder').value;
    const source = document.getElementById('dispatchSource').value;   // BAGO — Phone Call / Text Message / FB Message
    const notes = document.getElementById('dispatchNotes').value;

    if(!vehicleId && !responderId){
        alert('Pumili ng kahit isang vehicle o responder bago mag-dispatch.');
        return;
    }

    const vehicle = vehicleId ? fleetCache.find(f => String(f.id) === String(vehicleId)) : null;
    const responder = responderId ? fleetCache.find(f => String(f.id) === String(responderId)) : null;

    const teamLabel = [vehicle?.name, responder?.name].filter(Boolean).join(' + ');
    // BAGO — Quick Dispatch ay para sa mga emergency na hindi galing sa
    // app (tumawag/nag-text/nag-FB message sa barangay), kaya wala nang
    // naka-link na incident record — ang paraan ng pagtanggap na lang
    // ang inilalagay bilang tag.
    const assignmentTag = source ? `Report via ${source}` : (notes || 'Standby / Patrol');

    const membersToUpdate = [vehicle, responder].filter(Boolean);
    for(const member of membersToUpdate){
        const memberTag = buildCrewTag(member, vehicle, responder, assignmentTag); // BAGO
        const { error } = await supabase.from('fleet')
            .update({ status: 'On Duty', assigned_to: memberTag })
            .eq('id', member.id)
            .select();
        if(error){ alert(`Hindi na-update ang ${member.name}: ` + error.message); return; }
    }

    logActivity('dispatch', `<b>${teamLabel}</b> dispatched${source ? ' — reported via ' + source : ' (standby/patrol)'}${notes ? ' — ' + notes : ''}`);

    document.getElementById('quickDispatchForm').reset();
    loadFleetFromSupabase();
}

    /* ---------------------------------------------------------
    DISPATCH CONTROL CENTER MODAL (from Incident Feed cards)
    ---------------------------------------------------------
    BAGO: Ang modal na ito ay may 2 mode ngayon:
      1) DISPATCH FORM — kapag wala pang naka-assign na team
         (status: Pending / Waiting List). Dito pinipili ang
         driver at responder.
      2) LIVE TRACKING VIEW — kapag naka-assign na (status:
         Assigned / In Transit / Arrived). Sa halip na ipakita
         ulit ang dispatch form, isang mapa na ang lalabas na
         nagpapakita ng lokasyon ng resident at ng responder,
         kasama ang distansya sa pagitan nila.
    --------------------------------------------------------- */
    function openAssignModal(id){
        const inc = incidentsCache.find(i => String(i.id) === String(id));
        if(!inc){ alert('Hindi makita ang incident na ito.'); return; }
        activeIncidentId = inc.id;
        markSeen('dashboard', inc.id);   // BAGO

        const callerName = inc.sender ? inc.sender.name : 'Unknown Resident';
        const contact = inc.sender && inc.sender.contact ? inc.sender.contact : '';
        const infoBox = document.getElementById('assignIncidentInfo');
        if(infoBox){
            infoBox.innerHTML = `
                <div style="margin-bottom:10px; font-size:0.85em; color:#ccc; background:#222; padding:10px; border-radius:6px;">
                    <div style="font-weight:600; color:#ffd700;">🚨 ${inc.category || inc.type}</div>
                    <div>${callerName}${contact ? ' · ' + contact : ''}</div>
                    <div style="color:#888; margin-top:4px;">${inc.description || 'No description provided.'}</div>
                    <div style="color:#666; margin-top:4px; font-size:0.85em;">Status: ${inc.status} · ${timeAgo(inc.created_at)}</div>
                </div>
            `;
        }

        const dispatchForm = document.getElementById('dispatchAssignForm');
        const trackingView = document.getElementById('trackingView');
        const titleEl = document.getElementById('assignModalTitle');

        // Sarado/tapos na — hindi na dapat i-dispatch pa o i-track pa,
        // pero hayaan pa rin nating gamitin ang tracking view (read-only)
        // kung meron pang GPS na naitala, kasama ang lumang Pending case
        // na wala pang team gamit ang dispatch form.
        const isTracking = ['Assigned', 'In Transit', 'Arrived'].includes(inc.status);

        if(isTracking){
            if(titleEl) titleEl.textContent = '📍 Live Response Tracking';
            if(dispatchForm) dispatchForm.style.display = 'none';
            if(trackingView) trackingView.style.display = 'block';
            renderTrackingView(inc);
        } else {
            if(titleEl) titleEl.textContent = '🚀 Dispatch Control Center';
            if(dispatchForm) dispatchForm.style.display = 'block';
            if(trackingView) trackingView.style.display = 'none';
            cleanupTrackingMap();

          const driverSel = document.getElementById('driverSelect');
            const responderSel = document.getElementById('responderSelect');
            const vehicleSel = document.getElementById('assignVehicleSelect');   // BAGO
            const standby = fleetCache.filter(f => f.status === 'Available');

            if(driverSel){
                const drivers = standby.filter(f => f.type === 'Driver');
                driverSel.innerHTML = '<option value="" disabled selected>Select driver on standby</option>' +
                    drivers.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
            }

           if(responderSel){
                const responders = standby.filter(f => f.type === 'Medical Personnel');
                responderSel.innerHTML = '<option value="" disabled selected>Select responder on standby</option>' +
                    responders.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
            }

            if(vehicleSel){   // BAGO
                const vehicles = standby.filter(f => FLEET_VEHICLE_TYPES.includes(f.type));
                vehicleSel.innerHTML = '<option value="">— None —</option>' +
                    vehicles.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
            }

            const notesEl = document.getElementById('assignNotes');
            if(notesEl) notesEl.value = '';
        }

        document.getElementById('assignModal').style.display = 'flex';
    }

    /* Kapag may bagong data na dumating (realtime update) habang bukas
       ang modal at nasa tracking mode, i-refresh ang mapa/info nang hindi
       kinakailangang isara ito ng admin. */
    function refreshTrackingModalIfOpen(){
        const modal = document.getElementById('assignModal');
        const trackingView = document.getElementById('trackingView');
        if(!modal || !trackingView) return;
        if(modal.style.display !== 'flex' || trackingView.style.display !== 'block') return;
        if(!activeIncidentId) return;

        const inc = incidentsCache.find(i => String(i.id) === String(activeIncidentId));
        if(!inc) return;

        if(['Assigned', 'In Transit', 'Arrived'].includes(inc.status)){
            renderTrackingView(inc);
        } else {
            // Na-resolve o binago ang status habang bukas ang modal — isara na lang.
            modal.style.display = 'none';
        }
    }

    function cleanupTrackingMap(){
        if(trackingMap){
            trackingMap.remove();
            trackingMap = null;
            trackingResidentMarker = null;
            trackingResponderMarker = null;
            trackingRouteLine = null;
        }
    }

    /** Distansya sa pagitan ng dalawang GPS coordinate, sa metro (Haversine formula). */
    function haversineDistanceMeters(lat1, lng1, lat2, lng2){
        const R = 6371000;
        const toRad = d => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    function formatDistance(meters){
        if(meters === null || meters === undefined || Number.isNaN(meters)) return null;
        if(meters < 1000) return Math.round(meters) + ' m';
        return (meters / 1000).toFixed(1) + ' km';
    }

    function renderTrackingView(inc){
        cleanupTrackingMap();

        const mapEl = document.getElementById('trackingMap');
        const infoEl = document.getElementById('trackingInfo');
        if(!mapEl) return;

        if(!inc.lat || !inc.lng){
            mapEl.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:0.82em;text-align:center;padding:14px;">
                    Walang GPS data na isinumite ng resident para sa request na ito.
                </div>`;
        } else {
            mapEl.innerHTML = '';
            trackingMap = L.map(mapEl, { zoomControl: true }).setView([inc.lat, inc.lng], 15);

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; OpenStreetMap contributors',
                maxZoom: 19
            }).addTo(trackingMap);

            const residentIcon = L.divIcon({
                className: '',
                html: '<div style="background:#d32f2f;width:16px;height:16px;border-radius:50%;border:3px solid white;box-shadow:0 0 6px rgba(0,0,0,0.5);"></div>',
                iconSize: [16, 16]
            });
            trackingResidentMarker = L.marker([inc.lat, inc.lng], { icon: residentIcon })
                .addTo(trackingMap)
                .bindPopup(`<b>${inc.sender ? inc.sender.name : 'Resident'}</b><br>${inc.category || inc.type}`)
                .openPopup();

            const bounds = [[inc.lat, inc.lng]];

            if(inc.responder_lat && inc.responder_lng){
                const responderIcon = L.divIcon({
                    className: '',
                    html: '<div style="background:#00b0ff;width:16px;height:16px;border-radius:50%;border:3px solid white;box-shadow:0 0 6px rgba(0,0,0,0.5);"></div>',
                    iconSize: [16, 16]
                });
                trackingResponderMarker = L.marker([inc.responder_lat, inc.responder_lng], { icon: responderIcon })
                    .addTo(trackingMap)
                    .bindPopup(`Responder: ${inc.assigned_to || 'Papunta na'}`);

                trackingRouteLine = L.polyline(
                    [[inc.responder_lat, inc.responder_lng], [inc.lat, inc.lng]],
                    { color: '#00b0ff', weight: 3, dashArray: '6,6' }
                ).addTo(trackingMap);

                bounds.push([inc.responder_lat, inc.responder_lng]);
            }

            if(bounds.length > 1){
                trackingMap.fitBounds(bounds, { padding: [30, 30] });
            }
            setTimeout(() => { if(trackingMap) trackingMap.invalidateSize(); }, 200);
        }

        if(infoEl){
            let distanceLine;
            if(inc.lat && inc.lng && inc.responder_lat && inc.responder_lng){
                const d = haversineDistanceMeters(inc.lat, inc.lng, inc.responder_lat, inc.responder_lng);
                distanceLine = `<div>📏 Distance to resident: <b style="color:#ffd700;">${formatDistance(d)}</b></div>`;
            } else {
                distanceLine = `<div style="color:#888;">📏 Naghihintay pa ng GPS signal ng responder...</div>`;
            }
            infoEl.innerHTML = `
                <div>👥 Assigned team: <b>${inc.assigned_to || 'Not yet on record'}</b></div>
                <div>⏱ ETA / Notes: <b>${inc.eta || 'N/A'}</b></div>
                ${distanceLine}
                <div style="color:#666; font-size:0.85em; margin-top:4px;">${inc.location_updated_at ? 'Responder location updated ' + timeAgo(inc.location_updated_at) : 'No responder location update yet.'}</div>
            `;
        }
    }


function printIncidentReport(){
    const inc = incidentsCache.find(i => i.id === activeIncidentId);
    if(!inc){ alert('Walang napiling incident na i-print.'); return; }

    const callerName = inc.sender ? inc.sender.name : 'Unknown Resident';
    const contact = inc.sender ? inc.sender.contact : 'N/A';

    const printWindow = window.open('', '_blank', 'width=800,height=900');
    printWindow.document.write(`
        <html>
        <head>
            <title>Incident Report - ${inc.category || inc.type}</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 30px; color: #111; }
                h1 { font-size: 18px; border-bottom: 2px solid #333; padding-bottom: 8px; }
                table { width: 100%; border-collapse: collapse; margin-top: 16px; }
                td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; font-size: 13px; }
                th { width: 180px; color: #555; }
                .footer { margin-top: 40px; font-size: 11px; color: #777; }
            </style>
        </head>
        <body>
            <h1>e-Medicare — Barangay Bambang Incident Report</h1>
            <table>
                <tr><th>Incident Type</th><td>${inc.category || inc.type}</td></tr>
                <tr><th>Reported By</th><td>${callerName} (${contact})</td></tr>
                <tr><th>Description</th><td>${inc.description || 'N/A'}</td></tr>
                <tr><th>Status</th><td>${inc.status}</td></tr>
                <tr><th>Assigned To</th><td>${inc.assigned_to || 'Not yet assigned'}</td></tr>
                <tr><th>ETA / Notes</th><td>${inc.eta || 'N/A'}</td></tr>
                <tr><th>Date Reported</th><td>${fmtTime(inc.created_at)}</td></tr>
                <tr><th>Location (GPS)</th><td>${inc.lat && inc.lng ? `${inc.lat}, ${inc.lng}` : 'No GPS data'}</td></tr>
            </table>
            <div class="footer">Generated ${fmtTime(nowISO())} · e-Medicare Barangay Bambang Control Center</div>
        </body>
        </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 300);
}

   async function handleAssignResponder(e){
    e.preventDefault();
    const driverId = document.getElementById('driverSelect').value;
    const responderId = document.getElementById('responderSelect').value;
    const vehicleId = document.getElementById('assignVehicleSelect').value;   // BAGO
    const notes = document.getElementById('assignNotes').value;
    const inc = incidentsCache.find(i => i.id === activeIncidentId);
    const driver = fleetCache.find(f => String(f.id) === String(driverId));
    const responder = fleetCache.find(f => String(f.id) === String(responderId));
    const vehicle = vehicleId ? fleetCache.find(f => String(f.id) === String(vehicleId)) : null;   // BAGO

    if(!inc) return;
    if(!driver || !responder){
        alert('Kailangan piliin ang parehong Driver at Responder bago mag-dispatch.');
        return;
    }

    const teamLabel = [vehicle?.name, driver.name, responder.name].filter(Boolean).join(' + ');   // BAGO — kasama na ang vehicle

  const { error: incError } = await supabase
        .from('emergency_requests')
        .update({
            status: 'Assigned',
            assigned_to: teamLabel,
            eta: notes,
            assigned_responder_id: responder.profileId || null,
            assigned_responder_name: responder.name,
            assigned_driver_id: driver.profileId || null,
            assigned_at: new Date().toISOString()   // BAGO — para sa Response Time analytics
        })
        .eq('id', inc.id);
    if (incError) { alert('Hindi na-update ang request: ' + incError.message); return; }

    const assignTag = `${inc.category || inc.type}, ${inc.sender ? inc.sender.name : 'Resident'}`;

    // BAGO — helper na naglalagay ng "Vehicle:", "Driver:", "Responder:" text
    // sa assigned_to, para nababasa ito ng responder.js (regex parsing doon).
    const buildTeamTag = (member) => {
        const partners = [];
        if(vehicle && String(member.id) !== String(vehicle.id)) partners.push(`Vehicle: ${vehicle.name}`);
        if(String(member.id) !== String(driver.id)) partners.push(`Driver: ${driver.name}`);
        if(String(member.id) !== String(responder.id)) partners.push(`Responder: ${responder.name}`);
        return assignTag + (partners.length ? ` (${partners.join(', ')})` : '');
    };

    const { data: driverUpdate, error: driverError } = await supabase
        .from('fleet')
        .update({ status: 'On Duty', assigned_to: buildTeamTag(driver) })
        .eq('id', driver.id)
        .select();
    if (driverError) { alert('Hindi na-dispatch ang driver: ' + driverError.message); return; }

    const { data: responderUpdate, error: responderError } = await supabase
        .from('fleet')
        .update({ status: 'On Duty', assigned_to: buildTeamTag(responder) })
        .eq('id', responder.id)
        .select();
    if (responderError) { alert('Hindi na-dispatch ang responder: ' + responderError.message); return; }

    // BAGO — i-dispatch din ang vehicle kung may pinili
    let vehicleUpdate = null;
    if(vehicle){
        const { data, error: vehicleError } = await supabase
            .from('fleet')
            .update({ status: 'On Duty', assigned_to: buildTeamTag(vehicle) })
            .eq('id', vehicle.id)
            .select();
        if (vehicleError) { alert('Hindi na-dispatch ang vehicle: ' + vehicleError.message); return; }
        vehicleUpdate = data;
    }

    if (!driverUpdate?.length || !responderUpdate?.length || (vehicle && !vehicleUpdate?.length)) {
        alert('May hindi na-update sa fleet status. Possible RLS/permissions issue — check ang UPDATE policy sa Supabase para sa "fleet" table.');
        loadIncidentsFromSupabase();
        return;
    }

    // BAGO — i-notify ang resident
    if (inc.sender_id) {
        await supabase.from('notifications').insert({
            receiver_id: inc.sender_id,
            title: 'Responder Dispatched',
            message: `Paparating na sina ${teamLabel} para sa iyong emergency request.${notes ? ' ETA: ' + notes : ''}`
        });
    }

    // BAGO — i-notify ang driver AT responder mismo (kung may naka-link na account)
    const dispatchNotifications = [];
    if (driver.profileId) {
        dispatchNotifications.push({
            receiver_id: driver.profileId,
            title: 'New Dispatch Assignment',
            message: `Na-assign ka bilang driver kasama si ${responder.name} sa ${inc.category || inc.type} (${inc.sender ? inc.sender.name : 'Resident'}).${notes ? ' Notes: ' + notes : ''}`
        });
    }
    if (responder.profileId) {
        dispatchNotifications.push({
            receiver_id: responder.profileId,
            title: 'New Dispatch Assignment',
            message: `Na-assign ka bilang responder kasama si ${driver.name} sa ${inc.category || inc.type} (${inc.sender ? inc.sender.name : 'Resident'}).${notes ? ' Notes: ' + notes : ''}`
        });
    }
    if (dispatchNotifications.length) {
        const { error: notifError } = await supabase.from('notifications').insert(dispatchNotifications);
        if (notifError) console.error('Hindi na-send ang dispatch notification:', notifError.message);
    }

    logActivity('dispatch', `<b>${teamLabel}</b> dispatched to ${inc.category || inc.type} (${inc.sender ? inc.sender.name : 'Resident'})${notes ? ' — ETA: ' + notes : ''}`);
    document.getElementById('assignModal').style.display = 'none';
    loadIncidentsFromSupabase();
    loadFleetFromSupabase();
   }

  async function openIncidentPhotosModal(){
    const inc = incidentsCache.find(i => i.id === activeIncidentId);
    if(!inc) return;

    const grid = document.getElementById('incidentPhotosGrid');
    const photos = Array.isArray(inc.photo_urls) ? inc.photo_urls : [];

    if(photos.length === 0){
        grid.innerHTML = '<div class="empty-state" style="padding:20px;">Walang naka-attach na litrato mula sa resident para sa request na ito.</div>';
        document.getElementById('incidentPhotosModal').style.display = 'flex';
        return;
    }

    grid.innerHTML = photos.map((_, i) => `
        <div style="width:160px; height:160px; background:#1a1c20; border:1px solid #333; border-radius:8px; display:flex; align-items:center; justify-content:center; overflow:hidden;">
            <img id="incidentPhoto-${i}" src="" style="display:none; max-width:100%; max-height:100%; object-fit:contain;">
            <div id="incidentPhotoEmpty-${i}" style="font-size:0.75em; color:#666;">Loading…</div>
        </div>
    `).join('');

    document.getElementById('incidentPhotosModal').style.display = 'flex';

    for(let i = 0; i < photos.length; i++){
        const { data, error } = await supabase.storage
            .from('emergency-photos')
            .createSignedUrl(photos[i], 300);

        const imgEl = document.getElementById(`incidentPhoto-${i}`);
        const emptyEl = document.getElementById(`incidentPhotoEmpty-${i}`);

        if(error || !data?.signedUrl){
            emptyEl.textContent = 'Hindi ma-load ang litrato.';
            continue;
        }

        imgEl.src = data.signedUrl;
        imgEl.style.display = 'block';
        emptyEl.style.display = 'none';
    }
}

function closeIncidentPhotosModal(){
    document.getElementById('incidentPhotosModal').style.display = 'none';
}


   const TERMINAL_INCIDENT_STATUSES = ['Resolved','Completed','Rejected'];

    function renderDocumentationHistory(){
    const wrap = document.getElementById('incidentHistoryList');
    if(!wrap) return;
    const resolved = incidentsCache
        .filter(i => TERMINAL_INCIDENT_STATUSES.includes(i.status))
        .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

    const badge = document.getElementById('historyCountBadge');
    badge && (badge.textContent = resolved.length + ' Records');

    if(resolved.length === 0){
        wrap.innerHTML = '<div class="empty-state" style="padding:12px;">No resolved incidents yet.</div>';
        return;
    }
    wrap.innerHTML = resolved.slice(0,5).map(i => {
        const callerName = i.sender ? i.sender.name : 'Unknown Resident';
        return `
        <div class="fleet-quick-row" onclick="viewIncidentHistoryDetail('${i.id}')" style="cursor:pointer;">
        <div>
            <div class="fleet-quick-name">${i.category || i.type}</div>
            <div class="fleet-quick-type">${callerName} · ${timeAgo(i.created_at)}</div>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
            <span class="status-pill ${statusClass(i.status)}">${i.status}</span>
            <button class="primary-btn" style="background:#333;color:#eee;font-size:.68em;padding:4px 8px;" onclick="event.stopPropagation(); printIncidentRecordFromHistory('${i.id}')">🖨️</button>
        </div>
        </div>
    `;}).join('');
    }

    /* BAGO — shared "Record Details" modal, ginagamit ng lahat ng
       history list (incident, assistance, transpo) para makita muna
       ng admin ang buong detalye ng isang record bago i-print. */
    function showRecordDetailModal(title, rows, onPrint){
        const titleEl = document.getElementById('recordDetailTitle');
        const bodyEl = document.getElementById('recordDetailBody');
        const printBtn = document.getElementById('recordDetailPrintBtn');
        if(!titleEl || !bodyEl || !printBtn) return;

        titleEl.textContent = title;
        bodyEl.innerHTML = rows.map(([label, value]) => `
            <div style="display:flex; justify-content:space-between; gap:14px; padding:7px 0; border-bottom:1px solid #333;">
                <span style="color:#999; flex:0 0 130px;">${label}</span>
                <span style="text-align:right; color:#eee; flex:1;">${value}</span>
            </div>
        `).join('');
        printBtn.onclick = onPrint;

        document.getElementById('recordDetailModal').style.display = 'flex';
    }

    function closeRecordDetailModal(){
        document.getElementById('recordDetailModal').style.display = 'none';
    }

    function viewIncidentHistoryDetail(id){
        const inc = incidentsCache.find(i => String(i.id) === String(id));
        if(!inc){ alert('Incident not found.'); return; }
        const callerName = inc.sender ? inc.sender.name : 'Unknown Resident';
        const contact = inc.sender && inc.sender.contact ? inc.sender.contact : 'N/A';
        const svc = findServiceRecordForIncident(id);

        const rows = [
            ['Reported By', `${callerName} (${contact})`],
            ['Description', inc.description || 'N/A'],
            ['Status', inc.status],
            ['Assigned To', inc.assigned_to || 'Not yet assigned'],
            ['ETA / Notes', inc.eta || 'N/A'],
            ['Date Reported', fmtTime(inc.created_at)],
            ['Location (GPS)', inc.lat && inc.lng ? `${inc.lat}, ${inc.lng}` : 'No GPS data'],
        ];

        if(svc){
            rows.push(
                ['Assistance Provided', svc.assistance_provided || 'N/A'],
                ['Patient Outcome', svc.patient_outcome || 'N/A'],
                ['Clinical Observations', svc.clinical_observations || 'N/A'],
                ['Follow-up Notes', svc.follow_up_quote || 'N/A'],
                ['Receiving Facility', svc.receiving_facility || 'N/A'],
                ['Completed By', svc.responder_name || 'N/A'],
                ['Response Duration', svc.response_duration_label || 'N/A'],
                ['Completion Time', svc.completed_at ? fmtTime(svc.completed_at) : 'N/A'],
            );
        }

        showRecordDetailModal(`🚨 ${inc.category || inc.type}`, rows, () => printIncidentRecordFromHistory(id));
    }

    function printIncidentRecordFromHistory(id){
    const inc = incidentsCache.find(i => String(i.id) === String(id));
    if(!inc){ alert('Incident not found.'); return; }
    const callerName = inc.sender ? inc.sender.name : 'Unknown Resident';
    const contact = inc.sender ? inc.sender.contact : 'N/A';
    const svc = findServiceRecordForIncident(id);

    const serviceRowsHtml = svc ? `
                <tr><th colspan="2" style="background:#f2f2f2; color:#333;">Service Completion Record</th></tr>
                <tr><th>Assistance Provided</th><td>${svc.assistance_provided || 'N/A'}</td></tr>
                <tr><th>Patient Outcome</th><td>${svc.patient_outcome || 'N/A'}</td></tr>
                <tr><th>Clinical Observations</th><td>${svc.clinical_observations || 'N/A'}</td></tr>
                <tr><th>Follow-up Notes</th><td>${svc.follow_up_quote || 'N/A'}</td></tr>
                <tr><th>Receiving Facility</th><td>${svc.receiving_facility || 'N/A'}</td></tr>
                <tr><th>Completed By</th><td>${svc.responder_name || 'N/A'}</td></tr>
                <tr><th>Response Duration</th><td>${svc.response_duration_label || 'N/A'}</td></tr>
                <tr><th>Completion Time</th><td>${svc.completed_at ? fmtTime(svc.completed_at) : 'N/A'}</td></tr>
    ` : '';

    const printWindow = window.open('', '_blank', 'width=800,height=900');
    printWindow.document.write(`
        <html>
        <head>
            <title>Incident Report - ${inc.category || inc.type}</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 30px; color: #111; }
                h1 { font-size: 18px; border-bottom: 2px solid #333; padding-bottom: 8px; }
                table { width: 100%; border-collapse: collapse; margin-top: 16px; }
                td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; font-size: 13px; }
                th { width: 180px; color: #555; }
                .footer { margin-top: 40px; font-size: 11px; color: #777; }
            </style>
        </head>
        <body>
            <h1>e-Medicare — Barangay Bambang Incident Report</h1>
            <table>
                <tr><th>Incident Type</th><td>${inc.category || inc.type}</td></tr>
                <tr><th>Reported By</th><td>${callerName} (${contact})</td></tr>
                <tr><th>Description</th><td>${inc.description || 'N/A'}</td></tr>
                <tr><th>Status</th><td>${inc.status}</td></tr>
                <tr><th>Assigned To</th><td>${inc.assigned_to || 'Not yet assigned'}</td></tr>
                <tr><th>ETA / Notes</th><td>${inc.eta || 'N/A'}</td></tr>
                <tr><th>Date Reported</th><td>${fmtTime(inc.created_at)}</td></tr>
                <tr><th>Location (GPS)</th><td>${inc.lat && inc.lng ? `${inc.lat}, ${inc.lng}` : 'No GPS data'}</td></tr>
                ${serviceRowsHtml}
            </table>
            <div class="footer">Generated ${fmtTime(nowISO())} · e-Medicare Barangay Bambang Control Center</div>
        </body>
        </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 300);
    }

   function printFullReport(){
    const avgResponse = document.getElementById('repAvgResponse')?.textContent || '—';
    const totalRequests = document.getElementById('repTotalRequests')?.textContent || '0';
    const fleetUtil = document.getElementById('repFleetUtil')?.textContent || '0%';

    const printWindow = window.open('', '_blank', 'width=850,height=1000');
    printWindow.document.write(`
        <html>
        <head>
            <title>e-Medicare — Full System Report</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 30px; color: #111; }
                h1 { font-size: 20px; border-bottom: 2px solid #333; padding-bottom: 8px; }
                h2 { font-size: 15px; margin-top: 26px; color: #333; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; font-size: 12.5px; }
                th { background: #f2f2f2; }
                .summary-row { display: flex; gap: 20px; margin-top: 10px; }
                .summary-box { border: 1px solid #ccc; border-radius: 6px; padding: 10px 16px; flex: 1; }
                .summary-box .n { font-size: 18px; font-weight: bold; }
                .summary-box .l { font-size: 11px; color: #666; }
                .footer { margin-top: 40px; font-size: 11px; color: #777; }
            </style>
        </head>
        <body>
            <h1>e-Medicare — Barangay Bambang Full System Report</h1>
            <p style="font-size:12px;color:#666;">Generated ${fmtTime(nowISO())}</p>

            <div class="summary-row">
                <div class="summary-box"><div class="n">${avgResponse}</div><div class="l">Avg. Response Time</div></div>
                <div class="summary-box"><div class="n">${totalRequests}</div><div class="l">Total Requests (All-time)</div></div>
                <div class="summary-box"><div class="n">${fleetUtil}</div><div class="l">Fleet Utilization</div></div>
            </div>

            <h2>🚨 Incidents</h2>
            <table>
                <tr><th>Type</th><th>Reported By</th><th>Status</th><th>Assigned To</th><th>Date</th></tr>
                ${incidentsCache.map(i => `
                    <tr>
                        <td>${i.category || i.type}</td>
                        <td>${i.sender ? i.sender.name : 'Unknown'}</td>
                        <td>${i.status}</td>
                        <td>${i.assigned_to || '—'}</td>
                        <td>${fmtTime(i.created_at)}</td>
                    </tr>
                `).join('')}
            </table>

            <h2>🚑 Fleet Roster</h2>
            <table>
                <tr><th>Unit / Personnel</th><th>Type</th><th>Plate</th><th>Status</th><th>Assigned To</th></tr>
                ${fleetCache.map(f => `
                    <tr>
                        <td>${f.name}</td>
                        <td>${f.type}</td>
                        <td>${f.plate || 'N/A'}</td>
                        <td>${f.status}</td>
                        <td>${f.assignedTo || '—'}</td>
                    </tr>
                `).join('')}
            </table>

            <h2>📄 Assistance Requests</h2>
            <table>
                <tr><th>Resident</th><th>Category</th><th>Priority</th><th>Status</th><th>Cost</th></tr>
                ${medicalRequestsCache.map(r => `
                    <tr>
                        <td>${r.resident_name}</td>
                        <td>${r.category}</td>
                        <td>${r.priority}</td>
                        <td>${r.status}</td>
                        <td>₱${Number(r.estimated_cost || 0).toLocaleString()}</td>
                    </tr>
                `).join('')}
            </table>

            <h2>📈 Recent Activity</h2>
            <table>
                <tr><th>Event</th><th>Date/Time</th></tr>
                ${load(DB.activity, []).slice(0, 30).map(a => `
                    <tr><td>${a.message.replace(/<[^>]+>/g, '')}</td><td>${fmtTime(a.at)}</td></tr>
                `).join('')}
            </table>
                    
            <div class="footer">e-Medicare · Barangay Bambang Control Center — Official System Printout</div>
        </body>
        </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 300);
}

    function requestMutualAid(){
    logActivity('fleet', 'Mutual aid vehicle borrow request sent to neighboring barangay dispatch.');
    alert('Mutual aid request broadcast to neighboring barangays.');
    }

    async function postAdvisory(){
    const title = document.getElementById('advTitle').value.trim();
    const msg = document.getElementById('advMsg').value.trim();
    if(!title || !msg){ alert('Please fill in both the subject and message.'); return; }

    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('advisories').insert({
        title: title,
        message: msg,
        posted_by: user?.id
    });

    if (error) {
        alert('Hindi na-post ang advisory: ' + error.message);
        return;
    }

    logActivity('advisory', `Community advisory posted: <b>${title}</b>`);
    document.getElementById('advTitle').value = '';
    document.getElementById('advMsg').value = '';
    alert('Advisory broadcast to residents.');
    }

    /* ---------------------------------------------------------
    BUDGET (funds available for financial medical assistance)
    --------------------------------------------------------- */
    function getBudget(){ return load(DB.budget, { total: 0, allocated: 0, quarter:'' }); }
    function remainingBudget(){ const b = getBudget(); return b.total - b.allocated; }

    function renderBudgetBox(targetId){
    const el = document.getElementById(targetId);
    if(!el) return;
    const b = getBudget();
    const remaining = b.total - b.allocated;
    const pct = b.total ? Math.min(100, Math.round((b.allocated / b.total) * 100)) : 0;
    const tight = remaining < b.total * 0.2;
    el.innerHTML = `
        <div class="budget-row"><span>${b.quarter} Fund Pool</span><b>₱${b.total.toLocaleString()}</b></div>
        <div class="budget-row"><span>Disbursed / Allocated</span><b>₱${b.allocated.toLocaleString()}</b></div>
        <div class="budget-bar-track"><div class="budget-bar-fill ${tight?'tight':''}" style="width:${pct}%;"></div></div>
        <div class="budget-row"><span>Remaining Balance</span><b style="color:${tight?'var(--red)':'var(--green)'};">₱${remaining.toLocaleString()}</b></div>
        <div class="budget-actions">
        <input type="number" id="topUpAmount" class="form-control" placeholder="Add funds (₱)" min="0">
        <button class="primary-btn" style="background:var(--blue); color:#fff;" onclick="topUpBudget()">Add</button>
        </div>
    `;
    }

    function topUpBudget(){
    const input = document.getElementById('topUpAmount');
    const amount = Number(input.value);
    if(!amount || amount <= 0){ alert('Enter a valid fund amount.'); return; }
    const b = getBudget();
    b.total += amount;
    save(DB.budget, b);
    logActivity('budget', `₱${amount.toLocaleString()} added to the ${b.quarter} medical assistance fund pool.`);
    input.value = '';
    renderBudgetBox('queueBudgetBox');
    renderQueue();
    }

    /* ---------------------------------------------------------
    ASSISTANCE REQUESTS — PIPELINE (Pending -> Completed)
    --------------------------------------------------------- */

    async function loadMedicalRequestsFromSupabase(){
        const { data, error } = await supabase
            .from('medical_assistance_requests')
            .select('*')
            .order('created_at', { ascending: false });

        if(error){ console.error('Hindi makuha ang medical assistance requests:', error.message); return; }
        medicalRequestsCache = data || [];
        renderRequests();
        renderQueue();
        renderRequestHistory();
    }

   function subscribeMedicalRequestsRealtime(){
        supabase
            .channel('medical-assistance-requests-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'medical_assistance_requests' }, (payload) => {
                if(payload.eventType === 'INSERT') markTabUpdated('queue', payload.new.id);   // BAGO
                loadMedicalRequestsFromSupabase();
            })
            .subscribe();
    }

    const STATUS_STEPS = ['Pending','Under Review','Queued','Approved','Disbursed'];

   function renderRequests(){
    const list = medicalRequestsCache;
    const wrap = document.getElementById('assistanceRequestsList');
    const empty = document.getElementById('assistanceEmpty');
    const badge = document.getElementById('assistanceCountBadge');
    if(!wrap) return;

  const openOnes = sortUnseenFirst(list.filter(r => r.status !== 'Disbursed' && r.status !== 'Rejected'), 'queue');   // BAGO
    badge && (badge.textContent = openOnes.length + ' Pending');
    empty && (empty.style.display = openOnes.length ? 'none' : 'block');

    wrap.innerHTML = openOnes.map(r => `
        <div class="request-card ${String(r.id) === String(selectedRequestId) ? 'selected':''}" onclick="selectRequest('${r.id}')">
        <div class="request-card-top">
            <span class="request-card-name">${r.resident_name}</span>
            <span class="status-pill ${statusClass(r.status)}"><span class="status-dot"></span>${r.status}</span>
        </div>
        <div class="request-card-detail">${r.category} · ₱${Number(r.estimated_cost || 0).toLocaleString()}</div>
        <div class="request-card-meta">
            <span class="badge">${r.priority}</span>
            <span class="timestamp">${timeAgo(r.created_at)}</span>
        </div>
        </div>
    `).join('');
    }

    let selectedRequestId = null;

   async function selectRequest(id){
    selectedRequestId = id;
    markSeen('queue', id);   // BAGO
    const r = medicalRequestsCache.find(x => String(x.id) === String(id));
    if(!r) return;

    document.getElementById('selectedRequestId').value = r.id;
    document.getElementById('evalResidentName').value = r.resident_name + (r.contact_number ? ' · ' + r.contact_number : '');
    document.getElementById('evalPurpose').value = r.purpose || '';
    document.getElementById('evalCategory').value = r.category;
    document.getElementById('evalPriority').value = r.priority;
    if(document.getElementById('evalCost')) document.getElementById('evalCost').value = r.estimated_cost || 0;
    document.getElementById('evalNotes').value = r.admin_notes || '';

    await renderDocAttachments(r);

    renderStepper(r);
    renderRequests();

    document.getElementById('evalDocAttachments').scrollIntoView({ behavior:'smooth', block:'nearest' });
    }

    async function renderDocAttachments(r){
    const wrap = document.getElementById('evalDocAttachments');
    const docs = Array.isArray(r.documents) ? r.documents : [];
    if(docs.length === 0){
        wrap.innerHTML = 'No documents attached.';
        return;
    }

    wrap.innerHTML = docs.map((d, i) => `📎 <a href="#" id="doc-link-${i}" style="color:#00b0ff; text-decoration:underline;">${d}</a>`).join('<br>');

    for(let i = 0; i < docs.length; i++){
        const path = docs[i];
        const linkEl = document.getElementById(`doc-link-${i}`);
        if(!linkEl) continue;

        const { data, error } = await supabase.storage
            .from('medical-documents')
            .createSignedUrl(path, 300); // 5 minutes validity

        if(error || !data?.signedUrl){
            linkEl.style.color = '#888';
            linkEl.style.textDecoration = 'none';
            linkEl.title = 'Hindi ma-load ang file.';
            linkEl.onclick = (e) => e.preventDefault();
            continue;
        }

        linkEl.href = data.signedUrl;
        linkEl.target = '_blank';
        linkEl.rel = 'noopener noreferrer';
    }
}

    function renderStepper(r){
    const wrap = document.getElementById('statusStepper');
    if(!wrap) return;
    if(r.status === 'Rejected'){
        wrap.innerHTML = `<div class="status-stepper">
        <div class="step done"><div class="dot">✓</div><div class="lbl">Pending</div></div>
        <div class="step done"><div class="dot">✓</div><div class="lbl">Reviewed</div></div>
        <div class="step rejected"><div class="dot">✕</div><div class="lbl">Rejected</div></div>
        </div>`;
        return;
    }
    const idx = STATUS_STEPS.indexOf(r.status);
    wrap.innerHTML = `<div class="status-stepper">
        ${STATUS_STEPS.map((s,i) => `
        <div class="step ${i < idx ? 'done' : i === idx ? 'current' : ''}">
            <div class="dot">${i < idx ? '✓' : i+1}</div>
            <div class="lbl">${s}</div>
        </div>
        `).join('')}
    </div>`;
    }

    /* Priority score: urgency + eligibility + budget fit — used both for
    manual triage and for auto-sorting the financial assistance queue */
   function computePriorityScore(r){
    const urgencyWeight = { Critical: 50, Urgent: 30, Routine: 10 }[r.priority] || 10;
    const budgetFit = Number(r.estimated_cost || 0) <= remainingBudget() ? 20 : 0;
    const waitingBonus = Math.min(10, Math.floor((Date.now() - new Date(r.created_at).getTime()) / (1000*60*60*24)));
    return urgencyWeight + budgetFit + waitingBonus;
    }

    function pushHistory(r, status, note){
    const history = Array.isArray(r.history) ? r.history : [];
    history.push({ status, at: nowISO(), note: note || '' });
    return history;
    }

    async function handleAssistanceEvaluation(e){
    e.preventDefault();
    const action = e.submitter ? e.submitter.value : 'Approve';
    console.log('handleAssistanceEvaluation called, action:', action);
    const id = document.getElementById('selectedRequestId').value;
    const r = medicalRequestsCache.find(x => String(x.id) === String(id));
    if(!r){ alert('Select a request from the list first.'); return; }

    const category = document.getElementById('evalCategory').value;
    const priority = document.getElementById('evalPriority').value;
    const notes = document.getElementById('evalNotes').value;
    const costInput = document.getElementById('evalCost');
    const cost = Number(costInput?.value || r.estimated_cost || 0);

    if(action === 'Reject'){
        const history = pushHistory(r, 'Rejected', notes || 'Request did not meet approval criteria.');
        const { error } = await supabase.from('medical_assistance_requests')
            .update({ status: 'Rejected', category, priority, admin_notes: notes, history })
            .eq('id', r.id);
        if(error){ alert('Hindi na-update: ' + error.message); return; }

        logActivity('request', `Request from <b>${r.resident_name}</b> was rejected.`);
        await notifyResident(r, `Hi ${r.resident_name}, your request (${r.purpose}) was not approved. Reason: ${notes || 'Did not meet program criteria.'} Visit the barangay office for details.`);
        loadMedicalRequestsFromSupabase();
        return;
    }

    if(category === 'Financial Assistance'){
        if(cost > remainingBudget()){
        const history = pushHistory(r, 'Queued', 'Insufficient available funds — placed in priority queue.');
        const { error } = await supabase.from('medical_assistance_requests')
            .update({ status: 'Queued', category, priority, estimated_cost: cost, admin_notes: notes, history })
            .eq('id', r.id);
        if(error){ alert('Hindi na-update: ' + error.message); return; }

        logActivity('budget', `<b>${r.resident_name}</b>'s request (₱${cost.toLocaleString()}) queued — remaining fund pool ₱${remainingBudget().toLocaleString()} is insufficient.`);
        await notifyResident(r, `Hi ${r.resident_name}, your financial assistance request is approved for processing but has been placed in queue while barangay funds are replenished. We'll notify you once funds are available.${notes ? ' Note: ' + notes : ''}`);
        }else{
        const b = getBudget();
        b.allocated += cost;
        save(DB.budget, b);
        const history = pushHistory(r, 'Disbursed', 'Approved and funds disbursed.');
        const { error } = await supabase.from('medical_assistance_requests')
            .update({ status: 'Disbursed', category, priority, estimated_cost: cost, admin_notes: notes, history })
            .eq('id', r.id);
        if(error){ alert('Hindi na-update: ' + error.message); return; }

        logActivity('budget', `₱${cost.toLocaleString()} disbursed to <b>${r.resident_name}</b>. Remaining fund pool: ₱${remainingBudget().toLocaleString()}.`);
        await notifyResident(r, `Hi ${r.resident_name}, your financial assistance request has been approved and funds (₱${cost.toLocaleString()}) are ready for release at the barangay office.${notes ? ' Note: ' + notes : ''}`);
        }
    }else{
        const history = pushHistory(r, 'Approved', notes || 'Approved for processing.');
        const { error } = await supabase.from('medical_assistance_requests')
            .update({ status: 'Approved', category, priority, estimated_cost: cost, admin_notes: notes, history })
            .eq('id', r.id);
        if(error){ alert('Hindi na-update: ' + error.message); return; }

        logActivity('request', `Request from <b>${r.resident_name}</b> approved (${category}).`);
        await notifyResident(r, `Hi ${r.resident_name}, your request (${r.purpose}) has been approved. Please proceed to the barangay health desk.${notes ? ' Note: ' + notes : ''}`);
    }

    loadMedicalRequestsFromSupabase();
    }

    /* ---------------------------------------------------------
    FINANCIAL ASSISTANCE QUEUE (priority + eligibility + budget)
    --------------------------------------------------------- */
    function renderQueue(){
    renderBudgetBox('queueBudgetBox');
    const wrap = document.getElementById('queueList');
    if(!wrap) return;
    const queued = medicalRequestsCache
        .filter(r => r.status === 'Queued')
        .map(r => ({ ...r, priorityScore: computePriorityScore(r) }))
        .sort((a,b) => b.priorityScore - a.priorityScore);

    const badge = document.getElementById('queueCountBadge');
    badge && (badge.textContent = queued.length + ' Queued');

    if(queued.length === 0){
        wrap.innerHTML = '<div class="empty-state">No requests currently queued — all eligible claims are within budget.</div>';
        return;
    }

    wrap.innerHTML = queued.map((r, idx) => `
        <div class="queue-card">
        <div class="qc-top">
            <div><span class="queue-rank">${idx+1}</span><b>${r.resident_name}</b></div>
            <span class="badge">${r.priority}</span>
        </div>
        <div class="request-card-detail" style="margin-top:6px;">${r.purpose || ''}</div>
        <div class="queue-score">Priority score: <b>${r.priorityScore}</b> · Cost: ₱${Number(r.estimated_cost||0).toLocaleString()} · Waiting ${timeAgo(r.created_at)}</div>
        <div class="queue-actions">
            <button class="primary-btn" style="background:var(--green); color:#111;"
            ${r.estimated_cost > remainingBudget() ? 'disabled' : ''}
            onclick="disburseQueued('${r.id}')">
            ${r.estimated_cost > remainingBudget() ? 'Insufficient Funds' : '✓ Disburse Now'}
            </button>
            <button class="primary-btn" style="background:#333; color:#eee;" onclick="selectRequestFromQueue('${r.id}')">Review</button>
        </div>
        </div>
    `).join('');
    }

    const TERMINAL_REQUEST_STATUSES = ['Disbursed','Approved','Rejected'];

    function renderRequestHistory(){
    const wrap = document.getElementById('requestHistoryList');
    if(!wrap) return;
    const completed = medicalRequestsCache
        .filter(r => TERMINAL_REQUEST_STATUSES.includes(r.status))
        .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

    const badge = document.getElementById('requestHistoryCountBadge');
    badge && (badge.textContent = completed.length + ' Records');

    if(completed.length === 0){
        wrap.innerHTML = '<div class="empty-state" style="padding:12px;">No completed assistance cases yet.</div>';
        return;
    }
    wrap.innerHTML = completed.slice(0,5).map(r => `
        <div class="fleet-quick-row" onclick="viewRequestHistoryDetail('${r.id}')" style="cursor:pointer;">
        <div>
            <div class="fleet-quick-name">${r.resident_name}</div>
            <div class="fleet-quick-type">${r.category} · ${timeAgo(r.created_at)}</div>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
            <span class="status-pill ${statusClass(r.status)}">${r.status}</span>
            <button class="primary-btn" style="background:#333;color:#eee;font-size:.68em;padding:4px 8px;" onclick="event.stopPropagation(); printRequestRecord('${r.id}')">🖨️</button>
        </div>
        </div>
    `).join('');
    }

    function viewRequestHistoryDetail(id){
        const r = medicalRequestsCache.find(x => String(x.id) === String(id));
        if(!r){ alert('Record not found.'); return; }

        showRecordDetailModal(`💰 ${r.resident_name}`, [
            ['Contact', r.contact_number || 'N/A'],
            ['Category', r.category],
            ['Priority', r.priority],
            ['Purpose', r.purpose || 'N/A'],
            ['Estimated Cost', `₱${Number(r.estimated_cost||0).toLocaleString()}`],
            ['Final Status', r.status],
            ['Admin Notes', r.admin_notes || 'N/A'],
            ['Date Submitted', fmtTime(r.created_at)],
        ], () => printRequestRecord(id));
    }

    function printRequestRecord(id){
    const r = medicalRequestsCache.find(x => String(x.id) === String(id));
    if(!r){ alert('Record not found.'); return; }

    const printWindow = window.open('', '_blank', 'width=800,height=900');
    printWindow.document.write(`
        <html>
        <head>
            <title>Assistance Record - ${r.resident_name}</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 30px; color: #111; }
                h1 { font-size: 18px; border-bottom: 2px solid #333; padding-bottom: 8px; }
                table { width: 100%; border-collapse: collapse; margin-top: 16px; }
                td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; font-size: 13px; }
                th { width: 180px; color: #555; }
                .footer { margin-top: 40px; font-size: 11px; color: #777; }
            </style>
        </head>
        <body>
            <h1>e-Medicare — Barangay Bambang Assistance Record</h1>
            <table>
                <tr><th>Resident</th><td>${r.resident_name}</td></tr>
                <tr><th>Contact</th><td>${r.contact_number || 'N/A'}</td></tr>
                <tr><th>Category</th><td>${r.category}</td></tr>
                <tr><th>Priority</th><td>${r.priority}</td></tr>
                <tr><th>Purpose</th><td>${r.purpose || 'N/A'}</td></tr>
                <tr><th>Estimated Cost</th><td>₱${Number(r.estimated_cost||0).toLocaleString()}</td></tr>
                <tr><th>Final Status</th><td>${r.status}</td></tr>
                <tr><th>Admin Notes</th><td>${r.admin_notes || 'N/A'}</td></tr>
                <tr><th>Date Submitted</th><td>${fmtTime(r.created_at)}</td></tr>
            </table>
            <div class="footer">Generated ${fmtTime(nowISO())} · e-Medicare Barangay Bambang Control Center</div>
        </body>
        </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 300);
    }

    async function disburseQueued(id){
    const r = medicalRequestsCache.find(x => String(x.id) === String(id));
    if(!r) return;
    if(r.estimated_cost > remainingBudget()){ alert('Fund pool balance is insufficient for this request.'); return; }

    const b = getBudget();
    b.allocated += r.estimated_cost;
    save(DB.budget, b);

    const history = pushHistory(r, 'Disbursed', 'Released from priority queue once funds became available.');
    const { error } = await supabase.from('medical_assistance_requests')
        .update({ status: 'Disbursed', history })
        .eq('id', r.id);
    if(error){ alert('Hindi na-update: ' + error.message); return; }

    logActivity('budget', `Queued request for <b>${r.resident_name}</b> disbursed (₱${Number(r.estimated_cost).toLocaleString()}). Remaining: ₱${remainingBudget().toLocaleString()}.`);
    await notifyResident(r, `Hi ${r.resident_name}, good news — funds are now available. Your ₱${Number(r.estimated_cost).toLocaleString()} assistance is ready for release at the barangay office.`);
    loadMedicalRequestsFromSupabase();
    }

    function selectRequestFromQueue(id){
    switchTab('docs');
    selectRequest(id);
    }

    async function loadTranspoFromSupabase(){
    const { data, error } = await supabase
        .from('transport_requests')
        .select('*')
        .order('created_at', { ascending: false });

    if(error){ console.error('Hindi makuha ang transpo requests:', error.message); return; }
   transpoCache = data || [];
    renderTranspoList();
    renderTranspoHistory();
    renderReservationCalendar();   // BAGO
}

/* BAGO — real-time conflict check habang pumipili ng vehicle/driver sa
   Transpo Assignment Terminal. Kinokompara sa schedule_time ng kasalukuyang
   napiling request laban sa ibang Approved bookings sa parehong araw. */
function checkTranspoConflict(){
    const r = transpoCache.find(x => String(x.id) === String(selectedTranspoId));
    const warnEl = document.getElementById('transpoConflictWarning');
    if(!r || !r.schedule_time || !warnEl) return;

    const dateKey = new Date(r.schedule_time).toDateString();
    const vehicleId = document.getElementById('transpoVehicleSelect').value;
    const driverId = document.getElementById('transpoDriverSelect').value;

    const conflicts = transpoCache.filter(x =>
        x.status === 'Approved' &&
        String(x.id) !== String(r.id) &&
        x.schedule_time &&
        new Date(x.schedule_time).toDateString() === dateKey &&
        ((vehicleId && String(x.assigned_vehicle) === String(vehicleId)) ||
         (driverId && String(x.assigned_driver) === String(driverId)))
    );

    if(conflicts.length > 0){
        const names = conflicts.map(c => c.patient_name).join(', ');
        warnEl.textContent = `⚠️ May kasabay na booking na ang piniling unit/driver sa araw na ito (${names}). I-double check muna bago i-approve.`;
        warnEl.style.display = 'block';
    }else{
        warnEl.style.display = 'none';
    }
}

function subscribeTranspoRealtime(){
    supabase
        .channel('transport-requests-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'transport_requests' }, (payload) => {
            if(payload.eventType === 'INSERT') markTabUpdated('docs', payload.new.id);   // BAGO
            loadTranspoFromSupabase();
        })
        .subscribe();
}

let selectedTranspoId = null;

function renderTranspoList(){
    const wrap = document.getElementById('transpoRequestsList');
    const empty = document.getElementById('transpoEmpty');
    const badge = document.getElementById('transpoCountBadge');
    if(!wrap) return;

    // BAGO — Pending lang ang dapat makita dito. Kapag na-approve/
    // na-reject na, dapat mawala na sya dito at lumipat sa "Completed
    // Transport Records" (renderTranspoHistory), na binabasa na ang
    // Approved/Completed/Rejected statuses.
   const pending = sortUnseenFirst(transpoCache.filter(r => r.status === 'Pending'), 'docs');   // BAGO
    badge && (badge.textContent = pending.length + ' Pending');
    empty && (empty.style.display = pending.length ? 'none' : 'block');

    if(pending.length === 0){
        wrap.innerHTML = '';
        return;
    }

    wrap.innerHTML = pending.map(r => {
        const driver = r.assigned_driver ? fleetCache.find(f => String(f.id) === String(r.assigned_driver)) : null;
        return `
        <div class="request-card ${String(r.id) === String(selectedTranspoId) ? 'selected':''}" onclick="selectTranspoRequest('${r.id}')">
        <div class="request-card-top">
            <span class="request-card-name">${r.patient_name}</span>
            <span class="status-pill ${statusClass(r.status)}"><span class="status-dot"></span>${r.status}</span>
        </div>
        <div class="request-card-detail">${r.pickup_location} → ${r.destination}</div>
        ${driver ? `<div class="request-card-detail" style="color:#00b0ff;">🧑‍✈️ Driver: ${driver.name}</div>` : ''}
        <div class="request-card-meta">
            <span class="badge">${r.transport_type || ''}</span>
            <span class="timestamp">${timeAgo(r.created_at)}</span>
        </div>
        </div>
    `;}).join('');
}

function populateTranspoVehicleSelect(){
    const sel = document.getElementById('transpoVehicleSelect');
    if(!sel) return;
    const available = fleetCache.filter(f => f.status === 'Available');
    sel.innerHTML = '<option value="" disabled selected>Select available vehicle</option>' +
        available.map(f => `<option value="${f.id}">${f.name} (${f.type})</option>`).join('');
}

function populateTranspoDriverSelect(){
    const sel = document.getElementById('transpoDriverSelect');
    if(!sel) return;
    const availableDrivers = fleetCache.filter(f => f.type === 'Driver' && f.status === 'Available');
    sel.innerHTML = '<option value="">— None —</option>' +
        availableDrivers.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
}

function transpoStepperHTML(r){
    if(r.status === 'Rejected'){
        return `<div class="status-stepper">
            <div class="step done"><div class="dot">✓</div><div class="lbl">Pending</div></div>
            <div class="step rejected"><div class="dot">✕</div><div class="lbl">Rejected</div></div>
        </div>`;
    }
    const steps = ['Pending','Approved','Completed'];
    const idx = steps.indexOf(r.status === 'Approved' ? 'Approved' : (r.status === 'Completed' ? 'Completed' : 'Pending'));
    return `<div class="status-stepper">
        ${steps.map((s,i) => `
        <div class="step ${i < idx ? 'done' : i === idx ? 'current' : ''}">
            <div class="dot">${i < idx ? '✓' : i+1}</div>
            <div class="lbl">${s}</div>
        </div>`).join('')}
    </div>`;
}

function selectTranspoRequest(id){
    selectedTranspoId = id;
    markSeen('docs', id);   // BAGO
    const r = transpoCache.find(x => String(x.id) === String(id));
    if(!r) return;

    document.getElementById('selectedTranspoId').value = r.id;
    document.getElementById('transpoResidentName').value = r.patient_name;
    document.getElementById('transpoPickup').value = r.pickup_location;
    document.getElementById('transpoDestination').value = r.destination;
    document.getElementById('transpoSchedule').value = r.schedule_time ? new Date(r.schedule_time).toLocaleString('en-PH') : '';
    document.getElementById('transpoType').value = r.transport_type || '';
    document.getElementById('transpoNotes').value = r.admin_notes || '';
    document.getElementById('transpoStepper').innerHTML = transpoStepperHTML(r);

    populateTranspoVehicleSelect();
    populateTranspoDriverSelect();               // BAGO
    if(r.assigned_vehicle) document.getElementById('transpoVehicleSelect').value = r.assigned_vehicle;
    if(r.assigned_driver) document.getElementById('transpoDriverSelect').value = r.assigned_driver;   // BAGO

   renderTranspoList();
    checkTranspoConflict();   // BAGO
}

async function handleTranspoEvaluation(e){
    e.preventDefault();
    const action = e.submitter ? e.submitter.value : 'Approve';
    const id = document.getElementById('selectedTranspoId').value;
    const r = transpoCache.find(x => String(x.id) === String(id));
    if(!r){ alert('Select a transpo request from the list first.'); return; }

   const notes = document.getElementById('transpoNotes').value;

    if(action === 'Reject'){
        const { error: rejError } = await supabase
            .from('transport_requests')
            .update({ status: 'Rejected', admin_notes: notes })
            .eq('id', r.id);
        if(rejError){ alert('Hindi na-update: ' + rejError.message); return; }

        logActivity('request', `Transpo request ni <b>${r.patient_name}</b> na-reject.`);

        if(r.sender_id){
            await supabase.from('notifications').insert({
                receiver_id: r.sender_id,
                title: 'Transpo Request Rejected',
                message: `Hi ${r.patient_name}, hindi na-approve ang iyong transport request (${r.pickup_location} → ${r.destination}).${notes ? ' Dahilan: ' + notes : ''}`
            });
        }

        document.getElementById('transpoNotes').value = '';
        loadTranspoFromSupabase();
        return;
    }

    const vehicleId = document.getElementById('transpoVehicleSelect').value;
    const driverId = document.getElementById('transpoDriverSelect').value;   // BAGO
    const vehicle = fleetCache.find(f => String(f.id) === String(vehicleId));
    const driver = driverId ? fleetCache.find(f => String(f.id) === String(driverId)) : null;   // BAGO
    if(!vehicle){ alert('Pumili ng vehicle para sa dispatch.'); return; }

    const crewTag = `Transpo, ${r.patient_name}` + (driver ? ` (Driver: ${driver.name})` : '');   // BAGO
    const vehicleTag = `Transpo, ${r.patient_name}` + (driver ? ` (Driver: ${driver.name})` : '');

    const { error: reqError } = await supabase
        .from('transport_requests')
        .update({ status: 'Approved', assigned_vehicle: vehicle.id, assigned_driver: driver ? driver.id : null, admin_notes: notes })   // BAGO
        .eq('id', r.id);
    if(reqError){ alert('Hindi na-update ang request: ' + reqError.message); return; }

    const { error: fleetError } = await supabase
        .from('fleet')
        .update({ status: 'On Duty', assigned_to: vehicleTag })
        .eq('id', vehicle.id)
        .select();
    if(fleetError){ alert('Hindi na-dispatch ang vehicle: ' + fleetError.message); return; }

    // BAGO — i-update din ang status ng driver kung meron
    if(driver){
        const driverTag = `Transpo, ${r.patient_name} (Vehicle: ${vehicle.name})`;
        const { error: driverError } = await supabase
            .from('fleet')
            .update({ status: 'On Duty', assigned_to: driverTag })
            .eq('id', driver.id)
            .select();
        if(driverError){ alert('Hindi na-dispatch ang driver: ' + driverError.message); return; }
    }

    logActivity('dispatch', `<b>${vehicle.name}</b>${driver ? ' (Driver: ' + driver.name + ')' : ''} assigned to transpo request of ${r.patient_name} (${r.pickup_location} → ${r.destination}).`);

    if(r.sender_id){
        await supabase.from('notifications').insert({
            receiver_id: r.sender_id,
            title: 'Transpo Request Approved',
            message: `Hi ${r.patient_name}, na-approve na ang iyong transport request. Isasadispatch si ${vehicle.name}${driver ? ' at driver ' + driver.name : ''}.${notes ? ' Note: ' + notes : ''}`
        });
    }

    loadTranspoFromSupabase();
    loadFleetFromSupabase();
}

    const TERMINAL_TRANSPO_STATUSES = ['Approved','Completed','Rejected'];

    function renderTranspoHistory(){
    const wrap = document.getElementById('transpoHistoryList');
    if(!wrap) return;
    const completed = transpoCache
        .filter(r => TERMINAL_TRANSPO_STATUSES.includes(r.status))
        .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

    const badge = document.getElementById('transpoHistoryCountBadge');
    badge && (badge.textContent = completed.length + ' Records');

    if(completed.length === 0){
        wrap.innerHTML = '<div class="empty-state" style="padding:12px;">No completed transport records yet.</div>';
        return;
    }
    wrap.innerHTML = completed.slice(0,5).map(r => {
        const driver = r.assigned_driver ? fleetCache.find(f => String(f.id) === String(r.assigned_driver)) : null;
        return `
        <div class="fleet-quick-row" onclick="viewTranspoHistoryDetail('${r.id}')" style="cursor:pointer;">
        <div>
            <div class="fleet-quick-name">${r.patient_name}</div>
            <div class="fleet-quick-type">${r.pickup_location} → ${r.destination} · ${timeAgo(r.created_at)}</div>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
            <span class="status-pill ${statusClass(r.status)}">${r.status}</span>
            <button class="primary-btn" style="background:#333;color:#eee;font-size:.68em;padding:4px 8px;" onclick="event.stopPropagation(); printTranspoRecord('${r.id}')">🖨️</button>
        </div>
        </div>
    `;}).join('');
    }

    function viewTranspoHistoryDetail(id){
        const r = transpoCache.find(x => String(x.id) === String(id));
        if(!r){ alert('Record not found.'); return; }
        const driver = r.assigned_driver ? fleetCache.find(f => String(f.id) === String(r.assigned_driver)) : null;
        const vehicle = r.assigned_vehicle ? fleetCache.find(f => String(f.id) === String(r.assigned_vehicle)) : null;

        showRecordDetailModal(`🚐 ${r.patient_name}`, [
            ['Pickup', r.pickup_location],
            ['Destination', r.destination],
            ['Schedule', r.schedule_time ? new Date(r.schedule_time).toLocaleString('en-PH') : 'N/A'],
            ['Vehicle', vehicle ? vehicle.name : 'N/A'],
            ['Driver', driver ? driver.name : 'N/A'],
            ['Status', r.status],
            ['Admin Notes', r.admin_notes || 'N/A'],
            ['Date Submitted', fmtTime(r.created_at)],
        ], () => printTranspoRecord(id));
    }

    /* BAGO — Reservation Calendar: ipinapakita lahat ng approved/scheduled
   transport bookings, naka-group per araw. Kapag ang parehong vehicle
   o driver ay may 2+ bookings sa parehong araw, hini-highlight bilang
   conflict (pula) para agad mapansin ng admin. */
function renderReservationCalendar(){
    const wrap = document.getElementById('transpoReservationCalendar');
    if(!wrap) return;

    const booked = transpoCache.filter(r => r.status === 'Approved' && r.schedule_time);
    if(booked.length === 0){
        wrap.innerHTML = '<div class="empty-state" style="padding:12px;">Walang upcoming reservations.</div>';
        return;
    }

    const groups = {};
    booked.forEach(r => {
        const dateKey = new Date(r.schedule_time).toLocaleDateString('en-PH', { weekday:'short', year:'numeric', month:'short', day:'numeric' });
        if(!groups[dateKey]) groups[dateKey] = [];
        groups[dateKey].push(r);
    });

    const sortedKeys = Object.keys(groups).sort((a,b) => new Date(groups[a][0].schedule_time) - new Date(groups[b][0].schedule_time));

    wrap.innerHTML = sortedKeys.map(dateKey => {
        const entries = groups[dateKey].sort((a,b) => new Date(a.schedule_time) - new Date(b.schedule_time));

        const vehicleCounts = {}, driverCounts = {};
        entries.forEach(r => {
            if(r.assigned_vehicle) vehicleCounts[r.assigned_vehicle] = (vehicleCounts[r.assigned_vehicle]||0)+1;
            if(r.assigned_driver) driverCounts[r.assigned_driver] = (driverCounts[r.assigned_driver]||0)+1;
        });

        const rowsHtml = entries.map(r => {
            const vehicle = r.assigned_vehicle ? fleetCache.find(f => String(f.id) === String(r.assigned_vehicle)) : null;
            const driver = r.assigned_driver ? fleetCache.find(f => String(f.id) === String(r.assigned_driver)) : null;
            const isConflict = (r.assigned_vehicle && vehicleCounts[r.assigned_vehicle] > 1) || (r.assigned_driver && driverCounts[r.assigned_driver] > 1);
            const time = new Date(r.schedule_time).toLocaleTimeString('en-PH', { hour:'2-digit', minute:'2-digit' });

            return `
                <div class="reservation-chip ${isConflict ? 'conflict' : ''}">
                    <div><b>${time}</b> — ${r.patient_name}</div>
                    <div style="font-size:.85em; color:#aaa; margin-top:2px;">
                        ${vehicle ? '🚑 ' + vehicle.name : '— Walang vehicle —'}${driver ? ' · 🧑\u200d✈️ ' + driver.name : ''}
                    </div>
                    ${isConflict ? '<div style="font-size:.8em; color:var(--red); margin-top:3px;">⚠️ Conflict — may kasabay na booking ang unit/driver na ito sa araw na ito</div>' : ''}
                </div>
            `;
        }).join('');

        return `
            <div class="reservation-day-group">
                <div class="reservation-day-label">📅 ${dateKey}</div>
                ${rowsHtml}
            </div>
        `;
    }).join('');
}

    function printTranspoRecord(id){
    const r = transpoCache.find(x => String(x.id) === String(id));
    if(!r){ alert('Record not found.'); return; }
    const driver = r.assigned_driver ? fleetCache.find(f => String(f.id) === String(r.assigned_driver)) : null;
    const vehicle = r.assigned_vehicle ? fleetCache.find(f => String(f.id) === String(r.assigned_vehicle)) : null;

    const printWindow = window.open('', '_blank', 'width=800,height=900');
    printWindow.document.write(`
        <html>
        <head>
            <title>Transport Record - ${r.patient_name}</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 30px; color: #111; }
                h1 { font-size: 18px; border-bottom: 2px solid #333; padding-bottom: 8px; }
                table { width: 100%; border-collapse: collapse; margin-top: 16px; }
                td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; font-size: 13px; }
                th { width: 180px; color: #555; }
                .footer { margin-top: 40px; font-size: 11px; color: #777; }
            </style>
        </head>
        <body>
            <h1>e-Medicare — Barangay Bambang Transport Record</h1>
            <table>
                <tr><th>Patient / Resident</th><td>${r.patient_name}</td></tr>
                <tr><th>Pickup</th><td>${r.pickup_location}</td></tr>
                <tr><th>Destination</th><td>${r.destination}</td></tr>
                <tr><th>Schedule</th><td>${r.schedule_time ? new Date(r.schedule_time).toLocaleString('en-PH') : 'N/A'}</td></tr>
                <tr><th>Vehicle</th><td>${vehicle ? vehicle.name : 'N/A'}</td></tr>
                <tr><th>Driver</th><td>${driver ? driver.name : 'N/A'}</td></tr>
                <tr><th>Status</th><td>${r.status}</td></tr>
                <tr><th>Admin Notes</th><td>${r.admin_notes || 'N/A'}</td></tr>
                <tr><th>Date Submitted</th><td>${fmtTime(r.created_at)}</td></tr>
            </table>
            <div class="footer">Generated ${fmtTime(nowISO())} · e-Medicare Barangay Bambang Control Center</div>
        </body>
        </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 300);
    }
    /* ---------------------------------------------------------
    USER ACCOUNTS (kept from original, wired to storage)
    --------------------------------------------------------- */
   let usersCache = [];

async function loadUsersFromSupabase(){
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, role, position, contact, active, created_at, id_verified, id_image_url, face_image_url, license_image_url')
    .order('created_at', { ascending: false });
  if(error){ console.error('Hindi makuha ang users:', error.message); return; }
  usersCache = data;
  renderUsers();
}

function renderUsers(){
  const tbody = document.getElementById('usersList');
  if(!tbody) return;
  const sortedUsers = sortUnseenFirst(usersCache, 'users');   // BAGO
  tbody.innerHTML = sortedUsers.map(u => `
    <tr>
      <td>
        <div style="font-weight:600;">${u.name}</div>
        <div class="timestamp">${u.contact || 'No contact on file'} · joined ${timeAgo(u.created_at)}</div>
      </td>
      <td>${u.role === 'responder' && u.position ? u.position : u.role}${u.id_verified ? ' <span class="status-pill status-Available" style="margin-left:4px;">ID Verified</span>' : ''}</td>
      <td>${u.active !== false ? '<span class="status-pill status-Available">Active</span>' : '<span class="status-pill status-Unavailable">Inactive</span>'}</td>
      <td>
        <button class="primary-btn" style="background:${u.active !== false ? '#3a2a10' : '#123a1c'};color:${u.active !== false ? '#ffcc66' : '#8aff9c'};font-size:.72em;padding:6px 10px;" onclick="toggleUserActive('${u.id}')">${u.active !== false ? 'Deactivate' : 'Activate'}</button>
        <button class="primary-btn" style="background:#333;color:#eee;font-size:.72em;padding:6px 10px;" onclick="openSecurityModal('${u.id}')">Force Password Reset</button>
        ${u.id_image_url ? `<button class="primary-btn" style="background:#123a4a;color:#66d9ff;font-size:.72em;padding:6px 10px;" onclick="openIdVerificationModal('${u.id}')">🪪 Review ID</button>` : ''}
      </td>
    </tr>
  `).join('');
}

   function fileToBase64(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------------------------------------------------------
   BAGO — toggle Driver's License upload field depending on
   the selected Position (Responder vs Driver)
   --------------------------------------------------------- */
function toggleLicenseField(){
  const position = document.getElementById('userPosition').value;
  const wrap = document.getElementById('licenseFieldWrap');
  const licenseInput = document.getElementById('userLicenseImage');
  if(position === 'Driver'){
    wrap.style.display = 'block';
  } else {
    wrap.style.display = 'none';
    if(licenseInput) licenseInput.value = ''; // i-clear kung nag-switch pabalik sa Responder
  }
}

async function handleUserFormSubmit(e){
  e.preventDefault();

  const submitBtn = document.getElementById('userFormSubmitBtn');
  const name = document.getElementById('userFullName').value.trim();
  const position = document.getElementById('userPosition').value; // BAGO — 'Responder' o 'Driver'
  const email = document.getElementById('userEmail').value.trim().toLowerCase();
  const password = document.getElementById('userPassword').value;
  const contact = document.getElementById('userContact').value.trim();
  const idFile = document.getElementById('userIdImage').files[0];
  const licenseFile = document.getElementById('userLicenseImage')?.files[0]; // BAGO

  if(!name || !email || !password || !contact){
    alert('Punan lahat ng required fields.');
    return;
  }

  if(!idFile){
    if(!confirm('Wala kang inupload na Barangay ID. Sigurado ka bang ituloy nang walang ID verification?')){
      return;
    }
  }

  // BAGO — mandatory ang Driver's License kapag Driver ang position
  if(position === 'Driver' && !licenseFile){
    alert("Kailangan mag-upload ng Driver's License para sa Driver position.");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating account…';

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if(!session){ alert('Session expired. Mag-login ulit.'); return; }

    let idImageBase64 = null;
    if(idFile) idImageBase64 = await fileToBase64(idFile);

    let licenseImageBase64 = null; // BAGO
    if(licenseFile) licenseImageBase64 = await fileToBase64(licenseFile);

    const response = await fetch(
      'https://szxptfuwkmqwcipxpoym.supabase.co/functions/v1/create-responder',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
          name,
          role: position,            // BAGO — ipinapasa ang 'Driver' o 'Responder'
          barangay: 'Bambang',
          contact,
          idImageBase64,
          licenseImageBase64,        // BAGO — driver's license photo, kung meron
        }),
      }
    );

    const result = await response.json();

    if(!response.ok){
      alert('Hindi nagawa ang account: ' + (result.error || 'Unknown error'));
      return;
    }

   if(response.status === 207){
      alert('Warning: ' + result.warning + '\n' + result.error);
    } else {
      alert(`✅ ${position} account created: ${name}`);
      logActivity('user', `New ${position.toLowerCase()} account created: <b>${name}</b> (${email}).`);
    }

    // BAGO — auto-register sa Fleet roster para hindi na kailangang
    // i-double-register manually. Hinahanap yung bagong profile row
    // gamit ang name + contact (pinaka-bago sa created_at).
    const { data: newProfileRows } = await supabase
      .from('profiles')
      .select('id')
      .eq('name', name)
      .eq('contact', contact)
      .order('created_at', { ascending: false })
      .limit(1);

    const newProfileId = newProfileRows && newProfileRows[0] ? newProfileRows[0].id : null;

    if(newProfileId){
      const fleetType = position === 'Driver' ? 'Driver' : 'Medical Personnel';
      const { error: fleetInsertError } = await supabase.from('fleet').insert({
        name,
        type: fleetType,
        status: 'Available',
        profile_id: newProfileId
      });
      if(fleetInsertError){
        console.error('Hindi naidagdag sa fleet roster:', fleetInsertError.message);
      } else {
        logActivity('fleet', `<b>${name}</b> auto-registered sa fleet roster bilang ${fleetType}.`);
      }
    }

    clearUserForm();
    loadUsersFromSupabase();
    loadFleetFromSupabase();

  } catch (err) {
    console.error(err);
    alert('May naganap na error habang gumagawa ng account.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Responder Account';
  }
}

function clearUserForm(){
  document.getElementById('userForm').reset();
  document.getElementById('userId').value = '';
  const licenseWrap = document.getElementById('licenseFieldWrap'); // BAGO
  if(licenseWrap) licenseWrap.style.display = 'none';              // BAGO
}

let resetTargetId = null;
function openSecurityModal(id){
  resetTargetId = id;
  markSeen('users', id);   // BAGO
  const u = usersCache.find(x => x.id === id);
  if(!u) return;
  document.getElementById('resetTargetName').textContent = u.name;
  document.getElementById('resetTargetId').value = id;
  document.getElementById('securityModal').style.display = 'flex';
}
function closeSecurityModal(){ document.getElementById('securityModal').style.display = 'none'; }

/* ---------------------------------------------------------
   BAGO — ID VERIFICATION MODAL
   Nagpapakita ng barangay ID at face/selfie photo na
   isinumite ng resident/user, para ma-verify ng admin na
   tugma ang nakalagay na impormasyon bago i-mark verified.
   --------------------------------------------------------- */
let idVerifyTargetId = null;

function idPhotoBoxHTML(label, boxId){
  return `
    <div style="flex:1; min-width:200px;">
      <div style="font-size:0.75em; color:#999; margin-bottom:6px;">${label}</div>
      <div style="background:#1a1c20; border:1px solid #333; border-radius:8px; min-height:180px; display:flex; align-items:center; justify-content:center; overflow:hidden;">
        <img id="${boxId}-img" src="" style="display:none; max-width:100%; max-height:260px; object-fit:contain;">
        <div id="${boxId}-empty" style="font-size:0.78em; color:#666; padding:20px; text-align:center;">Loading…</div>
      </div>
    </div>
  `;
}

async function openIdVerificationModal(id){
  const u = usersCache.find(x => x.id === id);
  if(!u) return;
  idVerifyTargetId = id;
  markSeen('users', id);   // BAGO

  document.getElementById('idVerifyName').textContent = u.name;
  document.getElementById('idVerifyMeta').textContent =
    `${u.contact || 'No contact on file'} · ${u.role === 'responder' && u.position ? u.position : u.role}`;
  document.getElementById('idVerifyStatus').textContent = u.id_verified
    ? '✅ Currently marked as Verified'
    : '⏳ Not yet verified';

  // BAGO — ang mga photo slots ay depende sa klase ng account:
  //   resident  -> Face/Selfie Photo + Government ID
  //   Driver    -> Barangay ID + Driver's License
  //   Responder -> Barangay ID lang
  let slots = [];
  if(u.role === 'resident'){
    slots = [
      { label: 'Face / Selfie Photo', field: 'face_image_url', bucket: 'face-images', boxId: 'idVerifySlotFace' },
      { label: 'Government ID',       field: 'id_image_url',   bucket: 'id-images',   boxId: 'idVerifySlotId' },
    ];
  }else if(u.position === 'Driver'){
    slots = [
      { label: 'Barangay ID',       field: 'id_image_url',      bucket: 'id-images',      boxId: 'idVerifySlotId' },
      { label: "Driver's License",  field: 'license_image_url', bucket: 'license-images', boxId: 'idVerifySlotLicense' },
    ];
  }else{
    slots = [
      { label: 'Barangay ID', field: 'id_image_url', bucket: 'id-images', boxId: 'idVerifySlotId' },
    ];
  }

  const grid = document.getElementById('idVerifyPhotoGrid');
  grid.innerHTML = slots.map(s => idPhotoBoxHTML(s.label, s.boxId)).join('');

  document.getElementById('idVerificationModal').style.display = 'flex';

  // I-fetch ang signed URL para sa bawat applicable na photo
  for(const s of slots){
    const imgEl = document.getElementById(`${s.boxId}-img`);
    const emptyEl = document.getElementById(`${s.boxId}-empty`);
    const path = u[s.field];

    if(!path){
      emptyEl.textContent = 'No photo submitted.';
      continue;
    }

    const { data, error } = await supabase.storage.from(s.bucket).createSignedUrl(path, 300);
    if(!error && data?.signedUrl){
      imgEl.src = data.signedUrl;
      imgEl.style.display = 'block';
      emptyEl.style.display = 'none';
    }else{
      emptyEl.textContent = 'Hindi ma-load ang photo.';
    }
  }
}

function closeIdVerificationModal(){
  document.getElementById('idVerificationModal').style.display = 'none';
  idVerifyTargetId = null;
}

async function setIdVerified(verified){
  if(!idVerifyTargetId) return;
  const u = usersCache.find(x => x.id === idVerifyTargetId);
  if(!u) return;

  const { error } = await supabase.from('profiles').update({ id_verified: verified, id_rejected: false }).eq('id', idVerifyTargetId);
  if(error){ alert('Hindi na-update: ' + error.message); return; }

  logActivity('user', `ID for <b>${u.name}</b> marked as ${verified ? 'Verified ✅' : 'Not Verified'}.`);
  closeIdVerificationModal();
  loadUsersFromSupabase();
}

async function rejectIdVerification(){
  if(!idVerifyTargetId) return;
  const u = usersCache.find(x => x.id === idVerifyTargetId);
  if(!u) return;

  const reason = prompt('Bakit rineject? (hal. malabo ang picture, hindi magkatugma ang ID)') 
                 || 'Malabo o hindi malinaw ang isinumiteng ID/selfie.';

  const { error } = await supabase.from('profiles').update({
    id_verified: false,
    id_rejected: true,
    id_reject_reason: reason,
    id_image_url: null,
    face_image_url: null
  }).eq('id', idVerifyTargetId);

  if(error){ alert('Hindi na-update: ' + error.message); return; }

  logActivity('user', `ID ni <b>${u.name}</b> na-reject: ${reason}`);
  closeIdVerificationModal();
  loadUsersFromSupabase();
}

async function toggleUserActive(id){
  const u = usersCache.find(x => x.id === id);
  if(!u) return;
  markSeen('users', id);   // BAGO
  const wasActive = u.active !== false;
  const confirmMsg = wasActive
    ? `Deactivate ${u.name}'s account? Mawawalan sila ng access sa system.`
    : `Reactivate ${u.name}'s account?`;
  if(!confirm(confirmMsg)) return;

  const { error } = await supabase.from('profiles').update({ active: !wasActive }).eq('id', id);
  if(error){ alert('Hindi na-update: ' + error.message); return; }

  logActivity('user', `Account <b>${u.name}</b> ${!wasActive ? 'reactivated' : 'deactivated'}.`);
  loadUsersFromSupabase();
}

async function handleResetPassword(e){
  e.preventDefault();
  const { error } = await supabase.from('profiles').update({ force_password_reset: true }).eq('id', resetTargetId);
  if(error){ alert('Hindi na-flag: ' + error.message); return; }

  const u = usersCache.find(x => x.id === resetTargetId);
  logActivity('user', `Password reset flagged for <b>${u?.name || 'user'}</b> — sila mismo magse-set ng bagong password sa susunod na login.`);
  closeSecurityModal();
  loadUsersFromSupabase();
}

function subscribeProfilesRealtime(){
  supabase
    .channel('profiles-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => {
      if(payload.eventType === 'INSERT') markTabUpdated('users', payload.new.id);   // BAGO
      loadUsersFromSupabase();
    })
    .subscribe();
}

    /* ---------------------------------------------------------
    REAL-TIME REFRESH LOOP
    (keeps "last updated" / live indicator ticking without reload)
    --------------------------------------------------------- */
    setInterval(() => {
    const dashboardVisible = document.getElementById('dashboard-tab') && document.getElementById('dashboard-tab').style.display !== 'none';
    if(dashboardVisible) renderQuickFleetStatus();
    const fleetVisible = document.getElementById('fleet-tab') && document.getElementById('fleet-tab').style.display !== 'none';
    if(fleetVisible) renderQuickFleetStatus();
    }, 15000);

    /* ---------------------------------------------------------
    INIT
    --------------------------------------------------------- */
   document.addEventListener('DOMContentLoaded', async () => {
    const profile = await checkAdminSession();
    if (!profile) return;

   initRoleBadge(profile);
    requestNotifPermission();
    await loadFleetFromSupabase();
    subscribeFleetRealtime();
    await loadUsersFromSupabase();
    subscribeProfilesRealtime();
    await loadIncidentsFromSupabase();
    subscribeIncidentsRealtime();
    await loadServiceRecordsFromSupabase();
    subscribeServiceRecordsRealtime();
    await loadMedicalRequestsFromSupabase();
    subscribeMedicalRequestsRealtime();
    await loadTranspoFromSupabase();
    subscribeTranspoRealtime();
    switchTab('dashboard');
});