/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sync between devices through Cloud Firestore, for signed-in users only.
 * Each user's own trips live under users/{uid}/ (security rules let nobody else
 * read or write them). The app stays local-first: every change is saved in this
 * browser at once, uploaded a moment later, and changes from other devices
 * arrive live. When the same trip changed on two devices, the newer one wins.
 * Deleted trips leave a small "deleted" marker so an offline device can't
 * bring them back.
 *
 * A trip planned together with family moves to shared/{tripId}, which only its
 * members can read or change. Family members often edit at the same moment
 * (ticking packing, logging spends), so edits to a shared trip are merged field
 * by field against the last cloud version this phone took in (its "base"),
 * instead of one copy replacing the other.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Firestore, arrayRemove, arrayUnion, collection, deleteField, doc, getDoc, onSnapshot, query, runTransaction,
  setDoc, updateDoc, where,
} from 'firebase/firestore';
import type { Profile, SavedTrip, ShareInfo } from './tripkit';

export type SyncStatus = 'off' | 'connecting' | 'saving' | 'synced' | 'offline' | 'error';

/** One trip as stored in Firestore: the whole trip as JSON, so any shape the plans take is fine. */
export interface RemoteTrip {
  id: string;
  json?: string;
  updatedAt?: number;
  deleted?: boolean;
  moved?: boolean; // a personal copy that moved to shared/ when the trip was shared
  // Shared trips only:
  owner?: string;
  members?: string[];
  names?: Record<string, string>;
  code?: string;
}

const UPLOAD_DELAY_MS = 1200;
const RETRY_MS = 20_000;
// Firestore documents are capped at 1 MiB; leave room for the other fields.
const MAX_JSON = 900_000;

const stamp = (t: { updatedAt?: number }) => Number(t.updatedAt) || 0;
const cloudAt = (t: SavedTrip) => Number(t.cloudAt) || 0;

/** Trips as they should be uploaded: big cover images and this phone's sync bookkeeping stay here. */
export function forUpload(t: SavedTrip): string | null {
  const lean = { ...t, vibeImage: null, share: undefined, cloudAt: undefined };
  let json = JSON.stringify(lean);
  if (json.length > MAX_JSON) json = JSON.stringify({ ...lean, history: [] });
  return json.length > MAX_JSON ? null : json;
}

/**
 * Combines this device's own trips with the cloud's. For each trip the newer copy wins; a cloud
 * "deleted" marker removes the local copy unless the local one changed after the delete.
 */
export function mergeTrips(local: SavedTrip[], remote: RemoteTrip[]): SavedTrip[] {
  const byId = new Map(local.map((t) => [t.id, t]));
  for (const r of remote) {
    if (r.moved) continue; // the trip is now shared; the shared copy is the real one
    const mine = byId.get(r.id);
    if (mine?.share) continue;
    const theirs = stamp(r);
    if (r.deleted) {
      if (mine && stamp(mine) <= theirs) byId.delete(r.id);
      continue;
    }
    if (mine && stamp(mine) >= theirs) continue;
    try {
      const parsed = JSON.parse(r.json || '') as SavedTrip;
      // Keep a cover image this device already has (images aren't uploaded).
      byId.set(r.id, { ...parsed, id: r.id, updatedAt: theirs, share: null, vibeImage: parsed.vibeImage ?? mine?.vibeImage ?? null });
    } catch {
      /* a damaged cloud copy never replaces a good local one */
    }
  }
  return [...byId.values()].sort((a, b) => stamp(b) - stamp(a));
}

// --- merging two people's edits to a shared trip ---

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// A short fingerprint of a value (FNV-1a over its JSON), so merge bases needn't store whole plans.
const hashOf = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${(h >>> 0).toString(36)}.${text.length}`;
};
const fp = (v: unknown) => (v && typeof v === 'object' && '__h' in (v as any) ? (v as any).__h : hashOf(JSON.stringify(v ?? null)));
// Fields merged item by item keep their values; everything else is stored as a fingerprint.
const MERGED_IN_FULL = new Set(['packed', 'today', 'wallet']);

/** The copy of a shared trip kept as the merge base: small, and stamped with the cloud version it is. */
export function compactBase(t: SavedTrip, version: number): SavedTrip {
  const out: Record<string, unknown> = { id: t.id, cloudAt: version };
  for (const [k, v] of Object.entries(t)) {
    if (k === 'id' || k === 'cloudAt' || k === 'share' || k === 'vibeImage' || k === 'updatedAt') continue;
    out[k] = MERGED_IN_FULL.has(k) ? v : { __h: fp(v) };
  }
  return out as unknown as SavedTrip;
}

/** Tick-style maps (packing, Today's done list): each key merged on its own. */
function mergeFlags(base: Record<string, boolean> | undefined, mine: Record<string, boolean> | undefined, theirs: Record<string, boolean> | undefined) {
  const out: Record<string, boolean> = {};
  const m = mine || {};
  const t = theirs || {};
  const o = base || {};
  for (const k of new Set([...Object.keys(m), ...Object.keys(t), ...Object.keys(o)])) {
    const a = Boolean(m[k]);
    const b = Boolean(t[k]);
    // Whichever side changed this tick wins; without a base, ticked on either phone stays ticked.
    const v = a === b ? a : base ? (a !== Boolean(o[k]) ? a : b) : true;
    if (v) out[k] = true;
  }
  return out;
}

function mergeWallet(base: SavedTrip['wallet'], mine: SavedTrip['wallet'], theirs: SavedTrip['wallet']) {
  const o = base || {};
  const a = mine || {};
  const b = theirs || {};
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'expenses') continue;
    const av = (a as any)[k];
    const bv = (b as any)[k];
    out[k] = same(av, bv) || !same(av, (o as any)[k]) ? av : bv;
  }
  // Expenses: everyone's new ones are kept; one deleted on either phone stays deleted.
  const had = new Set((o.expenses || []).map((e) => e.id));
  const inA = new Set((a.expenses || []).map((e) => e.id));
  const inB = new Set((b.expenses || []).map((e) => e.id));
  const all = new Map([...(b.expenses || []), ...(a.expenses || [])].map((e) => [e.id, e]));
  out.expenses = [...all.values()]
    .filter((e) => !(had.has(e.id) && (!inA.has(e.id) || !inB.has(e.id))))
    .sort((x, y) => String(y.at).localeCompare(String(x.at)));
  return out as SavedTrip['wallet'];
}

/**
 * Three-way merge of two edited copies of a shared trip, field by field: a field only one side
 * changed takes that change; when both changed it, ticks and spends are combined and otherwise
 * `mine` (the newer edit) wins. Without a known base, ticks and spends are combined and `mine` wins.
 */
export function merge3(base: SavedTrip | undefined, mine: SavedTrip, theirs: SavedTrip): SavedTrip {
  const out: Record<string, unknown> = { ...mine };
  const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
  for (const k of keys) {
    if (k === 'id' || k === 'updatedAt' || k === 'share' || k === 'vibeImage' || k === 'cloudAt') continue;
    const a = (mine as any)[k];
    const b = (theirs as any)[k];
    if (same(a, b)) continue;
    const o = base ? (base as any)[k] : undefined;
    if (base && fp(a) === fp(o)) { out[k] = b; continue; }
    if (base && fp(b) === fp(o)) continue;
    if (k === 'packed' || k === 'today') out[k] = mergeFlags(o, a, b);
    else if (k === 'wallet') out[k] = mergeWallet(o, a, b);
  }
  return out as unknown as SavedTrip;
}

const shareOf = (r: RemoteTrip): ShareInfo => ({ owner: r.owner || '', members: r.members || [], names: r.names || {}, code: r.code });

/**
 * What one cloud copy of a shared trip does to this phone's copy. Returns the new local trip
 * (null to remove it, undefined for no change) and whether the cloud copy became the new base.
 */
export function decideShared(mine: SavedTrip | undefined, r: RemoteTrip, base: SavedTrip | undefined):
  { to: SavedTrip | null | undefined; newBase?: SavedTrip } {
  if (r.deleted) return { to: mine ? null : undefined }; // the owner deleted it for everyone
  let theirs: SavedTrip;
  try {
    theirs = JSON.parse(r.json || '') as SavedTrip;
  } catch {
    return { to: undefined };
  }
  const share = shareOf(r);
  const v = stamp(r);
  if (!mine) return { to: { ...theirs, id: r.id, updatedAt: v, cloudAt: v, share, vibeImage: null }, newBase: theirs };
  if (v > cloudAt(mine)) {
    // A version from someone else that this phone hasn't taken in yet. A copy from before the
    // trip was shared (another of the owner's devices) has no sync point, so its time decides.
    if (mine.share ? stamp(mine) <= cloudAt(mine) : stamp(mine) <= v) {
      return { to: { ...theirs, id: r.id, updatedAt: v, cloudAt: v, share, vibeImage: mine.vibeImage ?? null }, newBase: theirs };
    }
    // Both phones changed it: keep both sets of edits; the result uploads next.
    const merged = merge3(base, mine, theirs);
    return {
      to: { ...merged, id: r.id, updatedAt: Math.max(Date.now(), v + 1, stamp(mine) + 1), cloudAt: v, share, vibeImage: mine.vibeImage ?? null },
      newBase: theirs,
    };
  }
  if (!same(mine.share, share)) return { to: { ...mine, share } };
  return { to: undefined };
}

/** Applies decided changes to the list, re-applying any edit made here since the decision. */
export function applyShared(prev: SavedTrip[], updates: Map<string, { from?: SavedTrip; to: SavedTrip | null }>): SavedTrip[] {
  const out: SavedTrip[] = [];
  const seen = new Set<string>();
  for (const x of prev) {
    const u = updates.get(x.id);
    if (!u) { out.push(x); continue; }
    seen.add(x.id);
    if (u.to === null) continue;
    if (!u.from || stamp(x) === stamp(u.from)) out.push({ ...u.to, vibeImage: u.to.vibeImage ?? x.vibeImage ?? null });
    else {
      out.push({
        ...merge3(u.from, x, u.to), id: x.id, updatedAt: Math.max(Date.now(), stamp(u.to) + 1, stamp(x) + 1),
        cloudAt: u.to.cloudAt, share: u.to.share, vibeImage: x.vibeImage ?? null,
      });
    }
  }
  for (const [id, u] of updates) if (!seen.has(id) && u.to && !u.from) out.push(u.to);
  return out.sort((a, b) => stamp(b) - stamp(a));
}

const newCode = () => {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** The link that lets family join a shared trip. */
export const inviteLink = (t: SavedTrip) =>
  t.share?.code ? `${window.location.origin}/?join=${encodeURIComponent(t.id)}-${t.share.code}` : '';

/** Reads `?join=<tripId>-<code>` from a link. */
export function parseJoin(search: string): { id: string; code: string } | null {
  const v = new URLSearchParams(search).get('join') || '';
  // Links pasted into chats sometimes pick up a trailing full stop or bracket.
  const m = /^(.+)-([0-9a-f]{18})(?:[^0-9a-f].*)?$/i.exec(v.trim());
  return m ? { id: m[1], code: m[2].toLowerCase() } : null;
}

// Deletes and leaves not yet confirmed by the cloud, kept on the device so they're sent again
// after a restart instead of the trip coming back.
type PendingDelete = 'personal' | 'shared' | 'leave';
const deletesKey = (uid: string) => `intellitrip_pending_deletes_${uid}`;
const loadDeletes = (uid: string): Record<string, PendingDelete> => {
  try {
    return JSON.parse(localStorage.getItem(deletesKey(uid)) || '{}');
  } catch {
    return {};
  }
};
const saveDeletes = (uid: string, d: Record<string, PendingDelete>) => {
  try {
    localStorage.setItem(deletesKey(uid), JSON.stringify(d));
  } catch { /* storage full: the delete is still tried now */ }
};

const basesKey = (uid: string) => `intellitrip_shared_bases_${uid}`;
const loadBases = (uid: string) => {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(basesKey(uid)) || '{}') as Record<string, SavedTrip>));
  } catch {
    return new Map<string, SavedTrip>();
  }
};
const saveBases = (uid: string, bases: Map<string, SavedTrip>) => {
  try {
    localStorage.setItem(basesKey(uid), JSON.stringify(Object.fromEntries(bases)));
  } catch { /* storage full: merges fall back to combining ticks and spends */ }
};

/**
 * Keeps `archives` and the profile in step with the cloud while a user is signed in.
 * `replaceArchives` must save to this browser too; it is only called with cloud changes.
 */
export function useCloudSync(opts: {
  db: Firestore | null;
  uid: string | null;
  name: string;
  archives: SavedTrip[];
  replaceArchives: (fn: (prev: SavedTrip[]) => SavedTrip[]) => void;
  profile: Profile;
  applyProfile: (p: Profile) => void;
}) {
  const { db, uid, name, archives, replaceArchives, profile, applyProfile } = opts;
  const [status, setStatus] = useState<SyncStatus>(db && uid ? 'connecting' : 'off');
  const [retry, setRetry] = useState(0);
  const known = useRef(new Map<string, number>()); // own trip id -> version the cloud has
  const bases = useRef(new Map<string, SavedTrip>()); // shared trip id -> the cloud copy last taken in here
  const sharedIds = useRef(new Set<string>());
  const ready = useRef(false);
  const sharedReady = useRef(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(0);
  const profileSynced = useRef<number | null>(null);
  const archivesRef = useRef(archives);
  archivesRef.current = archives;
  const deletes = useRef<Record<string, PendingDelete>>({});

  const settle = useCallback((fromCache: boolean) => {
    if (!inFlight.current) setStatus(fromCache || navigator.onLine === false ? 'offline' : 'synced');
  }, []);

  // Live trips from the cloud: this person's own, and the ones shared with them.
  useEffect(() => {
    if (!db || !uid) {
      setStatus('off');
      return;
    }
    setStatus('connecting');
    ready.current = false;
    sharedReady.current = false;
    known.current = new Map();
    bases.current = loadBases(uid);
    deletes.current = loadDeletes(uid);
    sharedIds.current = new Set();

    const unsubMine = onSnapshot(
      collection(db, 'users', uid, 'trips'),
      { includeMetadataChanges: true },
      (snap) => {
        const remote = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<RemoteTrip, 'id'>) }))
          .filter((r) => !sharedIds.current.has(r.id) && !deletes.current[r.id]);
        for (const r of remote) if (!r.moved) known.current.set(r.id, stamp(r));
        replaceArchives((prev) => mergeTrips(prev, remote));
        if (!ready.current) setRetry((n) => n + 1); // send deletes left over from last time
        ready.current = true;
        settle(snap.metadata.fromCache);
      },
      (err) => {
        console.error('Sync stopped:', err);
        setStatus('error');
      }
    );

    const unsubShared = onSnapshot(
      query(collection(db, 'shared'), where('members', 'array-contains', uid)),
      { includeMetadataChanges: true },
      (snap) => {
        const remote = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<RemoteTrip, 'id'>) })).filter((r) => !deletes.current[r.id]);
        sharedIds.current = new Set(remote.map((r) => r.id));
        const local = new Map(archivesRef.current.map((t) => [t.id, t]));
        const updates = new Map<string, { from?: SavedTrip; to: SavedTrip | null }>();
        for (const r of remote) {
          const mine = local.get(r.id);
          // A base only counts for the version this phone last took in; otherwise ticks and spends are combined.
          const b = bases.current.get(r.id);
          const base = b && mine && cloudAt(b) === cloudAt(mine) ? b : undefined;
          const { to, newBase } = decideShared(mine, r, base);
          if (to !== undefined) updates.set(r.id, { from: mine, to });
          if (newBase) bases.current.set(r.id, compactBase(newBase, stamp(r)));
          if (r.deleted) bases.current.delete(r.id);
        }
        // A shared trip the cloud no longer lists for us: we left, or the owner removed us.
        if (!snap.metadata.fromCache) {
          for (const t of local.values()) {
            if (t.share && !sharedIds.current.has(t.id)) {
              updates.set(t.id, { from: t, to: null });
              bases.current.delete(t.id);
            }
          }
          if (!sharedReady.current) setRetry((n) => n + 1); // upload shared edits made offline earlier
          sharedReady.current = true;
        }
        saveBases(uid, bases.current);
        if (updates.size) replaceArchives((prev) => applyShared(prev, updates));
        settle(snap.metadata.fromCache);
      },
      (err) => {
        // Refused until the rules for shared trips are published; personal sync carries on.
        console.error('Shared trips sync stopped:', err);
      }
    );

    const pendingTimers = timers.current;
    return () => {
      unsubMine();
      unsubShared();
      pendingTimers.forEach(clearTimeout);
      pendingTimers.clear();
    };
  }, [db, uid, replaceArchives, settle]);

  // Back online: try anything that failed to upload.
  useEffect(() => {
    const on = () => setRetry((n) => n + 1);
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, []);

  /** Saves a shared trip, folding in anyone else's edits saved since this phone last took one in. */
  const uploadShared = useCallback(async (t: SavedTrip) => {
    if (!db || !uid) return;
    const ref = doc(db, 'shared', t.id);
    let result: SavedTrip = t;
    let theirs: SavedTrip | null = null;
    let version = 0;
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const r = snap.exists() ? (snap.data() as RemoteTrip) : null;
      if (!r || r.deleted) throw Object.assign(new Error('This shared trip no longer exists.'), { code: 'gone' });
      result = t;
      theirs = null;
      if (stamp(r) > cloudAt(t)) {
        try {
          theirs = JSON.parse(r.json || '') as SavedTrip;
          const b = bases.current.get(t.id);
          result = merge3(b && cloudAt(b) === cloudAt(t) ? b : undefined, t, theirs);
        } catch { /* their copy is unreadable; ours stands */ }
      }
      version = Math.max(stamp(t), stamp(r) + 1);
      const json = forUpload(result);
      if (!json) throw Object.assign(new Error('Trip is too large to sync.'), { code: 'too-large' });
      tx.update(ref, { json, updatedAt: version, title: t.plan?.title || t.form?.destination || '', startDate: t.form?.startDate || '' });
    });
    bases.current.set(t.id, compactBase(result, version));
    saveBases(uid, bases.current);
    const to: SavedTrip = { ...result, id: t.id, updatedAt: version, cloudAt: version, share: t.share };
    replaceArchives((prev) => applyShared(prev, new Map([[t.id, { from: t, to }]])));
  }, [db, uid, replaceArchives]);

  /** Sends one delete or leave to the cloud; it stays on the device's list until the cloud confirms it. */
  const sendDelete = useCallback(async (id: string, kind: PendingDelete) => {
    if (!db || !uid) return;
    const at = Date.now();
    try {
      if (kind === 'leave') {
        await updateDoc(doc(db, 'shared', id), { members: arrayRemove(uid), [`names.${uid}`]: deleteField() });
      } else if (kind === 'shared') {
        await updateDoc(doc(db, 'shared', id), { deleted: true, json: '', updatedAt: at });
      } else {
        await setDoc(doc(db, 'users', uid, 'trips', id), { deleted: true, updatedAt: at, json: '' });
      }
      delete deletes.current[id];
      saveDeletes(uid, deletes.current);
    } catch (err: any) {
      // Already gone, or no longer ours to change: nothing left to send.
      if (err?.code === 'not-found' || err?.code === 'permission-denied') {
        delete deletes.current[id];
        saveDeletes(uid, deletes.current);
        return;
      }
      console.error('Could not record the delete in the cloud:', err);
      setStatus(navigator.onLine === false ? 'offline' : 'error');
    }
  }, [db, uid]);

  const flushDeletes = useCallback(() => {
    for (const [id, kind] of Object.entries(deletes.current)) sendDelete(id, kind);
  }, [sendDelete]);

  // Upload trips that changed here, a moment after the last change to each.
  useEffect(() => {
    if (!db || !uid || !ready.current) return;
    flushDeletes();
    for (const t of archives) {
      const version = stamp(t);
      const upToDate = t.share ? cloudAt(t) >= version : known.current.has(t.id) && (known.current.get(t.id) ?? 0) >= version;
      // A waiting upload of an older copy must not fire once this copy is already in the cloud.
      if (upToDate || (t.share && !sharedReady.current)) {
        if (upToDate) { clearTimeout(timers.current.get(t.id)); timers.current.delete(t.id); }
        continue;
      }
      clearTimeout(timers.current.get(t.id));
      timers.current.set(t.id, setTimeout(async () => {
        timers.current.delete(t.id);
        // Only the newest copy goes up; a newer edit has its own upload waiting.
        const latest = archivesRef.current.find((x) => x.id === t.id);
        if (!latest || stamp(latest) !== version || Boolean(latest.share) !== Boolean(t.share)) return;
        const json = forUpload(t);
        if (!json) {
          console.warn(`Trip ${t.id} is too large to sync.`);
          return;
        }
        inFlight.current++;
        setStatus('saving');
        try {
          if (t.share) {
            await uploadShared(t);
          } else {
            await setDoc(doc(db, 'users', uid, 'trips', t.id), {
              json, updatedAt: version, deleted: false,
              title: t.plan?.title || t.form?.destination || '', startDate: t.form?.startDate || '',
            });
            known.current.set(t.id, version);
          }
          if (--inFlight.current === 0) setStatus(navigator.onLine === false ? 'offline' : 'synced');
        } catch (err: any) {
          inFlight.current--;
          if (err?.code === 'gone' || err?.code === 'permission-denied' || err?.code === 'too-large') {
            console.warn('Shared trip not saved:', err?.message);
            if (!inFlight.current) setStatus('synced');
            return;
          }
          console.error('Could not save a trip to the cloud:', err);
          setStatus(navigator.onLine === false || err?.code === 'unavailable' ? 'offline' : 'error');
          setTimeout(() => setRetry((n) => n + 1), RETRY_MS);
        }
      }, UPLOAD_DELAY_MS));
    }
  }, [archives, db, uid, retry, uploadShared, flushDeletes]);

  /** Deletes a trip everywhere: the owner of a shared trip deletes it for everyone; a member leaves it. */
  const removeTrip = useCallback(async (t: SavedTrip) => {
    if (!db || !uid) return;
    clearTimeout(timers.current.get(t.id));
    timers.current.delete(t.id);
    known.current.set(t.id, Date.now());
    const kind: PendingDelete = t.share ? (t.share.owner !== uid ? 'leave' : 'shared') : 'personal';
    deletes.current[t.id] = kind;
    saveDeletes(uid, deletes.current);
    bases.current.delete(t.id);
    saveBases(uid, bases.current);
    await sendDelete(t.id, kind);
  }, [db, uid, sendDelete]);

  /** Starts planning a trip together: moves it to shared/ with this person as owner. */
  const shareTrip = useCallback(async (t: SavedTrip) => {
    if (!db || !uid) throw new Error('Sign in with Google to plan together.');
    if (navigator.onLine === false) throw new Error('You need a connection to start sharing.');
    const json = forUpload(t);
    if (!json) throw new Error('This trip is too large to share.');
    const at = Math.max(Date.now(), stamp(t) + 1);
    const share: ShareInfo = { owner: uid, members: [uid], names: { [uid]: name }, code: newCode() };
    clearTimeout(timers.current.get(t.id));
    timers.current.delete(t.id);
    try {
      await setDoc(doc(db, 'shared', t.id), {
        ...share, json, updatedAt: at, deleted: false, title: t.plan?.title || t.form?.destination || '', startDate: t.form?.startDate || '',
      });
    } catch (err: any) {
      if (err?.code === 'permission-denied') throw new Error("Sharing isn't switched on yet: the new Firestore rules need publishing.");
      throw err;
    }
    bases.current.set(t.id, compactBase(JSON.parse(json) as SavedTrip, at));
    saveBases(uid, bases.current);
    sharedIds.current.add(t.id);
    replaceArchives((prev) => prev.map((x) => (x.id === t.id ? { ...x, share, updatedAt: Math.max(stamp(x), at), cloudAt: at } : x)));
    // The personal copy steps aside, so this person's other devices follow the shared one.
    await setDoc(doc(db, 'users', uid, 'trips', t.id), { moved: true, deleted: true, json: '', updatedAt: at });
    return share;
  }, [db, uid, name, replaceArchives]);

  /** Joins a shared trip from an invite link. */
  /** Joins a shared trip from an invite link. Returns 'member' when this person is already on it. */
  const joinTrip = useCallback(async (id: string, code: string): Promise<'joined' | 'member'> => {
    if (!db || !uid) throw new Error('Sign in with Google to join.');
    // Your own trip, or one you've already joined: just open it.
    if (archivesRef.current.some((t) => t.id === id && t.share?.members.includes(uid))) return 'member';
    try {
      await updateDoc(doc(db, 'shared', id), { members: arrayUnion(uid), [`names.${uid}`]: name, [`join.${uid}`]: code });
      return 'joined';
    } catch (err: any) {
      if (err?.code === 'permission-denied' || err?.code === 'not-found') {
        throw new Error("Couldn't join: the link is out of date, the trip already has 12 people, or it was deleted. Ask for a new link.");
      }
      throw new Error('Could not join the trip. Check your connection and open the link again.');
    }
  }, [db, uid, name]);

  /** Owner only: makes a new invite link (the old one stops working), optionally removing someone. */
  const resetInvite = useCallback(async (t: SavedTrip, removeUid?: string) => {
    if (!db || !uid || !t.share) return;
    const patch: Record<string, unknown> = { code: newCode() };
    if (removeUid) {
      patch.members = arrayRemove(removeUid);
      patch[`names.${removeUid}`] = deleteField();
    }
    await updateDoc(doc(db, 'shared', t.id), patch);
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

  return { status, removeTrip, shareTrip, joinTrip, resetInvite };
}
