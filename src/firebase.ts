import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut as fbSignOut } from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer,
  setDoc,
  serverTimestamp,
  collection,
  addDoc,
} from 'firebase/firestore';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { getMessaging, getToken, isSupported as isMessagingSupported } from 'firebase/messaging';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const storage = getStorage(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

export async function signInWithGoogleFirebase() {
  const provider = new GoogleAuthProvider();
  const credential = await signInWithPopup(auth, provider);
  const idToken = await credential.user.getIdToken();

  // Mirror verified user profile into Firestore following Eight Pillars schema
  if (credential.user.emailVerified) {
    const uid = credential.user.uid;
    const userPath = `users/${uid}`;
    const privatePath = `users_private/${uid}`;
    const username = (credential.user.email?.split('@')[0] || `user_${uid.slice(0, 6)}`)
      .toLowerCase()
      .replace(/[^a-z0-9_.]/g, '_')
      .slice(0, 32);

    try {
      await setDoc(
        doc(db, 'users', uid),
        {
          uid,
          username: username.length >= 3 ? username : `u_${username}`,
          displayName: (credential.user.displayName || username).slice(0, 64),
          bio: 'Available on Bazooka Chat',
          avatarUrl: (credential.user.photoURL || '').slice(0, 500),
          role: 'user',
          isBanned: false,
          isOnline: true,
          lastSeen: serverTimestamp(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (err) {
      // Ignore if profile already exists with protected fields; log otherwise
      console.warn('Firestore profile sync skipped or constrained:', userPath, err);
    }

    try {
      await setDoc(
        doc(db, 'users_private', uid),
        {
          uid,
          email: (credential.user.email || '').slice(0, 254),
          notificationsEnabled: true,
          language: 'en',
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, privatePath);
    }
  }

  return { user: credential.user, idToken };
}

export async function signOutFirebase() {
  try {
    if (auth.currentUser) {
      await fbSignOut(auth);
    }
  } catch {
    // ignore
  }
}

export async function syncReportToFirestore(payload: {
  id: string;
  targetType: 'user' | 'group' | 'message';
  targetId: string;
  targetName: string;
  reason: string;
}) {
  if (!auth.currentUser || !auth.currentUser.emailVerified) return;
  const path = `reports/${payload.id}`;
  try {
    await setDoc(doc(db, 'reports', payload.id), {
      id: payload.id,
      reporterId: auth.currentUser.uid,
      targetType: payload.targetType,
      targetId: payload.targetId,
      targetName: payload.targetName.slice(0, 80),
      reason: payload.reason.slice(0, 500),
      status: 'open',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function uploadToFirebaseStorageIfAvailable(file: File): Promise<string | null> {
  if (!auth.currentUser) return null;
  try {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileRef = storageRef(storage, `media/${auth.currentUser.uid}/${Date.now()}_${safeName}`);
    await uploadBytes(fileRef, file);
    return await getDownloadURL(fileRef);
  } catch {
    return null;
  }
}

export async function requestFcmTokenIfSupported(): Promise<string | null> {
  try {
    const supported = await isMessagingSupported();
    if (!supported) return null;
    const messaging = getMessaging(app);
    const token = await getToken(messaging);
    return token || null;
  } catch {
    return null;
  }
}

export { collection, addDoc };
