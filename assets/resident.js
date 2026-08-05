// ==========================================================================
// SUPABASE SETUP
// ==========================================================================
const SUPABASE_URL = "https://szxptfuwkmqwcipxpoym.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_9mabckJnVdJ_Z-9km2T7mQ_c9t_XKiR";

var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUserId = null;
let currentUserName = 'Resident';
let currentUserBarangay = 'Bambang'; // ginagamit para i-tag ang mga request
let currentUserContact = ''; // BAGO — ginagamit ng medical assistance request (contact_number)
let currentUserVerified = false; // BAGO — kailangan bago makapag-submit ng kahit anong request


// ==========================================================================
// NOTIFICATION BELL — nagpapakita ng mga update tungkol sa requests
// ==========================================================================
let notificationsCache = [];

async function loadNotifications(){
    if(!currentUserId) return;
    const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('receiver_id', currentUserId)
        .order('created_at', { ascending: false })
        .limit(50);

    if(error){ console.error('Hindi makuha ang notifications:', error.message); return; }
    notificationsCache = data || [];
    renderNotifications();
}

function notifTimeAgo(iso){
    const s = Math.floor((Date.now() - new Date(iso).getTime())/1000);
    if(s < 60) return 'ngayon lang';
    if(s < 3600) return Math.floor(s/60) + 'm ago';
    if(s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
}

function renderNotifications(){
    const list = document.getElementById('notifList');
    const badge = document.getElementById('notifBadge');
    if(!list) return;

    const unreadCount = notificationsCache.filter(n => !n.read).length;
    if(badge){
        if(unreadCount > 0){
            badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }

    if(notificationsCache.length === 0){
        list.innerHTML = '<div class="notif-empty">Wala ka pang notifications.</div>';
        return;
    }

    list.innerHTML = notificationsCache.map(n => `
        <div class="notif-item ${n.read ? '' : 'unread'}" onclick="markNotifRead('${n.id}')">
            <div style="font-weight:600;">${n.title || 'Update'}</div>
            <div>${n.message}</div>
            <span class="notif-time">${notifTimeAgo(n.created_at)}</span>
        </div>
    `).join('');
}

function toggleNotifMenu(e){
    e.stopPropagation();
    const menu = document.getElementById('notifDropdown');
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}

document.addEventListener('click', () => {
    const menu = document.getElementById('notifDropdown');
    if (menu) menu.style.display = 'none';
});

async function markNotifRead(id){
    const n = notificationsCache.find(x => String(x.id) === String(id));
    if(!n || n.read) return;

    const { error } = await supabase.from('notifications').update({ read: true }).eq('id', id);
    if(error){ console.error('Hindi na-mark as read:', error.message); return; }

    n.read = true;
    renderNotifications();
}

async function markAllNotifsRead(e){
    e.preventDefault();
    e.stopPropagation();
    if(!currentUserId) return;

    const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('receiver_id', currentUserId)
        .eq('read', false);

    if(error){ console.error('Hindi na-mark all as read:', error.message); return; }

    notificationsCache.forEach(n => n.read = true);
    renderNotifications();
}

function subscribeNotificationsRealtime(){
    if(!currentUserId) return;
    supabase
        .channel('resident-notifications-' + currentUserId)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'notifications', filter: `receiver_id=eq.${currentUserId}` },
            () => {
                loadNotifications();
            })
        .subscribe();
}
// ==========================================================================
// LOAD USER PROFILE — tinatawag pagbukas ng page
// ==========================================================================
async function loadUserProfile() {
    const { data: { session } } = await supabase.auth.getSession();

   if (!session) {
    window.location.href = '/pages/login.html';
    return;
}

    currentUserId = session.user.id;

    const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', currentUserId)
        .single();

    if (error || !profile) {
        console.error('Hindi makuha ang profile:', error?.message);
        return;
    }

    currentUserName = profile.name;
    currentUserBarangay = profile.barangay || 'Bambang';
    currentUserContact = profile.contact || ''; // BAGO
    currentUserVerified = profile.id_verified === true; // BAGO

    document.getElementById('userName').textContent = profile.name;
    document.getElementById('welcomeName').textContent = profile.name;
    document.getElementById('userSessionInfo').textContent = session.user.email;

    if (profile.face_image_url) {
        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
            .from('face-images')
            .createSignedUrl(profile.face_image_url, 3600);

        if (signedUrlError) {
            console.error('Hindi makuha ang profile picture:', signedUrlError.message);
        } else {
            document.getElementById('userProfilePic').src = signedUrlData.signedUrl;
            document.getElementById('residentProfilePic').src = signedUrlData.signedUrl;
            document.getElementById('residentProfilePic').style.display = 'block';
            document.getElementById('residentDefaultIcon').style.display = 'none';
        }
    }

    loadRequestHistory();
    subscribeRequestsRealtimeResident();
    loadNotifications();
    subscribeNotificationsRealtime();
}

// ==========================================================================
// ID VERIFICATION GATE — kailangan ma-verify muna ang ID bago makapag-submit
// ng kahit anong request (Emergency, Transpo, Medical Assistance, SOS)
// ==========================================================================
function requireVerifiedOrWarn() {
    if (!currentUserVerified) {
        alert('⚠️ Kailangan mo munang ma-verify ang iyong ID bago makapag-submit ng request.\n\nTiyakin na malinaw ang kuha ng iyong Valid ID at Selfie photo, at hintayin ang pag-verify ng Barangay Admin. Bumalik sa loob ng ilang oras o araw.');
        return false;
    }
    return true;
}
// ==========================================================================
// LIVE RESOURCE STATUS — konektado sa Supabase "fleet" table
// ==========================================================================
let fleetCacheResident = [];

const RESIDENT_STATUS_COLORS = {
    'Available': '#00c853',
    'On Duty': '#ff9100',
    'Unavailable': '#e53935'
};

const RESIDENT_TYPE_ICONS = {
    'Medical (Full)': 'fa-truck-medical',
    'Transport': 'fa-van-shuttle',
    'Rescue/Patrol': 'fa-shield-alt',
    'Driver': 'fa-id-badge',
    'Medical Personnel': 'fa-user-nurse',
    'Auxiliary': 'fa-toolbox'
};

async function loadFleetStatusForResident() {
    const { data, error } = await supabase
        .from('fleet')
        .select('id, name, type, status')
        .order('name', { ascending: true });

    if (error) {
        console.error('Hindi makuha ang fleet status:', error.message);
        return;
    }

    fleetCacheResident = data || [];
    renderResidentFleetStatus();
}

function renderResidentFleetStatus() {
    const listEl = document.getElementById('ambulanceList');
    const countEl = document.getElementById('responderCount');
    const statusEl = document.getElementById('ambulanceStatus');
    if (!listEl) return;

    const vehicles = fleetCacheResident.filter(f =>
        ['Medical (Full)', 'Transport', 'Rescue/Patrol', 'Auxiliary'].includes(f.type)
    );
    const personnel = fleetCacheResident.filter(f =>
        ['Driver', 'Medical Personnel'].includes(f.type)
    );

    const activeResponders = personnel.filter(p => p.status !== 'Unavailable').length;
    if (countEl) countEl.textContent = activeResponders;

    const anyAvailable = vehicles.some(v => v.status === 'Available');
    const anyOnDuty = vehicles.some(v => v.status === 'On Duty');
    if (statusEl) {
        if (anyAvailable) {
            statusEl.textContent = 'READY';
            statusEl.style.background = '#00c853';
        } else if (anyOnDuty) {
            statusEl.textContent = 'BUSY';
            statusEl.style.background = '#ff9100';
        } else {
            statusEl.textContent = 'UNAVAILABLE';
            statusEl.style.background = '#e53935';
        }
    }

    if (vehicles.length === 0) {
        listEl.innerHTML = '<div style="text-align:center; color:#999; padding:15px; font-size:0.85rem;">Walang naka-rehistrong sasakyan sa ngayon.</div>';
        return;
    }

    listEl.innerHTML = vehicles.map(v => {
        const color = RESIDENT_STATUS_COLORS[v.status] || '#999';
        const icon = RESIDENT_TYPE_ICONS[v.type] || 'fa-truck-medical';
        const label = v.status === 'Available' ? 'AVAILABLE'
            : v.status === 'On Duty' ? 'ON DUTY'
            : 'UNAVAILABLE';
        return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #f9f9f9;">
                <div style="font-weight:bold; color:#333;"><i class="fas ${icon}"></i> ${v.name}</div>
                <div style="color:${color}; font-weight:bold; font-size:0.85rem;">${label}</div>
            </div>
        `;
    }).join('');
}

function subscribeFleetRealtimeResident() {
    supabase
        .channel('resident-fleet-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'fleet' }, () => {
            loadFleetStatusForResident();
        })
        .subscribe();
}


document.addEventListener('DOMContentLoaded', () => {
    loadUserProfile();
    loadFleetStatusForResident();
    subscribeFleetRealtimeResident();
});


// ==========================================================================
// PROFILE DROPDOWN NAVIGATION
// ==========================================================================
function toggleProfileMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById('profileDropdown');
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}

document.addEventListener('click', () => {
    const menu = document.getElementById('profileDropdown');
    if (menu) menu.style.display = 'none';
});

function openChangePasswordModal() {
    toggleModal('changePasswordModal', true);
}

// ==========================================================================
// MODAL CONTROL (para sa firstAidModal at changePasswordModal)
// ==========================================================================
function toggleModal(id, show) {
    document.getElementById(id).style.display = show ? 'flex' : 'none';
}

// ==========================================================================
// DYNAMIC CONTENT PANEL (centered popup para sa forms)
// ==========================================================================
function switchView(viewId) {
    document.getElementById('dynamic-content-panel-overlay').classList.add('active');
    document.querySelectorAll('.resident-view').forEach(el => el.style.display = 'none');
    document.getElementById(viewId).style.display = 'block';
}

function closeView() {
    document.getElementById('dynamic-content-panel-overlay').classList.remove('active');
    stopLocationTracking();
    stopTranspoCooldownWatcher();
}

// ==========================================================================
// VEHICLE SELECTION (Transpo booking)
// ==========================================================================
function selectVehicle(element, type) {
    document.querySelectorAll('.vehicle-card').forEach(card => {
        card.style.border = '1px solid #eee';
        card.style.background = '#fff';
        card.classList.remove('active');
        card.querySelector('i').style.color = '#666';
    });
    element.style.border = '2px solid #0091ea';
    element.style.background = '#f0f7ff';
    element.classList.add('active');
    element.querySelector('i').style.color = '#0091ea';
    document.getElementById('selectedVehicleType').value = type;

    checkVehicleAvailability();
}

// ==========================================================================
// TRANSPO AVAILABILITY SYSTEM
// ==========================================================================
const bookedSchedules = [
    { vehicle: 'Ambulance', date: '2026-07-15', time: '09:00' },
    { vehicle: 'PTV', date: '2026-07-12', time: '14:00' }
];

function initTranspoForm() {
    const dateInput = document.getElementById('transpoDate');
    const timeInput = document.getElementById('transpoTime');

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');

    dateInput.value = `${yyyy}-${mm}-${dd}`;
    timeInput.value = `${hh}:${min}`;

    dateInput.min = `${yyyy}-${mm}-${dd}`;

    checkVehicleAvailability();

    dateInput.addEventListener('change', checkVehicleAvailability);
    timeInput.addEventListener('change', checkVehicleAvailability);

    startTranspoCooldownWatcher();
}

function checkVehicleAvailability() {
    const date = document.getElementById('transpoDate').value;
    const time = document.getElementById('transpoTime').value;
    const msg = document.getElementById('availabilityMsg');

    if (!date || !time) {
        msg.innerHTML = '<i class="fas fa-calendar-alt"></i> <strong>Availability:</strong> Pumili ng Date at Time.';
        return;
    }

    let allAvailable = true;

    document.querySelectorAll('.vehicle-card').forEach((card) => {
        const vehicleType = card.getAttribute('data-vehicle');
        const dot = document.getElementById('dot-' + vehicleType);

        const isBooked = bookedSchedules.some(
            (b) => b.vehicle === vehicleType && b.date === date && b.time === time
        );

        if (isBooked) {
            dot.style.background = '#e53935';
            allAvailable = false;

            if (card.classList.contains('active')) {
                msg.innerHTML = `<i class="fas fa-triangle-exclamation"></i> <strong>Availability:</strong> Ang ${vehicleType} ay <strong>hindi available</strong> sa piniling oras. Pumili ng ibang sasakyan o oras.`;
            }
        } else {
            dot.style.background = '#00c853';
        }
    });

    if (allAvailable) {
        msg.innerHTML = '<i class="fas fa-calendar-check"></i> <strong>Availability:</strong> Lahat ng sasakyan ay <strong>Available</strong> sa piniling petsa at oras.';
    }
}

// ==========================================================================
// TRANSPO 1-HOUR COOLDOWN SYSTEM
// ==========================================================================
async function checkTranspoCooldown() {
    const { data, error } = await supabase
        .from('emergency_requests')
        .select('created_at')
        .eq('sender_id', currentUserId)
        .eq('type', 'Transpo')
        .order('created_at', { ascending: false })
        .limit(1);

    if (error) {
        console.error('Hindi ma-check ang cooldown:', error.message);
        return { allowed: true };
    }

    if (!data || data.length === 0) {
        return { allowed: true };
    }

    const lastRequestTime = new Date(data[0].created_at);
    const now = new Date();
    const diffMs = now - lastRequestTime;
    const oneHourMs = 60 * 60 * 1000;

    if (diffMs < oneHourMs) {
        const remainingMs = oneHourMs - diffMs;
        const remainingMin = Math.ceil(remainingMs / 60000);
        return { allowed: false, remainingMinutes: remainingMin };
    }

    return { allowed: true };
}

let transpoCooldownInterval = null;

async function updateTranspoCooldownUI() {
    const cooldown = await checkTranspoCooldown();
    const msgBox = document.getElementById('transpoCooldownMsg');
    const submitBtn = document.getElementById('transpoSubmitBtn');

    if (!msgBox || !submitBtn) return;

    if (!cooldown.allowed) {
        msgBox.style.display = 'block';
        msgBox.innerHTML = `<i class="fas fa-clock"></i> Puwede ka na muling mag-submit pagkatapos ng ${cooldown.remainingMinutes} minuto.`;
        submitBtn.disabled = true;
        submitBtn.style.opacity = '0.5';
        submitBtn.style.cursor = 'not-allowed';
    } else {
        msgBox.style.display = 'none';
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
        submitBtn.style.cursor = 'pointer';
    }
}

function startTranspoCooldownWatcher() {
    updateTranspoCooldownUI();

    if (transpoCooldownInterval) clearInterval(transpoCooldownInterval);
    transpoCooldownInterval = setInterval(updateTranspoCooldownUI, 60000);
}

function stopTranspoCooldownWatcher() {
    if (transpoCooldownInterval) {
        clearInterval(transpoCooldownInterval);
        transpoCooldownInterval = null;
    }
}

// ==========================================================================
// RESET TRANSPO FORM (pagkatapos mag-submit)
// ==========================================================================
function resetTranspoForm() {
    document.getElementById('patientCondition').selectedIndex = 0;
    document.getElementById('pickupPoint').value = '';
    document.getElementById('destination').value = '';
    document.getElementById('transpoReason').value = '';

    document.querySelectorAll('.vehicle-card').forEach((card, index) => {
        card.style.border = index === 0 ? '2px solid #0091ea' : '1px solid #eee';
        card.style.background = index === 0 ? '#f0f7ff' : '#fff';
        card.classList.toggle('active', index === 0);
        card.querySelector('i').style.color = index === 0 ? '#0091ea' : '#666';
    });
    document.getElementById('selectedVehicleType').value = 'PTV';

    const dateInput = document.getElementById('transpoDate');
    const timeInput = document.getElementById('transpoTime');
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    dateInput.value = `${yyyy}-${mm}-${dd}`;
    timeInput.value = `${hh}:${min}`;

    checkVehicleAvailability();
}

// ==========================================================================
// LIVE GPS TRACKING + MAP (Emergency Form)
// ==========================================================================
let emergencyMap = null;
let emergencyMarker = null;
let emergencyWatchId = null;

function getLocation() {
    const input = document.getElementById('emergencyLocation');
    const status = document.getElementById('mapStatus');

    if (!navigator.geolocation) {
        input.value = 'Geolocation not supported ng browser mo.';
        status.innerHTML = '<i class="fas fa-triangle-exclamation"></i> Hindi supported ang GPS sa browser na ito.';
        return;
    }

    input.value = 'Detecting exact coordinates...';
    status.innerHTML = '<i class="fas fa-satellite-dish"></i> Kumukuha ng mabilis na estimate...';

    if (emergencyWatchId !== null) {
        navigator.geolocation.clearWatch(emergencyWatchId);
    }

    // HAKBANG 1 — mabilis na low-accuracy fix muna, para
    // agad lumabas ang map at may approximate marker kaagad
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            input.value = `${lat.toFixed(6)}, ${lng.toFixed(6)} (approximate)`;
            status.innerHTML = '<i class="fas fa-satellite-dish"></i> Approximate na lokasyon — nire-refine pa...';
            initOrUpdateMap(lat, lng);
        },
        () => { /* okay lang kung mabigo ito, hihintayin na lang natin yung high-accuracy fix */ },
        { enableHighAccuracy: false, maximumAge: 30000, timeout: 5000 }
    );

    // HAKBANG 2 — patuloy na hinahanap ang eksaktong GPS fix sa background
    emergencyWatchId = navigator.geolocation.watchPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;

            input.value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
            status.innerHTML = `<i class="fas fa-circle-check" style="color:#2E7D32;"></i> Live location — updated ${new Date().toLocaleTimeString('en-PH')}`;

            initOrUpdateMap(lat, lng);
        },
        (err) => {
            // Kung hindi pa rin nagawa ang HAKBANG 1, saka lang natin ipapakita ang error
            if (input.value === 'Detecting exact coordinates...') {
                input.value = 'Hindi makuha ang lokasyon. I-on ang GPS.';
                status.innerHTML = '<i class="fas fa-triangle-exclamation"></i> Hindi ma-access ang lokasyon. Paki-on ang GPS/location permission.';
            }
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
}

function initOrUpdateMap(lat, lng) {
    if (!emergencyMap) {
        emergencyMap = L.map('emergencyMap').setView([lat, lng], 17);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 19
        }).addTo(emergencyMap);

        const pulseIcon = L.divIcon({
            className: '',
            html: '<div class="live-pulse-marker"></div>',
            iconSize: [18, 18]
        });

        emergencyMarker = L.marker([lat, lng], { icon: pulseIcon }).addTo(emergencyMap);
    } else {
        emergencyMarker.setLatLng([lat, lng]);
        emergencyMap.setView([lat, lng]);
        setTimeout(() => emergencyMap.invalidateSize(), 200);
    }
}

function stopLocationTracking() {
    if (emergencyWatchId !== null) {
        navigator.geolocation.clearWatch(emergencyWatchId);
        emergencyWatchId = null;
    }
}


// ==========================================================================
// REQUEST TRACKING MODAL — progress stepper + live ETA para sa resident
// ==========================================================================
let activeTrackingRequestId = null;

const RESIDENT_STEP_ORDER = ['Sent', 'Assigned', 'In Transit', 'Arrived', 'Completed'];

function residentStepIndex(status) {
    if (['Completed', 'Resolved'].includes(status)) return 4;
    if (status === 'Arrived') return 3;
    if (['Accepted', 'Assigned', 'In Transit'].includes(status)) return 2;
    if (status === 'Pending') return 0;
    return 0;
}

function residentGetCurrentEta(req) {
    if (req.status === 'Arrived' || req.status === 'Completed' || req.status === 'Resolved') {
        return { label: req.status === 'Arrived' ? 'Nasa lokasyon na' : 'Tapos na', sub: '' };
    }
    if (!req.eta_minutes || !req.accepted_at) {
        return { label: req.eta || 'Hindi pa naka-set', sub: 'Naghihintay ng pag-accept' };
    }
    const elapsedMinutes = Math.floor((Date.now() - new Date(req.accepted_at).getTime()) / 60000);
    const remaining = Math.max(1, req.eta_minutes - elapsedMinutes);
    return { label: `${remaining} min`, sub: req.eta_updated_at ? `Updated ${new Date(req.eta_updated_at).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })}` : '' };
}

function residentShortTime(value) {
    if (!value) return '';
    return new Date(value).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
}

function openTrackingModal(id) {
    activeTrackingRequestId = id;
    const req = residentRequestsCache.find(r => String(r.id) === String(id));
    const body = document.getElementById('trackingModalBody');
    if (!req || !body) return;

    if (req.status === 'Rejected') {
        body.innerHTML = `
            <div class="req-info-line"><strong>${req.type}${req.category ? ' - ' + req.category : ''}</strong></div>
            <div style="background:#ffebee; border:1px solid #ffcdd2; border-radius:12px; padding:14px; text-align:center; color:#c62828; font-weight:bold; margin:14px 0;">
                <i class="fas fa-circle-xmark"></i> Hindi na-approve ang request na ito.
            </div>
            <div class="req-info-line">${req.admin_notes ? 'Dahilan: ' + req.admin_notes : ''}</div>
        `;
        toggleModal('trackingModal', true);
        return;
    }

    const eta = residentGetCurrentEta(req);
    const idx = residentStepIndex(req.status);
    const icons = ['fa-file-alt', 'fa-user-check', 'fa-truck-medical', 'fa-location-dot', 'fa-flag-checkered'];
    const timestamps = [req.created_at, req.accepted_at, req.accepted_at, req.arrived_at, req.completed_at];

    body.innerHTML = `
        <div class="req-info-line"><strong>${req.type}${req.category ? ' - ' + req.category : ''}</strong></div>
        <div class="req-info-line">${req.description || ''}</div>

        <div class="req-eta-box">
            <div class="req-eta-value">${eta.label}</div>
            <small>${eta.sub || 'ETA mula sa responder'}</small>
        </div>

        <div class="req-progress-steps">
            ${RESIDENT_STEP_ORDER.map((step, i) => `
                <div class="req-step ${i < idx ? 'done' : i === idx ? 'current' : ''}">
                    <div class="req-step-icon"><i class="fas ${icons[i]}"></i></div>
                    <small>${step}</small>
                    <span class="req-step-time">${timestamps[i] ? residentShortTime(timestamps[i]) : ''}</span>
                </div>
            `).join('')}
        </div>

        ${req.assigned_responder_name ? `<div class="req-info-line"><i class="fas fa-user-doctor"></i> Assigned: <strong>${req.assigned_responder_name}</strong></div>` : ''}
    `;

    toggleModal('trackingModal', true);
}

function closeTrackingModal() {
    activeTrackingRequestId = null;
    toggleModal('trackingModal', false);
}

function subscribeRequestsRealtimeResident() {
    if (!currentUserId) return;
    supabase
        .channel('resident-own-requests-' + currentUserId)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'emergency_requests', filter: `sender_id=eq.${currentUserId}` },
            () => {
                loadRequestHistory();
            })
        .subscribe();
}


// ==========================================================================
// SUBMIT: EMERGENCY REQUEST
// ==========================================================================
async function submitRequest(type) {
    if (!requireVerifiedOrWarn()) return;

    const category = document.getElementById('category').value;
    const desc = document.getElementById('desc').value.trim();
    const location = document.getElementById('emergencyLocation').value;

    if (!desc) {
        alert('Pakisulat ang detalye ng sitwasyon.');
        return;
    }
    if (!location || location === 'Detecting exact coordinates...') {
        alert('Hindi pa nadedetect ang lokasyon mo. Subukan ulit.');
        return;
    }

    const [latStr, lngStr] = location.split(',').map(s => s.trim());

    const { error } = await supabase.from('emergency_requests').insert({
        sender_id: currentUserId,
        type: type || 'Emergency',
        category: category,
        service_type: category,
        description: desc,
        lat: parseFloat(latStr),
        lng: parseFloat(lngStr),
        status: 'Pending',
        patient_name: currentUserName,
        jurisdiction: currentUserBarangay,
        urgency: category === 'Fire Emergency' ? 'Urgent' : 'Normal'
    });

    if (error) {
        alert('Hindi naipadala ang request: ' + error.message);
        return;
    }

    document.getElementById('instantAlertToast').style.display = 'block';
    setTimeout(() => {
        document.getElementById('instantAlertToast').style.display = 'none';
    }, 3000);

    document.getElementById('desc').value = '';
    document.getElementById('category').selectedIndex = 0;

    closeView();
    loadRequestHistory();
}

// ==========================================================================
// SUBMIT: TRANSPO REQUEST (may 1-hour cooldown)
// ==========================================================================
async function submitTranspo() {
    if (!requireVerifiedOrWarn()) return;

    const cooldown = await checkTranspoCooldown();
    if (!cooldown.allowed) {
        alert(`Isang Transpo request lang ang puwede kada oras. Maghintay pa ng ${cooldown.remainingMinutes} minuto bago muling magsubmit.`);
        return;
    }

    const vehicle = document.getElementById('selectedVehicleType').value;
    const condition = document.getElementById('patientCondition').value;
    const date = document.getElementById('transpoDate').value;
    const time = document.getElementById('transpoTime').value;
    const pickup = document.getElementById('pickupPoint').value.trim();
    const destination = document.getElementById('destination').value.trim();
    const reason = document.getElementById('transpoReason').value.trim();

    if (!date || !time || !pickup || !destination) {
        alert('Kumpletuhin ang Date, Time, Pickup, at Destination.');
        return;
    }

    const { error } = await supabase.from('emergency_requests').insert({
        sender_id: currentUserId,
        type: 'Transpo',
        category: vehicle,
        service_type: 'Transpo',
        description: `${pickup} → ${destination}${reason ? ' | ' + reason : ''}`,
        status: 'Pending',
        patient_name: currentUserName,
        jurisdiction: currentUserBarangay,
        details: {
            patient_condition: condition,
            date: date,
            time: time,
            pickup: pickup,
            destination: destination,
            reason: reason
        }
    });

    if (error) {
        alert('Hindi naipadala ang request: ' + error.message);
        return;
    }

    alert('Transport request submitted!');
    resetTranspoForm();
    updateTranspoCooldownUI();
    closeView();
    loadRequestHistory();
}

// ==========================================================================
// SUBMIT: MEDICAL ASSISTANCE REQUEST
// ==========================================================================
async function submitMedicalRequest() {
    if (!requireVerifiedOrWarn()) return;

    const type = document.getElementById('assistType').value;
    const docs = document.getElementById('assistDocs').files;
    const details = document.getElementById('assistDetails').value.trim();

    if (docs.length === 0) {
        alert('Mag-upload ng kailangang dokumento.');
        return;
    }
    if (!details) {
        alert('Ilagay ang detalye/purpose ng request.');
        return;
    }

   const ASSIST_TYPE_FOLDERS = {
        'Medicine Assistance': 'medicine-assistance',
        'Hospital Bill': 'hospital-bill',
        'Laboratory': 'laboratory'
    };
    const folderSlug = ASSIST_TYPE_FOLDERS[type] || 'other';

    const uploadedPaths = [];

    for (let i = 0; i < docs.length; i++) {
        const file = docs[i];
      const filePath = `${currentUserId}/${folderSlug}/${Date.now()}_${file.name}`;

        const { error: uploadError } = await supabase.storage
            .from('medical-documents')
            .upload(filePath, file);

        if (uploadError) {
            alert('Hindi na-upload ang ' + file.name + ': ' + uploadError.message);
            return;
        }

        uploadedPaths.push(filePath);
    }

    // BAGO — dati ay pumupunta ito sa 'emergency_requests' table, kaya
    // nakikita rin ito ng RESPONDER dashboard (na kumukuha ng lahat ng
    // laman ng emergency_requests). Ito ay financial/medical assistance
    // APPLICATION, hindi isang dispatch-type na emergency — kaya hindi
    // ito dapat pumupunta sa responder. Dito na mismo ito sa
    // 'medical_assistance_requests' table pumupunta, ang tanging
    // binabasa ng Admin's "Assistance Queue" tab.
    const { error } = await supabase.from('medical_assistance_requests').insert({
        sender_id: currentUserId,
        resident_name: currentUserName,
        contact_number: currentUserContact || null,
        category: type,
        purpose: details,
        priority: 'Routine',
        estimated_cost: 0,
        documents: uploadedPaths,
        status: 'Pending',
        history: [{ status: 'Pending', at: new Date().toISOString(), note: 'Request submitted by resident' }]
    });

    if (error) {
        alert('Hindi naipadala ang request: ' + error.message);
        return;
    }

    alert('Medical assistance request sent!');

    document.getElementById('assistType').selectedIndex = 0;
    document.getElementById('assistDocs').value = '';
    document.getElementById('assistDetails').value = '';

    closeView();
    loadRequestHistory();
}

// ==========================================================================
// LOAD REQUEST HISTORY — "My Recent Requests" table
// ==========================================================================
let residentRequestsCache = [];

async function loadRequestHistory() {
    if (!currentUserId) return;

    const { data, error } = await supabase
        .from('emergency_requests')
        .select('*')
        .eq('sender_id', currentUserId)
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Hindi makuha ang history:', error.message);
        return;
    }

    residentRequestsCache = data || [];

    const tbody = document.getElementById('requestHistory');
    tbody.innerHTML = '';

    if (residentRequestsCache.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#999;">Wala ka pang naisumite na request.</td></tr>';
        return;
    }

    residentRequestsCache.forEach((req) => {
        const dateStr = new Date(req.created_at).toLocaleDateString('en-PH') + ' ' +
                         new Date(req.created_at).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });

        const statusClass = req.status.toLowerCase().replace(' ', '');

       const row = document.createElement('tr');
        row.innerHTML = `
            <td>${req.type}${req.category ? ' - ' + req.category : ''}</td>
            <td>${dateStr}</td>
            <td><span class="status-badge-table status-${statusClass}">${req.status}</span></td>
            <td>${req.description || ''}</td>
            <td style="text-align:center; color:#0091ea;"><i class="fas fa-chevron-right"></i></td>
        `;
        row.onclick = () => openTrackingModal(req.id);
        tbody.appendChild(row);
    });

    if (activeTrackingRequestId) {
        openTrackingModal(activeTrackingRequestId);
    }
}

// ==========================================================================
// FIRST AID GUIDES
// BAGO — bawat guide ay may kompletong step-by-step na instructions na,
// hindi na isang pangungusap lang. Unang hakbang palagi ang pagtawag sa
// emergency hotline, para hindi ito makaligtaan ng residente.
// ==========================================================================
const EMERGENCY_HOTLINES_TEXT = '0969-422-4180 (Punong Barangay) · 0931-006-8118 (MHO-RHU) · 0951-836-0294 / 0955-288-2055 (MDRRMO)';

const firstAidGuides = [
    {
        title: 'CPR (Adult)',
        icon: 'fa-heart-pulse',
        steps: [
            'Tumawag agad sa emergency hotline (Barangay Bambang / 911) bago o habang ginagawa ang CPR — kung may kasama, isa ang tatawag habang ikaw ay gumagawa.',
            'Tiyaking safe ang paligid, tapos tawagin ang pangalan ng pasyente — kung walang tugon, magpatuloy.',
            'Ilagay ang pasyente sa patag na sahig, nakahiga pataas.',
            'Ilagay ang dalawang kamay sa gitna ng dibdib (sternum), magkapatong.',
            'Compress nang malalim (mga 5-6 cm) at mabilis — 100-120 beats per minute (kasingbilis ng "Stayin\' Alive" beat).',
            'Ipagpatuloy hanggang dumating ang tulong o may senyales ng paggalaw ang pasyente.'
        ]
    },
    {
        title: 'Choking / Nabubulunan',
        icon: 'fa-lungs',
        steps: [
            'Tumawag agad sa emergency hotline kung may ibang tao — huwag itigil ang first aid habang tumatawag.',
            'Tanungin: "Nabubulunan ka ba?" — kung hindi makasagot o makaubo, tulungan agad.',
            'Yumuko papaunta sa harap, suportahan ang dibdib gamit ang isang kamay.',
            'Bigyan ng 5 malakas na tapik sa likod (sa pagitan ng dalawang balikat).',
            'Kung hindi pa lumabas: gawin ang Heimlich maneuver — yakapin mula likod, kamao sa itaas ng pusod, tulak paitaas nang mabilis.',
            'Ulitin ang 5 tapik + 5 tulak hanggang lumabas ang sagabal o dumating ang tulong.'
        ]
    },
    {
        title: 'Pagdurugo / Bleeding',
        icon: 'fa-droplet',
        steps: [
            'Tumawag agad sa emergency hotline, lalo na kung matindi ang pagdurugo.',
            'Maghugas o magsuot ng gloves kung meron, para maiwasan ang impeksyon.',
            'Diinan nang matatag ang sugat gamit ang malinis na tela o gasa.',
            'Itaas ang bahagi ng katawan na may sugat, kung posible, nang mas mataas sa puso.',
            'Huwag alisin ang unang tela kung tumagos ang dugo — magdagdag lang ng panibagong layer.',
            'Manatiling nakabantay habang hinihintay ang responder.'
        ]
    },
    {
        title: 'Sunog / Burns',
        icon: 'fa-fire',
        steps: [
            'Tumawag agad sa emergency hotline, lalo na kung malaki o malalim ang paso.',
            'Ilayo agad ang pasyente sa pinagmulan ng init o apoy.',
            'Buhusan ng malamig (hindi napakalamig) na tubig ang paso nang 10-20 minuto.',
            'Huwag maglagay ng toothpaste, mantika, o yelo — makakasama ito.',
            'Takpan nang maluwag gamit ang malinis, hindi kumakapit na tela.',
            'Kung malaki o malalim ang paso, o nasa mukha/kamay/ari — dalhin agad sa ospital habang naghihintay ng responder.'
        ]
    }
];

function openGuideList() {
    const list = document.getElementById('guideList');
    list.innerHTML = '';
    firstAidGuides.forEach((guide) => {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex; align-items:center; gap:12px; padding:12px; border-bottom:1px solid #eee; cursor:pointer;';
        item.innerHTML = `<i class="fas ${guide.icon}" style="color:#2E7D32; font-size:1.2rem;"></i><span style="font-weight:600;">${guide.title}</span>`;
        item.onclick = () => showFirstAidGuide(guide);
        list.appendChild(item);
    });
}

function showFirstAidGuide(guide) {
    document.getElementById('firstAidContent').innerHTML = `
        <h3 style="color:#2E7D32; margin-bottom:12px;"><i class="fas ${guide.icon}"></i> ${guide.title}</h3>
        <div style="background:#ffebee; border:1px solid #ffcdd2; border-radius:10px; padding:10px 12px; margin-bottom:14px; font-size:0.78rem; color:#c62828; font-weight:bold; line-height:1.5;">
            <i class="fas fa-phone-volume"></i> Emergency Hotline (24/7): ${EMERGENCY_HOTLINES_TEXT}
        </div>
        <ol style="padding-left:20px; margin:0; font-size:0.88rem; line-height:1.9; color:#333;">
            ${guide.steps.map(step => `<li style="margin-bottom:6px;">${step}</li>`).join('')}
        </ol>
    `;
    toggleModal('firstAidModal', true);
}

// ==========================================================================
// LOGOUT
// ==========================================================================
function logout() {
    if (confirm('Are you sure you want to logout?')) {
        supabase.auth.signOut().then(() => {
           window.location.href = '/pages/login.html';
        });
    }
}

// ==========================================================================
// CHANGE PASSWORD
// ==========================================================================
async function submitChangePassword() {
    const current = document.getElementById('currentPassword').value;
    const newPass = document.getElementById('newPassword').value;
    const confirmPass = document.getElementById('confirmPassword').value;

    if (!current || !newPass || !confirmPass) {
        alert('Punan ang lahat ng fields.');
        return;
    }
    if (newPass.length < 6) {
        alert('Ang bagong password ay dapat hindi bababa sa 6 characters.');
        return;
    }
    if (newPass !== confirmPass) {
        alert('Hindi magkatugma ang bagong password at confirm password.');
        return;
    }

    const { error } = await supabase.auth.updateUser({ password: newPass });

    if (error) {
        alert('Hindi na-update ang password: ' + error.message);
        return;
    }

    alert('Password updated successfully!');
    toggleModal('changePasswordModal', false);
}

// ==========================================================================
// SOS HOLD-TO-CONFIRM — kailangan i-hold ng 2 segundo bago mag-trigger,
// para maiwasan ang di-sinasadyang pagpindot sa panic button
// ==========================================================================
const SOS_HOLD_DURATION = 2000; // 2seconds
let sosHoldTimeout = null;

function initSOSHoldButton() {
    const btn = document.getElementById('sosFloatingBtn');
    const label = document.getElementById('sosBtnLabel');
    if (!btn) return;

    const startHold = (e) => {
        e.preventDefault();
        if (sosCooldownActive || sosHoldTimeout) return;

        btn.classList.add('holding');
        if (label) label.textContent = 'Keep holding...';
        if (navigator.vibrate) navigator.vibrate(50);

        sosHoldTimeout = setTimeout(() => {
            btn.classList.remove('holding');
            if (label) label.textContent = 'Hold SOS';
            sosHoldTimeout = null;

            if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);

            handleSOSCall();
        }, SOS_HOLD_DURATION);
    };

    const cancelHold = () => {
        if (sosHoldTimeout) {
            clearTimeout(sosHoldTimeout);
            sosHoldTimeout = null;
        }
        btn.classList.remove('holding');
        if (label) label.textContent = 'Hold SOS';
    };

    btn.addEventListener('pointerdown', startHold);
    btn.addEventListener('pointerup', cancelHold);
    btn.addEventListener('pointerleave', cancelHold);
    btn.addEventListener('pointercancel', cancelHold);
}

document.addEventListener('DOMContentLoaded', () => {
    initSOSHoldButton();
});

// ==========================================================================
// SOS EMERGENCY CALL — instant panic button, auto-submit sa database
// ==========================================================================
let sosCooldownActive = false;

async function handleSOSCall() {
    if (sosCooldownActive) return;
    if (!requireVerifiedOrWarn()) return;
    // BAGO — kunin ang pinaka-bagong user ID direkta kay Supabase,
    // huwag umasa sa currentUserId variable na baka luma na
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
        alert('Hindi ma-verify ang iyong session. Mag-login ulit at subukan muli.');
        return;
    }
    const freshUserId = user.id;

    const sosBtn = document.getElementById('sosFloatingBtn');
    if (sosBtn) {
        sosBtn.disabled = true;
        sosBtn.style.opacity = '0.6';
        sosBtn.style.pointerEvents = 'none';
    }
    sosCooldownActive = true;

    let lat = null, lng = null;

    try {
        const position = await new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(new Error('Walang geolocation support'));
                return;
            }
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                maximumAge: 10000,
                timeout: 5000
            });
        });
        lat = position.coords.latitude;
        lng = position.coords.longitude;
    } catch (err) {
        console.warn('SOS: hindi makuha ang GPS bago magsubmit —', err.message);
    }

    const { error } = await supabase.from('emergency_requests').insert({
        sender_id: freshUserId,
        type: 'SOS',
        category: 'Panic Button',
        service_type: 'SOS',
        description: 'SOS Panic Button — kailangan ng agarang tulong.',
        lat: lat,
        lng: lng,
        status: 'Pending',
        patient_name: currentUserName,
        jurisdiction: currentUserBarangay,
        urgency: 'Urgent'
    });

    if (error) {
        alert('Hindi naipadala ang SOS: ' + error.message + '\nTumawag na lang sa hotline: 0951-836-021');
    } else {
        showInstantAlertToast(
            '🚨 SOS ALERT SENT!',
            lat !== null
                ? 'Naipadala ang eksaktong lokasyon mo. Naabisuhan na ang mga responder.'
                : 'Naipadala ang SOS pero walang GPS signal. Tumawag din agad sa hotline kung kaya.'
        );
        loadRequestHistory();
    }

    setTimeout(() => {
        sosCooldownActive = false;
        if (sosBtn) {
            sosBtn.disabled = false;
            sosBtn.style.opacity = '1';
            sosBtn.style.pointerEvents = 'auto';
        }
    }, 5000);
}

function showInstantAlertToast(title, subtitle) {
    const toast = document.getElementById('instantAlertToast');
    toast.innerHTML = `${title} <br><small style="font-weight: normal;">${subtitle}</small>`;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 4000);
}