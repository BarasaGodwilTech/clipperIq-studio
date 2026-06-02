import { auth, firestore, onAuthStateChanged, loginUser, logoutUser, loginWithGoogle, saveApiKeysToFirebase } from '../js/firebase.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const authBtn = document.getElementById('authBtn');
const authGoogleBtn = document.getElementById('authGoogleBtn');
const logoutBtn = document.getElementById('logoutBtn');
const authError = document.getElementById('authError');
const saveBtn = document.getElementById('saveApiKeysBtn');

authBtn.addEventListener('click', async () => {
  authError.style.display = 'none';
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  try {
    await loginUser(email, password);
  } catch (err) {
    authError.textContent = err.message;
    authError.style.display = 'block';
  }
});

authGoogleBtn.addEventListener('click', async () => {
  authError.style.display = 'none';
  try {
    await loginWithGoogle();
  } catch (err) {
    authError.textContent = err.message;
    authError.style.display = 'block';
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
    document.getElementById('view-login').style.display = 'none';
    document.getElementById('view-admin').style.display = 'block';
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
    document.getElementById('view-admin').style.display = 'none';
    document.getElementById('view-login').style.display = 'block';
    document.body.classList.add('logged-out');
  }
});
