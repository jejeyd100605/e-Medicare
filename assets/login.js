// ==========================================================================
// SUPABASE SETUP — palitan ang dalawang value sa ibaba ng galing sa
// Supabase Dashboard → Settings → API
// ==========================================================================
const SUPABASE_URL = "https://szxptfuwkmqwcipxpoym.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_9mabckJnVdJ_Z-9km2T7mQ_c9t_XKiR";
















var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// ==========================================================================
// GLOBAL VARIABLES
// ==========================================================================
let tempUser = null;          // Temporary signup data bago ma-verify ang OTP
let capturedImageBlob = null; // Photo bilang blob (para i-upload sa Storage)
let videoStream = null;
let capturedIdBlob = null;    // ID photo bilang blob (para i-upload sa Storage)
let idVideoStream = null;
















// ==========================================================================
// LOADING SCREEN
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
    startLoadingScreen();
});
















function startLoadingScreen() {
    const timerEl = document.getElementById("timer");
    const loadingScreen = document.getElementById("loadingScreen");
    let countdown = 3;
















    const interval = setInterval(() => {
        countdown--;
        if (timerEl) timerEl.textContent = countdown;
















        if (countdown <= 0) {
            clearInterval(interval);
            if (loadingScreen) loadingScreen.classList.add("hidden");
            initApp();
        }
    }, 1000);
}
















// ==========================================================================
// INIT APP — tinitingnan kung may existing Supabase session na
// ==========================================================================
async function initApp() {
    const { data: { session } } = await supabase.auth.getSession();
















    if (session) {
        const { data: profile } = await supabase
            .from("profiles")
            .select("*")
            .eq("id", session.user.id)
            .single();
















        if (profile) {
            // Admin/official accounts should NEVER use the quick-unlock MPIN
            // screen — laging kailangan nilang mag-full login gamit email +
            // password, lalo na dahil pwedeng shared device ang gamit dito
            // (parehong device ng resident/responder).
            if (profile.role === "admin" || profile.role === "official") {
                await supabase.auth.signOut();
                document.getElementById("formView").classList.remove("hidden");
                showForm("login");
                return;
            }
















            window._currentProfile = profile;
















            if (!profile.mpin) {
                document.getElementById("setMpinOverlay").classList.remove("hidden");
                return;
            }
















            if (document.getElementById("welcomeName")) {
                document.getElementById("welcomeName").innerText = "Welcome, " + profile.name + "!";
            }
            document.getElementById("mpinView").classList.remove("hidden");
            document.getElementById("formView").classList.add("hidden");
            return;
        }
    }
















    document.getElementById("formView").classList.remove("hidden");
    showForm("login");
}
// ==========================================================================
// FORM TOGGLES
// ==========================================================================
function showForm(type) {
    document.getElementById("mpinView")?.classList.add("hidden");
    document.getElementById("otpOverlay")?.classList.add("hidden");
    document.getElementById("setMpinOverlay")?.classList.add("hidden");
    document.getElementById("idConsentOverlay")?.classList.add("hidden");
















    if (document.getElementById("facialCaptureOverlay")) {
        document.getElementById("facialCaptureOverlay").classList.add("hidden");
        stopCamera();
    }
















    if (document.getElementById("idCaptureOverlay")) {
        document.getElementById("idCaptureOverlay").classList.add("hidden");
        stopIdCamera();
    }
















    document.getElementById("formView")?.classList.remove("hidden");
    document.getElementById("loginForm")?.classList.toggle("hidden", type !== "login");
    document.getElementById("signupForm")?.classList.toggle("hidden", type !== "signup");
}
















// ==========================================================================
// PIN/OTP BOX AUTO-FOCUS
// ==========================================================================
function moveFocus(el) {
    if (el.value.length === 1 && el.nextElementSibling) {
        el.nextElementSibling.focus();
    }
    if (!el.dataset.listenerAttached) {
        el.addEventListener("keydown", (e) => {
            if (e.key === "Backspace" && el.value.length === 0 && el.previousElementSibling) {
                el.previousElementSibling.focus();
            }
        });
        el.dataset.listenerAttached = true;
    }
}








// ==========================================================================
// SHOW/HIDE PASSWORD TOGGLE
// ==========================================================================
function togglePasswordVisibility(inputId, iconId) {
    const input = document.getElementById(inputId);
    const icon = document.getElementById(iconId);
    if (!input || !icon) return;








    if (input.type === "password") {
        input.type = "text";
        icon.classList.remove("fa-eye");
        icon.classList.add("fa-eye-slash");
    } else {
        input.type = "password";
        icon.classList.remove("fa-eye-slash");
        icon.classList.add("fa-eye");
    }
}
















// ==========================================================================
// SIGNUP — gumagawa muna ng Supabase Auth account, sends real 6-digit OTP
// ==========================================================================
async function handleSignup(e) {
    e.preventDefault();








    const email = document.getElementById("regEmail").value.trim().toLowerCase();
    const password = document.getElementById("regPass").value;
    const confirmPassword = document.getElementById("regConfirmPass").value; // BAGO
    const contactNo = document.getElementById("regContactNo").value.trim(); // bagong dagdag
    const address = document.getElementById("regAddress").value.trim(); // bagong dagdag
    const firstName = document.getElementById("regFirstName").value.trim();
    const middleName = document.getElementById("regMiddleName").value.trim();
    const lastName = document.getElementById("regLastName").value.trim();
    const fullName = [firstName, middleName, lastName].filter(Boolean).join(" ");








    // BAGO — i-check muna kung magkatugma bago tumawag ng supabase.auth.signUp
    if (password !== confirmPassword) {
        alert("Hindi magkatugma ang password at re-type password. Pakisuri ulit.");
        return;
    }








    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: {
                first_name: firstName,
                middle_name: middleName || null,
                last_name: lastName,
                name: fullName,
                role: "resident"
            }
        }
    });
   








    if (error) {
        alert("Registration Failed: " + error.message);
        return;
    }








    tempUser = { email, role: "resident", firstName, lastName };








    document.getElementById("formView").classList.add("hidden");
    document.getElementById("otpOverlay").classList.remove("hidden");
    alert("A 6-digit verification code was sent to your email.");
}








// ==========================================================================
// VERIFY OTP — totoong Supabase email OTP verification (type: 'signup')
// ==========================================================================
async function verifyOtp() {
    const otp = Array.from(document.querySelectorAll(".otp-box")).map(i => i.value).join("");
















    if (!/^\d{6}$/.test(otp)) {
        alert("Please enter the full 6-digit code.");
        return;
    }
















    const { data, error } = await supabase.auth.verifyOtp({
        email: tempUser.email,
        token: otp,
        type: "signup"
    });
















    if (error) {
        alert("Incorrect or expired OTP: " + error.message);
        return;
    }
















    startFacialCapture();
}
















// ==========================================================================
// CAMERA — kunin lang ang photo, walang face-detection library
// ==========================================================================
function startFacialCapture() {
    document.getElementById("otpOverlay").classList.add("hidden");
    document.getElementById("facialCaptureOverlay").classList.remove("hidden");
















    const video = document.getElementById("webcam");
    const statusText = document.getElementById("cameraStatus");
    statusText.style.color = "";
    statusText.innerText = "Initializing camera...";
















    if (navigator.mediaDevices?.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } })
            .then((stream) => {
                videoStream = stream;
                video.srcObject = stream;
                statusText.innerText = "Camera ready. Position your face inside the circle.";
            })
            .catch((err) => {
                console.error("Camera error:", err);
                statusText.style.color = "#d9534f";
                statusText.innerText = "Camera access denied or unavailable.";
            });
    } else {
        statusText.innerText = "Webcam not supported by this browser.";
    }
}
















function captureLivePhoto() {
    const video = document.getElementById("webcam");
    const canvas = document.getElementById("photoCanvas");
    const context = canvas.getContext("2d");
    const statusText = document.getElementById("cameraStatus");
















    if (!videoStream || video.videoWidth === 0) {
        statusText.style.color = "#d9534f";
        statusText.innerText = "No camera feed detected. Please allow camera access.";
        return;
    }
















    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
















    canvas.toBlob((blob) => {
        capturedImageBlob = blob;
        statusText.style.color = "#4cae4c";
        statusText.innerText = "Photo captured successfully.";
        proceedToNextStep();
    }, "image/png");
}
















function proceedToNextStep() {
    stopCamera();
    setTimeout(() => {
        document.getElementById("facialCaptureOverlay")?.classList.add("hidden");
        document.getElementById("idConsentOverlay")?.classList.remove("hidden");
    }, 800);
}
















function stopCamera() {
    if (videoStream) {
        videoStream.getTracks().forEach((track) => track.stop());
        videoStream = null;
    }
}
















// ==========================================================================
// ID SCAN CONSENT — Data Privacy Act (RA 10173) compliance
// ==========================================================================
function toggleConsentButton() {
    const checkbox = document.getElementById("consentCheckbox");
    const btn = document.getElementById("consentProceedBtn");
















    btn.disabled = !checkbox.checked;
    btn.style.opacity = checkbox.checked ? "1" : "0.5";
    btn.style.cursor = checkbox.checked ? "pointer" : "not-allowed";
}
















function proceedToIdCapture() {
    const checkbox = document.getElementById("consentCheckbox");
    if (!checkbox.checked) {
        alert("Kailangan mo munang tanggapin ang Data Privacy Notice bago magpatuloy.");
        return;
    }
















    window._idConsentGiven = true;
    window._idConsentTimestamp = new Date().toISOString();
















    document.getElementById("idConsentOverlay")?.classList.add("hidden");
    document.getElementById("idCaptureOverlay")?.classList.remove("hidden");
    startIdCapture();
}
















// ==========================================================================
// ID CAPTURE + OCR MATCHING
// ==========================================================================
function startIdCapture() {
    const video = document.getElementById("idWebcam");
    const statusText = document.getElementById("idCameraStatus");
    statusText.style.color = "";
    statusText.innerText = "Initializing camera...";
















    if (navigator.mediaDevices?.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
            .then((stream) => {
                idVideoStream = stream;
                video.srcObject = stream;
                statusText.innerText = "Position your ID inside the frame, then capture.";
            })
            .catch((err) => {
                console.error("ID camera error:", err);
                statusText.style.color = "#d9534f";
                statusText.innerText = "Camera access denied or unavailable.";
            });
    } else {
        statusText.innerText = "Webcam not supported by this browser.";
    }
}
















function stopIdCamera() {
    if (idVideoStream) {
        idVideoStream.getTracks().forEach((track) => track.stop());
        idVideoStream = null;
    }
}
















async function captureIdPhoto() {
    if (!window._idConsentGiven) {
        alert("Kailangan munang tanggapin ang Data Privacy Notice.");
        return;
    }
















    const video = document.getElementById("idWebcam");
    const canvas = document.getElementById("idPhotoCanvas");
    const context = canvas.getContext("2d");
    const statusText = document.getElementById("idCameraStatus");
    const captureBtn = document.getElementById("captureIdBtn");
















    if (!idVideoStream || video.videoWidth === 0) {
        statusText.style.color = "#d9534f";
        statusText.innerText = "No camera feed detected. Please allow camera access.";
        return;
    }
















    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
















    canvas.toBlob(async (blob) => {
        capturedIdBlob = blob;
        stopIdCamera();
        captureBtn.classList.add("hidden");
        statusText.innerText = "Reading ID... please wait.";
















        try {
            const { data: { text } } = await Tesseract.recognize(canvas.toDataURL("image/png"), "eng");
            handleOcrResult(text);
        } catch (err) {
            console.error("OCR error:", err);
            statusText.style.color = "#d9534f";
            statusText.innerText = "Could not read the ID. Please retake.";
            captureBtn.classList.remove("hidden");
        }
    }, "image/png");
}
















function normalizeText(str) {
    return str.toUpperCase().replace(/[^A-Z\s]/g, " ").replace(/\s+/g, " ").trim();
}
















function handleOcrResult(rawText) {
    const statusText = document.getElementById("idCameraStatus");
    const resultBox = document.getElementById("idResultBox");
    const matchStatus = document.getElementById("idMatchStatus");
    const extractedTextEl = document.getElementById("idExtractedText");
    const actionButtons = document.getElementById("idActionButtons");
















    const normalizedOcr = normalizeText(rawText);
    const firstName = normalizeText(tempUser?.firstName || "");
    const lastName = normalizeText(tempUser?.lastName || "");
















    const firstNameMatch = firstName && normalizedOcr.includes(firstName);
    const lastNameMatch = lastName && normalizedOcr.includes(lastName);
    const isMatch = firstNameMatch && lastNameMatch;
















    statusText.innerText = "";
    resultBox.classList.remove("hidden");
    actionButtons.classList.remove("hidden");
















    if (isMatch) {
        matchStatus.style.color = "#4cae4c";
        matchStatus.innerText = "✅ Matched — name found on ID.";
    } else if (firstNameMatch || lastNameMatch) {
        matchStatus.style.color = "#e0a800";
        matchStatus.innerText = "⚠️ Partial match — please check ID clarity or retake.";
    } else {
        matchStatus.style.color = "#d9534f";
        matchStatus.innerText = "❌ No match found — please retake with better lighting.";
    }
















    extractedTextEl.innerText = "Detected text: " + (rawText.trim() || "(none)");
    window._idVerified = isMatch;
}
















function retakeIdPhoto() {
    capturedIdBlob = null;
    document.getElementById("idResultBox").classList.add("hidden");
    document.getElementById("idActionButtons").classList.add("hidden");
    document.getElementById("captureIdBtn").classList.remove("hidden");
    startIdCapture();
}
















function confirmIdAndProceed() {
    document.getElementById("idCaptureOverlay").classList.add("hidden");
    document.getElementById("setMpinOverlay").classList.remove("hidden");
}
















// ==========================================================================
// HASH HELPER — hindi natin isa-save ang MPIN nang plain text
// ==========================================================================
async function hashText(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}
















// ==========================================================================
// SAVE ACCOUNT — i-upload ang face image at ID image, i-save ang MPIN hash
// at consent record sa profile
// ==========================================================================
async function saveAccount() {
    const pin = Array.from(document.querySelectorAll(".reg-mpin")).map(i => i.value).join("");
















    if (!/^\d{4}$/.test(pin)) {
        alert("Please enter exactly 4 digits for your MPIN.");
        return;
    }
















    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        alert("Session expired. Please log in again.");
        showForm("login");
        return;
    }
















    const mpinHash = await hashText(pin);
    const updatePayload = { mpin: mpinHash };
















    if (capturedImageBlob) {
        const filePath = `${user.id}/face.png`;
        const { error: uploadError } = await supabase.storage
            .from("face-images")
            .upload(filePath, capturedImageBlob, { upsert: true, contentType: "image/png" });
        if (uploadError) alert("Face image upload failed: " + uploadError.message);
        else updatePayload.face_image_url = filePath;
    }
















    if (capturedIdBlob) {
        const idFilePath = `${user.id}/id.png`;
        const { error: idUploadError } = await supabase.storage
            .from("id-images")
            .upload(idFilePath, capturedIdBlob, { upsert: true, contentType: "image/png" });
        if (idUploadError) alert("ID image upload failed: " + idUploadError.message);
        else updatePayload.id_image_url = idFilePath;
    }
















   if (window._idConsentGiven !== undefined) {
        // BAGO — inalis ang auto id_verified mula sa OCR match. Ang
        // totoong pag-verify ay dapat manggaling lamang sa Admin's
        // "Review ID" approval (setIdVerified sa admin.js), hindi dito.
        updatePayload.id_consent_given = window._idConsentGiven || false;
        updatePayload.id_consent_timestamp = window._idConsentTimestamp || null;
    }












    const { data: profile, error: updateError } = await supabase
        .from("profiles")
        .update(updatePayload)
        .eq("id", user.id)
        .select()
        .single();
















    if (updateError) {
        alert("Could not finish setting up your account: " + updateError.message);
        return;
    }
















    alert("✅ MPIN set successfully!");
    const roleToForward = tempUser?.role || profile.role;
    tempUser = null;
    capturedImageBlob = null;
    capturedIdBlob = null;
    window._idVerified = null;
    window._idConsentGiven = null;
    window._idConsentTimestamp = null;
















    executeSecureRouting(roleToForward);
}
















// ==========================================================================
// LOGIN — Supabase Auth password sign-in
// ==========================================================================
async function handleLogin(e) {
    e.preventDefault();
















    const email = document.getElementById("loginEmail").value.trim().toLowerCase();
    const password = document.getElementById("loginPass").value;
















    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
















    if (error) {
        alert("Login failed: " + error.message);
        return;
    }
















    const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", data.user.id)
        .single();
















    if (profileError || !profile) {
        alert("Hindi makuha ang account profile mo. Makipag-ugnayan sa admin.");
        await supabase.auth.signOut();
        return;
    }
















    if (profile.active === false) {
        alert("Ang account na ito ay na-deactivate. Makipag-ugnayan sa barangay admin.");
        await supabase.auth.signOut();
        return;
    }
















    window._currentProfile = profile;
















    if (!profile.mpin) {
        document.getElementById("formView").classList.add("hidden");
        document.getElementById("setMpinOverlay").classList.remove("hidden");
        return;
    }
















    executeSecureRouting(profile.role);
}
















// ==========================================================================
// MAGIC LINK LOGIN (optional passwordless alternative)
// ==========================================================================
async function handleMagicLink(email) {
    const { error } = await supabase.auth.signInWithOtp({
        email,
       options: { emailRedirectTo: window.location.origin + "/pages/login.html" }
    });
















    if (error) {
        alert("Could not send magic link: " + error.message);
    } else {
        alert("Magic link sent! Check your email.");
    }
}
















// ==========================================================================
// MPIN VALIDATION — compares against the hash stored in profiles
// ==========================================================================
async function verifyMpin() {
    const pin = Array.from(document.querySelectorAll(".mpin-box")).map(i => i.value).join("");
















    if (!/^\d{4}$/.test(pin)) {
        alert("Please enter your 4-digit MPIN.");
        return;
    }
















    const profile = window._currentProfile;
    const enteredHash = await hashText(pin);
















    if (profile && enteredHash === profile.mpin) {
        executeSecureRouting(profile.role);
    } else {
        alert("Wrong MPIN code. Access Denied.");
        document.querySelectorAll(".mpin-box").forEach(i => (i.value = ""));
        document.querySelectorAll(".mpin-box")[0].focus();
    }
}
















// ==========================================================================
// FORGOT MPIN — signs the user out entirely; they log in with password again
// ==========================================================================
async function forgotMpin() {
    if (confirm("Do you want to reset your session? You will need to log in again using your password.")) {
        await supabase.auth.signOut();
        location.reload();
    }
}
















// ==========================================================================
// ROUTING
// ==========================================================================
function executeSecureRouting(role) {
    if (!role) {
        alert("System Error: Configuration role metadata lost.");
        return;
    }
















    const routes = {
    resident: "/pages/resident.html",
    official: "/pages/Baranggayofficial.html",
    responder: "/pages/responder.html",
    admin: "/pages/admin.html"
};
















window.location.href = routes[role.toLowerCase()] || "/pages/resident.html";
}









