import { auth, firestore, onAuthStateChanged, loginUser, logoutUser, loginWithGoogle, saveApiKeysToFirebase, fetchRedirectResult } from '../js/firebase.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const authBtn = document.getElementById('authBtn');
const authGoogleBtn = document.getElementById('authGoogleBtn');
const logoutBtn = document.getElementById('logoutBtn');
const authError = document.getElementById('authError');
const saveBtn = document.getElementById('saveApiKeysBtn');
const emailInput = document.getElementById('authEmail');
const passwordInput = document.getElementById('authPassword');
const viewLogin = document.getElementById('view-login');
const viewAdmin = document.getElementById('view-admin');

authBtn.addEventListener('click', async () => {
  authError.style.display = 'none';
  const email = (emailInput?.value || '').trim();
  const password = passwordInput?.value || '';
  if (!email || !password) {
    authError.textContent = 'Enter email and password.';
    authError.style.display = 'block';
    return;
  }
  const prevText = authBtn.textContent;
  authBtn.disabled = true;
  authBtn.textContent = 'Signing in…';
  try {
    await loginUser(email, password);
    if (passwordInput) passwordInput.value = '';
  } catch (err) {
    authError.textContent = err && err.message ? err.message : 'Sign-in failed.';
    authError.style.display = 'block';
  } finally {
    authBtn.disabled = false;
    authBtn.textContent = prevText;
  }
});

authGoogleBtn.addEventListener('click', async () => {
  authError.style.display = 'none';
  authGoogleBtn.disabled = true;
  const prevText = authGoogleBtn.textContent;
  authGoogleBtn.textContent = 'Opening Google…';
  try {
    await loginWithGoogle();
  } catch (err) {
    authError.textContent = err.message;
    authError.style.display = 'block';
  } finally {
    authGoogleBtn.disabled = false;
    authGoogleBtn.textContent = prevText;
  }
});

logoutBtn.addEventListener('click', () => logoutUser());

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  try {
    const keys = {
      tiktok_client_key: document.getElementById('tiktokClientKey').value.trim(),
      tiktok_client_secret: document.getElementById('tiktokClientSecret').value.trim(),
      facebook_app_id: document.getElementById('facebookAppId').value.trim(),
      facebook_app_secret: document.getElementById('facebookAppSecret').value.trim(),
      google_client_id: document.getElementById('googleClientId').value.trim(),
      google_client_secret: document.getElementById('googleClientSecret').value.trim(),
    };
    await saveApiKeysToFirebase(keys);
    document.getElementById('saveStatus').style.display = 'block';
    setTimeout(() => document.getElementById('saveStatus').style.display = 'none', 3000);
  } catch (err) {
    alert('Error saving keys: ' + err.message);
  }
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save Global API Keys';
});

onAuthStateChanged(auth, async (user) => {
  if (user) {
    if (viewLogin) viewLogin.style.display = 'none';
    if (viewAdmin) viewAdmin.style.display = 'block';
    document.body.classList.remove('logged-out');
    
    // Load existing keys from Firestore to populate inputs
    try {
      const snap = await getDoc(doc(firestore, "settings", "global_api_keys"));
      if (snap.exists()) {
        const data = snap.data();
        if (data.tiktok_client_key) document.getElementById('tiktokClientKey').value = data.tiktok_client_key;
        if (data.tiktok_client_secret) document.getElementById('tiktokClientSecret').value = data.tiktok_client_secret;
        if (data.facebook_app_id) document.getElementById('facebookAppId').value = data.facebook_app_id;
        if (data.facebook_app_secret) document.getElementById('facebookAppSecret').value = data.facebook_app_secret;
        if (data.google_client_id) document.getElementById('googleClientId').value = data.google_client_id;
        if (data.google_client_secret) document.getElementById('googleClientSecret').value = data.google_client_secret;
      }
    } catch (err) {
      console.warn("Could not fetch API keys on load:", err);
    }
  } else {
    if (viewAdmin) viewAdmin.style.display = 'none';
    if (viewLogin) viewLogin.style.display = 'block';
    document.body.classList.add('logged-out');
  }
});

(async () => {
  try {
    const result = await fetchRedirectResult();
    // If a redirect sign-in just completed, result.user will be set
    if (result && result.user) {
      // Force UI to the admin view quickly; onAuthStateChanged will also run
      if (viewLogin) viewLogin.style.display = 'none';
      if (viewAdmin) viewAdmin.style.display = 'block';
      document.body.classList.remove('logged-out');
    }
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    if (code !== 'auth/no-auth-event') {
      authError.textContent = err.message || 'Google sign-in failed.';
      authError.style.display = 'block';
    }
  }
})();
