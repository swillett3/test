// ===== Fill this in once, from your Firebase project =====
// Firebase console → Project settings (gear icon) → General → "Your apps" → Web app → SDK setup and configuration → Config.
// These values are not secret: every web app that uses Firebase ships them. Access is controlled by firestore.rules.
export const FIREBASE_CONFIG = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};

// Google accounts that may open the facilitator console.
// Keep this list identical to the one in firestore.rules: the rules are what actually enforce it.
export const ADMIN_EMAILS = ["sam_willett@berkeley.edu", "amy.chan@berkeley.edu"];

export function isConfigured() {
  return !!FIREBASE_CONFIG.apiKey && !FIREBASE_CONFIG.apiKey.startsWith("PASTE");
}
