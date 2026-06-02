import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { db as localDb } from "./storage/db.js";

// TODO: Replace with your actual Firebase project configuration
const firebaseConfig = {
  apiKey: "AIzaSyAGOdj5KjOiespwIm4uy2CR25CLVI3JP9s",
  authDomain: "clipperiq-da448.firebaseapp.com",
  projectId: "clipperiq-da448",
  storageBucket: "clipperiq-da448.firebasestorage.app",
  messagingSenderId: "970532047088",
  appId: "1:970532047088:web:81f33d1d10779ec5da1a35"
};


// The email address that has Super Admin privileges (can save API keys)
export const SUPER_ADMIN_EMAIL = "barasagodwil@gmail.com";

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const firestore = getFirestore(app);

/**
 * Sync global API keys from Firestore to local IndexedDB
 */
export async function syncApiKeysFromFirebase() {
  try {
    const keysRef = doc(firestore, "settings", "global_api_keys");
    const snap = await getDoc(keysRef);
    if (snap.exists()) {
      const keys = snap.data();
      // keys is an object like { tiktok_client_key: "...", google_client_id: "..." }
      for (const [key, value] of Object.entries(keys)) {
        if (value) {
          await localDb.setSetting(key, value);
        }
      }
      console.log("[Firebase] API keys synced successfully.");
    } else {
      console.log("[Firebase] No global API keys found in Firestore.");
    }
  } catch (error) {
    console.error("[Firebase] Error syncing API keys:", error);
  }
}

/**
 * Save API keys to Firestore (Super Admin only)
 */
export async function saveApiKeysToFirebase(keysObject) {
  try {
    const user = auth.currentUser;
    if (!user || user.email !== SUPER_ADMIN_EMAIL) {
      throw new Error("Unauthorized: Only Super Admin can save API keys.");
    }
    const keysRef = doc(firestore, "settings", "global_api_keys");
    await setDoc(keysRef, keysObject, { merge: true });
    console.log("[Firebase] API keys saved to Firestore successfully.");
    return true;
  } catch (error) {
    console.error("[Firebase] Error saving API keys:", error);
    throw error;
  }
}

export function loginUser(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function registerUser(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

export function logoutUser() {
  return signOut(auth);
}

export function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider);
}

export { onAuthStateChanged };
