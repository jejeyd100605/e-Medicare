/* ============================================================
   e-Medicare — Barangay Bambang Admin Control Center
   AUTHENTICATION & ACCOUNT RECOVERY MODULE
   Powers login.html and recovery.html.

   Implements layered identity verification:
     1) Username + Password
     2) MPIN (mobile quick-access PIN)
     3) OTP (one-time PIN, simulated — no SMS gateway in this demo)
     4) Facial verification (simulated liveness capture)

   IMPORTANT — DEMO SCOPE:
   This app has no backend, so "storage" is the browser's
   localStorage acting as a stand-in for a centralized database.
   Passwords/MPINs here are kept in plain form purely so the demo
   is runnable end-to-end. In a real deployment, credentials must
   never be stored client-side: passwords should be salted+hashed
   on a server, OTPs delivered through a real SMS/Email gateway,
   and facial verification performed by a proper biometric match
   service — none of which a static front-end can do on its own.
   ============================================================ */

/* ---------------------------------------------------------
   Shared storage helpers (mirrors admin.js so both files read/
   write the exact same "database" keys)
--------------------------------------------------------- */
const DB = window.DB || {
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

function logActivity(type, message){
  const list = load(DB.activity, []);
  list.unshift({ id: uid('act'), type, message, at: nowISO() });
  save(DB.activity, list.slice(0, 300));
}

/* Seed a default admin account if no users exist yet (first run
   opened directly on login.html rather than admin.html). */
if(!localStorage.getItem(DB.users)){
  save(DB.users, [
    { id: uid('usr'), name:'Barangay Captain Reyes', role:'Admin / Barangay Captain', contact:'0917 000 1111',
      username:'captain.reyes', password:'Bambang@2026', mpin:'192837',
      secretQuestion:'What was the name of your first pet?', secretAnswer:'bantay',
      tempPassword:false, active:true }
  ]);
}

/* ---------------------------------------------------------
   LOGIN FLOW STATE (in-memory only — never persisted)
--------------------------------------------------------- */
let pendingUser = null;
let pendingOtp = null;
let cameraStream = null;

function showAuthError(msg){
  const el = document.getElementById('authError');
  if(!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}
function clearAuthError(){
  const el = document.getElementById('authError');
  if(el) el.style.display = 'none';
}

function goToStep(n){
  clearAuthError();
  const steps = { 1:'stepCreds', 2:'stepMpin', 3:'stepOtp', 4:'stepFace' };
  Object.keys(steps).forEach(k => {
    const form = document.getElementById(steps[k]);
    if(form) form.style.display = (Number(k) === n) ? 'block' : 'none';
    const ind = document.getElementById('step-ind-' + k);
    if(ind){
      ind.classList.remove('done','current');
      if(Number(k) < n) ind.classList.add('done');
      if(Number(k) === n) ind.classList.add('current');
    }
  });
}

/* STEP 1 — username + password -------------------------------------- */
function handleCredsSubmit(e){
  e.preventDefault();
  clearAuthError();
  const username = document.getElementById('loginUsername').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;

  const users = load(DB.users, []);
  const user = users.find(u => (u.username || '').toLowerCase() === username);

  if(!user){ showAuthError('No account found with that username.'); return false; }
  if(user.active === false){ showAuthError('This account has been deactivated. Contact your administrator.'); return false; }
  if(user.password !== password){
    logActivity('auth', `Failed login attempt for username <b>${username}</b> (wrong password).`);
    showAuthError('Incorrect password.');
    return false;
  }

  pendingUser = user;
  goToStep(2);
  return false;
}

/* STEP 2 — MPIN ------------------------------------------------------ */
function handleMpinSubmit(e){
  e.preventDefault();
  clearAuthError();
  const mpin = document.getElementById('loginMpin').value.trim();
  if(!pendingUser){ goToStep(1); return false; }

  if(pendingUser.mpin !== mpin){
    logActivity('auth', `Failed MPIN entry for <b>${pendingUser.name}</b>.`);
    showAuthError('Incorrect MPIN.');
    return false;
  }

  sendOtp();
  goToStep(3);
  return false;
}

/* STEP 3 — OTP (simulated, since there is no SMS/email gateway) ------ */
function sendOtp(){
  pendingOtp = String(Math.floor(100000 + Math.random() * 900000));
  const display = document.getElementById('demoOtpDisplay');
  if(display) display.textContent = pendingOtp; // shown only because this demo has no real SMS gateway
  const otpField = document.getElementById('loginOtp');
  if(otpField) otpField.value = '';
}
function resendOtp(){
  sendOtp();
  clearAuthError();
}
function handleOtpSubmit(e){
  e.preventDefault();
  clearAuthError();
  const entered = document.getElementById('loginOtp').value.trim();
  if(entered !== pendingOtp){
    logActivity('auth', `Failed OTP verification for <b>${pendingUser.name}</b>.`);
    showAuthError('Incorrect or expired OTP code.');
    return false;
  }
  goToStep(4);
  return false;
}

/* STEP 4 — Facial verification (simulated capture) ------------------- */
function startCamera(){
  const video = document.getElementById('faceVideo');
  const status = document.getElementById('faceStatus');
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    status.textContent = 'Camera access is not supported in this browser. Use the demo fallback below.';
    return;
  }
  navigator.mediaDevices.getUserMedia({ video: true })
    .then(stream => {
      cameraStream = stream;
      video.srcObject = stream;
      status.textContent = 'Camera active — center your face and capture.';
      document.getElementById('btnCapture').disabled = false;
      document.getElementById('btnStartCam').style.display = 'none';
    })
    .catch(() => {
      status.textContent = 'Camera permission denied. Use the demo fallback below.';
    });
}

function stopCamera(){
  if(cameraStream){
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
}

function handleFaceSubmit(e){
  e.preventDefault();
  const video = document.getElementById('faceVideo');
  const canvas = document.getElementById('faceCanvas');
  if(video && video.videoWidth){
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
  }
  document.getElementById('faceStatus').textContent = 'Face captured — verifying…';
  // Simulated verification delay. A real system would send this frame
  // to a biometric matching service and compare it to an enrolled template.
  setTimeout(() => finalizeLogin('Password + MPIN + OTP + facial capture'), 700);
  return false;
}

function skipFaceDemo(){
  finalizeLogin('Password + MPIN + OTP (facial step skipped — no camera available in this demo)');
}

function finalizeLogin(methodNote){
  stopCamera();
  const session = {
    userId: pendingUser.id,
    name: pendingUser.name,
    role: pendingUser.role,
    loginAt: nowISO()
  };
  save(DB.session, session);
  logActivity('auth', `<b>${pendingUser.name}</b> (${pendingUser.role}) logged in successfully. Verified via: ${methodNote}.`);

  const role = (pendingUser.role || '').toLowerCase();
  if(role.includes('admin')){
    window.location.href = 'admin.html';
  } else if(role.includes('responder')){
    window.location.href = 'responder.html';
  } else {
    window.location.href = 'resident.html'; // or whatever your resident dashboard file is named
  }
}

/* ---------------------------------------------------------
   ACCOUNT RECOVERY (secret question / answer)
--------------------------------------------------------- */
let recoveryUser = null;

function showRecMessage(id, msg){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}
function clearRecMessages(){
  ['recError','recSuccess'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = 'none';
  });
}

function handleRecoveryLookup(e){
  e.preventDefault();
  clearRecMessages();
  const username = document.getElementById('recUsername').value.trim().toLowerCase();
  const users = load(DB.users, []);
  const user = users.find(u => (u.username || '').toLowerCase() === username);
  if(!user){ showRecMessage('recError', 'No account found with that username.'); return false; }
  if(!user.secretQuestion){ showRecMessage('recError', 'This account has no recovery question on file. Contact an administrator for a manual reset.'); return false; }

  recoveryUser = user;
  document.getElementById('recQuestionLabel').textContent = user.secretQuestion;
  document.getElementById('recStepUser').style.display = 'none';
  document.getElementById('recStepQuestion').style.display = 'block';
  return false;
}

function handleRecoveryAnswer(e){
  e.preventDefault();
  clearRecMessages();
  const answer = document.getElementById('recAnswer').value.trim().toLowerCase();
  if(!recoveryUser || answer !== (recoveryUser.secretAnswer || '').toLowerCase()){
    logActivity('auth', `Failed account-recovery attempt for <b>${recoveryUser ? recoveryUser.name : 'unknown user'}</b> (wrong secret answer).`);
    showRecMessage('recError', 'That answer does not match our records.');
    return false;
  }
  document.getElementById('recStepQuestion').style.display = 'none';
  document.getElementById('recStepReset').style.display = 'block';
  return false;
}

function handleRecoveryReset(e){
  e.preventDefault();
  clearRecMessages();
  const newPassword = document.getElementById('recNewPassword').value;
  const newMpin = document.getElementById('recNewMpin').value;

  const users = load(DB.users, []);
  const user = users.find(u => u.id === recoveryUser.id);
  user.password = newPassword;
  user.mpin = newMpin;
  user.tempPassword = false;
  save(DB.users, users);

  logActivity('auth', `<b>${user.name}</b> recovered account access via secret question and reset their password/MPIN.`);
  showRecMessage('recSuccess', 'Password and MPIN updated. Redirecting to login…');
  document.getElementById('recStepReset').style.display = 'none';
  setTimeout(() => { window.location.href = 'login.html'; }, 1600);
  return false;
}

function goToRecovery(){
  window.location.href = 'recovery.html';
}