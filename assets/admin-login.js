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
        const { data: { session } } = await supabase.auth.getSession();
        if(session){
            const { data: profile } = await supabase
                .from('profiles')
                .select('role')
                .eq('id', session.user.id)
                .single();

            if(profile && profile.role === 'admin'){
                window.location.href = 'admin.html';
            } else {
                await supabase.auth.signOut();
            }
        }
    });

    async function handleAdminLogin(e){
        e.preventDefault();
        clearAdminError();
        setLoading(true);

        try{
            const email = document.getElementById('adminEmail').value.trim().toLowerCase();
            const password = document.getElementById('adminPassword').value;

            const { data, error } = await supabase.auth.signInWithPassword({ email, password });

            if(error){
                showAdminError('Incorrect email or password. (' + error.message + ')');
                return;
            }

            const { data: profile, error: profileError } = await supabase
                .from('profiles')
                .select('role, active')
                .eq('id', data.user.id)
                .single();

            if(profileError){
                console.error('Profile fetch error:', profileError);
                await supabase.auth.signOut();
                showAdminError('Could not verify account: ' + profileError.message);
                return;
            }

            if(!profile){
                await supabase.auth.signOut();
                showAdminError('No profile record found for this account.');
                return;
            }

            if(profile.role !== 'admin'){
                await supabase.auth.signOut();
                showAdminError('Access denied. This portal is for authorized administrators only. (role: ' + profile.role + ')');
                return;
            }

            if(profile.active === false){
                await supabase.auth.signOut();
                showAdminError('This admin account has been deactivated. Contact another administrator.');
                return;
            }

            window.location.href = 'admin.html';
        }catch(err){
            console.error('Unexpected admin login error:', err);
            showAdminError('Unexpected error: ' + err.message);
        }finally{
            setLoading(false);
        }
    }

    window.handleAdminLogin = handleAdminLogin;
})();