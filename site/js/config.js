// ===== Fill this in once, from your Firebase project =====
// Firebase console → Project settings (gear icon) → General → "Your apps" → Web app → SDK setup and configuration → Config.
// These values are not secret: every web app that uses Firebase ships them. Access is controlled by firestore.rules.
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDF86EoDX8UNJ4I7017YSct-dFx9di-guM",
  authDomain: "crisis-simulation-fall-2026.firebaseapp.com",
  projectId: "crisis-simulation-fall-2026",
  storageBucket: "crisis-simulation-fall-2026.firebasestorage.app",
  messagingSenderId: "394938150889",
  appId: "1:394938150889:web:21c7782c21910770e0a578",
};

// Google accounts that may open the facilitator console.
// Keep this list identical to the one in firestore.rules: the rules are what actually enforce it.
export const ADMIN_EMAILS = ["sam_willett@berkeley.edu", "amy.chan@berkeley.edu"];

export function isConfigured() {
  return !!FIREBASE_CONFIG.apiKey && !FIREBASE_CONFIG.apiKey.startsWith("PASTE");
}
