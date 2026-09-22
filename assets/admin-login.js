/* ============================================================
   e-Medicare — Admin Portal Login
   Hiwalay na login page para sa admin lamang. Kahit valid ang
   email/password, kung ang role sa `profiles` ay HINDI 'admin',
   tinatanggihan ang access at agad na naka-sign out ulit.

   NOTE: Nakabalot ang lahat sa isang IIFE (self-running function)
   para hindi mag-conflict ang variable na `supabase` kahit anong
   ibang script ang naka-load sa parehong page.
   ============================================================ */
(function(){
    const SUPABASE_URL = "https://szxptfuwkmqwcipxpoym.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_9mabckJnVdJ_Z-9km2T7mQ_c9t_XKiR";
    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    let pendingAdminEmail = null;
let resendCooldownInterval = null;

    function showAdminError(msg){
        const el = document.getElementById('adminAuthError');
        el.textContent = msg;
        el.classList.remove('hidden');
    }
    function clearAdminError(){
        document.getElementById('adminAuthError').classList.add('hidden');
    }
    function setLoading(isLoading){
        const btn = document.getElementById('adminLoginBtn');
        btn.disabled = isLoading;
        btn.textContent = isLoading ? 'Checking credentials…' : 'Sign In';
    }

    document.addEventListener('DOMContentLoaded', async () => {
    const overlay = document.getElementById('adminSessionCheck');

    try{
        const { data: { session } } = await supabase.auth.getSession();
        if(session){
            const { data: profile } = await supabase
                .from('profiles')
                .select('role')
                .eq('id', session.user.id)
                .single();

            if(profile && profile.role === 'admin'){
                window.location.href = '/pages/admin.html';
                return; // huwag na itago overlay, papalit na yung page
            } else {
                await supabase.auth.signOut();
            }
        }
    } finally {
        if(overlay) overlay.classList.add('hidden');
    }
});

let isSubmitting = false;

async function handleAdminLogin(e){
    e.preventDefault();
    if(isSubmitting) return;
    isSubmitting = true;
    clearAdminError();
    setLoading(true);
    
    try{
            const email = document.getElementById('adminEmail').value.trim().toLowerCase();
            const password = document.getElementById('adminPassword').value;

            const { data, error } = await supabase.auth.signInWithPassword({ email, password });

if(error){
    console.error('Supabase login error:', error.message);

    let userMessage = 'Incorrect email or password. Please try again.';
    if(error.message.includes('Email not confirmed')){
        userMessage = 'Please verify your email address before signing in.';
    } else if(error.status === 429){
        userMessage = 'Too many attempts. Please wait a moment and try again.';
    } else if(!navigator.onLine){
        userMessage = 'No internet connection. Please check your network.';
    }

    showAdminError(userMessage);
    return;
}

            const { data: profile, error: profileError } = await supabase
                .from('profiles')
                .select('role, active')
                .eq('id', data.user.id)
                .single();

            if(profileError){
    console.error('Profile fetch error:', profileError.message);
    await supabase.auth.signOut();
    showAdminError('Something went wrong verifying your account. Please try again.');
    return;
}

            if(!profile){
                await supabase.auth.signOut();
                showAdminError('No profile record found for this account.');
                return;
            }

                        if(profile.role !== 'admin'){
                await supabase.auth.signOut();
                showAdminError('Incorrect email or password. Please try again.');
                return;
            }

            if(profile.active === false){
                await supabase.auth.signOut();
                showAdminError('This admin account has been deactivated. Contact another administrator.');
                return;
            }

            await sendOtpAndShowScreen(email);
        }catch(err){

    console.error('Unexpected admin login error:', err);
    showAdminError('Something went wrong. Please try again.');
        }finally{
            setLoading(false);
            isSubmitting = false;
        }
    }

    function togglePasswordVisibility(){
    const input = document.getElementById('adminPassword');
    const icon = document.getElementById('togglePasswordIcon');
    const btn = document.getElementById('togglePasswordBtn');
    const isHidden = input.type === 'password';

    input.type = isHidden ? 'text' : 'password';
    icon.classList.toggle('fa-eye', !isHidden);
    icon.classList.toggle('fa-eye-slash', isHidden);
    btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
}

window.togglePasswordVisibility = togglePasswordVisibility;

    async function sendOtpAndShowScreen(email){
        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: { shouldCreateUser: false }
        });

        if(error){
            console.error('OTP send error:', error.message);
            showAdminError('Could not send verification code. Please try again.');
            return;
        }

        pendingAdminEmail = email;
        document.getElementById('adminLoginCard').classList.add('hidden');
        document.getElementById('adminOtpCard').classList.remove('hidden');
        document.getElementById('adminOtpCode').focus();
        startResendCooldown();
    }

    async function handleOtpVerify(e){
        e.preventDefault();
        const errorEl = document.getElementById('adminOtpError');
        errorEl.classList.add('hidden');

        const btn = document.getElementById('adminOtpBtn');
        const code = document.getElementById('adminOtpCode').value.trim();

        if(!pendingAdminEmail){
            errorEl.textContent = 'Session expired. Please log in again.';
            errorEl.classList.remove('hidden');
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Verifying…';

        try{
            const { error } = await supabase.auth.verifyOtp({
                email: pendingAdminEmail,
                token: code,
                type: 'email'
            });

            if(error){
                console.error('OTP verify error:', error.message);
                errorEl.textContent = 'Invalid or expired code. Please try again.';
                errorEl.classList.remove('hidden');
                return;
            }

            window.location.href = '/pages/admin.html';
        }catch(err){
            console.error('Unexpected OTP verify error:', err);
            errorEl.textContent = 'Something went wrong. Please try again.';
            errorEl.classList.remove('hidden');
        }finally{
            btn.disabled = false;
            btn.textContent = 'Verify Code';
        }
    }

    async function handleResendOtp(e){
        e.preventDefault();
        const link = document.getElementById('resendOtpLink');
        if(link.classList.contains('disabled') || !pendingAdminEmail) return;

        const { error } = await supabase.auth.signInWithOtp({
            email: pendingAdminEmail,
            options: { shouldCreateUser: false }
        });

        if(error){
            console.error('Resend OTP error:', error.message);
            const errorEl = document.getElementById('adminOtpError');
            errorEl.textContent = 'Could not resend code. Please try again.';
            errorEl.classList.remove('hidden');
            return;
        }

        startResendCooldown();
    }

    function startResendCooldown(){
        const link = document.getElementById('resendOtpLink');
        let seconds = 60;
        link.classList.add('disabled');
        link.textContent = `Resend code (${seconds}s)`;

        if(resendCooldownInterval) clearInterval(resendCooldownInterval);
        resendCooldownInterval = setInterval(() => {
            seconds--;
            if(seconds <= 0){
                clearInterval(resendCooldownInterval);
                link.classList.remove('disabled');
                link.textContent = 'Resend code';
            } else {
                link.textContent = `Resend code (${seconds}s)`;
            }
        }, 1000);
    }

    function backToLoginForm(){
        document.getElementById('adminOtpCard').classList.add('hidden');
        document.getElementById('adminLoginCard').classList.remove('hidden');
        document.getElementById('adminOtpCode').value = '';
        document.getElementById('adminOtpError').classList.add('hidden');
        if(resendCooldownInterval) clearInterval(resendCooldownInterval);
        pendingAdminEmail = null;
    }

    window.handleAdminLogin = handleAdminLogin;
    window.handleOtpVerify = handleOtpVerify;
    window.handleResendOtp = handleResendOtp;
    window.backToLoginForm = backToLoginForm;
})();