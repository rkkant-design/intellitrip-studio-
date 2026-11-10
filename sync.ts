/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sync between devices through Cloud Firestore, for signed-in users only.
 * Each user's data lives under users/{uid}/ (security rules let nobody else
 * read or write it). The app stays local-first: every change is saved in this
 * browser at once, uploaded a moment later, and changes from other devices
 * arrive live. When the same trip changed on two devices, the newer one wins.
 * Deleted trips leave a small "deleted" marker so an offline device can't
 * bring them back.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Firestore, collection, doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore';
import type { Profile, SavedTrip } from './tripkit';

export type SyncStatus = 'off' | 'connecting' | 'saving' | 'synced' | 'offline' | 'error';

/** One trip as stored in Firestore: the whole trip as JSON, so any shape the plans take is fine. */
export interface RemoteTrip {
  id: string;
  json?: string;
  updatedAt?: number;
  deleted?: boolean;
}

const UPLOAD_DELAY_MS = 1200;
// Firestore documents are capped at 1 MiB; leave room for the other fields.
const MAX_JSON = 900_000;

const stamp = (t: { updatedAt?: number }) => Number(t.updatedAt) || 0;

/** Trips as they should be uploaded: older trips' big base64 cover images stay on the device. */
export function forUpload(t: SavedTrip): string | null {
  let json = JSON.stringify({ ...t, vibeImage: null });
  if (json.length > MAX_JSON) json = JSON.stringify({ ...t, vibeImage: null, history: [] });
  return json.length > MAX_JSON ? null : json;
}

/**
 * Combines this device's trips with the cloud's. For each trip the newer copy wins; a cloud
 * "deleted" marker removes the local copy unless the local one changed after the delete.
 */
export function mergeTrips(local: SavedTrip[], remote: RemoteTrip[]): SavedTrip[] {
  const byId = new Map(local.map((t) => [t.id, t]));
  for (const r of remote) {
    const mine = byId.get(r.id);
    const theirs = stamp(r);
    if (r.deleted) {
      if (mine && stamp(mine) <= theirs) byId.delete(r.id);
      continue;
    }
    if (mine && stamp(mine) >= theirs) continue;
    try {
      const parsed = JSON.parse(r.json || '') as SavedTrip;
      // Keep a cover image this device already has (images aren't uploaded).
      byId.set(r.id, { ...parsed, id: r.id, updatedAt: theirs, vibeImage: parsed.vibeImage ?? mine?.vibeImage ?? null });
    } catch {
      /* a damaged cloud copy never replaces a good local one */
    }
  }
  return [...byId.values()].sort((a, b) => stamp(b) - stamp(a));
}

/**
 * Keeps `archives` and the profile in step with the cloud while a user is signed in.
 * `replaceArchives` must save to this browser too; it is only called with cloud changes.
 */
export function useCloudSync(opts: {
  db: Firestore | null;
  uid: string | null;
  archives: SavedTrip[];
  replaceArchives: (fn: (prev: SavedTrip[]) => SavedTrip[]) => void;
  profile: Profile;
  applyProfile: (p: Profile) => void;
}) {
  const { db, uid, archives, replaceArchives, profile, applyProfile } = opts;
  const [status, setStatus] = useState<SyncStatus>(db && uid ? 'connecting' : 'off');
  const known = useRef(new Map<string, number>()); // trip id -> version the cloud has
  const ready = useRef(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(0);
  const profileSynced = useRef<number | null>(null);

  // Live trips from the cloud.
  useEffect(() => {
    if (!db || !uid) {
      setStatus('off');
      return;
    }
    setStatus('connecting');
    ready.current = false;
    known.current = new Map();
    const unsub = onSnapshot(
      collection(db, 'users', uid, 'trips'),
      { includeMetadataChanges: true },
      (snap) => {
        const remote: RemoteTrip[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RemoteTrip, 'id'>) }));
        for (const r of remote) known.current.set(r.id, stamp(r));
        replaceArchives((prev) => mergeTrips(prev, remote));
        ready.current = true;
        if (!inFlight.current) setStatus(snap.metadata.fromCache ? 'offline' : 'synced');
      },
      (err) => {
        console.error('Sync stopped:', err);
        setStatus('error');
      }
    );
    const pendingTimers = timers.current;
    return () => {
      unsub();
      pendingTimers.forEach(clearTimeout);
      pendingTimers.clear();
    };
  }, [db, uid, replaceArchives]);

  // Upload trips that changed here, a moment after the last change to each.
  useEffect(() => {
    if (!db || !uid || !ready.current) return;
    for (const t of archives) {
      const version = stamp(t);
      if (known.current.has(t.id) && (known.current.get(t.id) ?? 0) >= version) continue;
      clearTimeout(timers.current.get(t.id));
      timers.current.set(t.id, setTimeout(async () => {
        timers.current.delete(t.id);
        const json = forUpload(t);
        if (!json) {
          console.warn(`Trip ${t.id} is too large to sync.`);
          return;
        }
        inFlight.current++;
        setStatus('saving');
        try {
          await setDoc(doc(db, 'users', uid, 'trips', t.id), {
            json, updatedAt: version, deleted: false,
            title: t.plan?.title || t.form?.destination || '', startDate: t.form?.startDate || '',
          });
          known.current.set(t.id, version);
          if (--inFlight.current === 0) setStatus(navigator.onLine === false ? 'offline' : 'synced');
        } catch (err) {
          console.error('Could not save a trip to the cloud:', err);
          inFlight.current--;
          setStatus('error');
        }
      }, UPLOAD_DELAY_MS));
    }
  }, [archives, db, uid]);

  /** Records a delete in the cloud, so other devices drop the trip too. */
  const removeTrip = useCallback(async (id: string) => {
    if (!db || !uid) return;
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    const at = Date.now();
    known.current.set(id, at);
    try {
      await setDoc(doc(db, 'users', uid, 'trips', id), { deleted: true, updatedAt: at, json: '' });
    } catch (err) {
      console.error('Could not record the delete in the cloud:', err);
      setStatus('error');
    }
  }, [db, uid]);

  // The Travellers profile: newer copy wins, checked once at sign-in and saved on every change.
  useEffect(() => {
    if (!db || !uid) return;
    let cancelled = false;
    profileSynced.current = null;
    getDoc(doc(db, 'users', uid, 'meta', 'profile'))
      .then((snap) => {
        if (cancelled) return;
        const remote = snap.exists() ? (snap.data() as { json?: string; updatedAt?: number }) : null;
        if (remote?.json && stamp(remote) > stamp(profile)) {
          try {
            const p = JSON.parse(remote.json) as Profile;
            profileSynced.current = stamp(remote);
            applyProfile({ ...p, updatedAt: stamp(remote) });
            return;
          } catch {
            /* fall through and upload ours */
          }
        }
        profileSynced.current = remote ? stamp(remote) : -1;
      })
      .catch((err) => console.error('Could not read the profile from the cloud:', err));
    return () => { cancelled = true; };
    // Only on sign-in; later changes are pushed by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, uid]);

  useEffect(() => {
    if (!db || !uid || profileSynced.current === null) return;
    if (stamp(profile) <= profileSynced.current) return;
    const version = stamp(profile);
    profileSynced.current = version;
    setDoc(doc(db, 'users', uid, 'meta', 'profile'), { json: JSON.stringify(profile), updatedAt: version })
      .catch((err) => console.error('Could not save the profile to the cloud:', err));
  }, [profile, db, uid]);

  return { status, removeTrip };
}
