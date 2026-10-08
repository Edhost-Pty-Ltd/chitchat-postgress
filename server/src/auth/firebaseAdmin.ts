import { readFileSync } from 'node:fs';
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getEnv } from '../config/env.js';

let app: App | null = null;

function loadServiceAccount(): Record<string, unknown> {
  const env = getEnv();
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as Record<string, unknown>;
  }
  if (env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    return JSON.parse(readFileSync(env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8')) as Record<
      string,
      unknown
    >;
  }
  // loadEnv guarantees one of the two is set, so this is unreachable in practice.
  throw new Error('No Firebase service account configured');
}

/** Lazily initialize the Firebase Admin app (used only to verify ID tokens). */
export function getFirebaseAdmin(): App {
  if (!app) {
    const env = getEnv();
    app =
      getApps()[0] ??
      initializeApp({
        credential: cert(loadServiceAccount() as never),
        projectId: env.FIREBASE_PROJECT_ID,
      });
  }
  return app;
}

export function getAdminAuth(): Auth {
  return getAuth(getFirebaseAdmin());
}
