/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  type FormState, type Profile, type SavedTrip, type Packing, type Plan,
  BookByCard, LeaveCard, PackingCard, PENDING_KEY, PlanView, STORAGE_KEY, TravellersCard,
  claimDevice, emptyForm, fromTripKit, loadProfile, mmss, normaliseSaved, saveProfile, startJob, store, waitForJob, arr, endDateOf,
} from './tripkit';
import { type Checks, checkPlan, placesIn } from './placecheck';
import { ShareSheet } from './share';
import { TripMap } from './tripmap';
import { TodayView, dayOnDate, tripToday } from './today';
import { TogetherSection } from './together';
import { InstallCard, useInstall } from './install';
import { AccountMenu, Logo, MainTabs } from './chrome';
import { AppCrashed, SafeArea } from './safety';
import { LandingPage, SampleView } from './landing';
import { WalletCard } from './wallet';
import { RemindersCard, RemindersSheet } from './reminders';
import { RoadRulesCard } from './roadcheck';
import { type PendingChange, type Scope, ChangeBanner, ChangeSheet, PENDING_CHANGE_KEY, applyChange, needsWholeTrip, undoChange } from './revise';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  onAuthStateChanged,
  type Auth,
} from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { type SyncStatus, parseJoin, useCloudSync } from './sync';

// Installed-app support: the service worker lets the app open offline. Production builds only,
// so local development always runs the latest code.
if ('serviceWorker' in navigator && (import.meta as any).env?.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Offline support unavailable:', e));
  });
}

// An invite link (?join=...) is remembered through sign-in, then the link is tidied away.
const JOIN_KEY = 'intellitrip_join';
{
  const join = parseJoin(window.location.search);
  if (join) {
    store.set(JOIN_KEY, join);
    const url = new URL(window.location.href);
    url.searchParams.delete('join');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
}

// --- FIREBASE AUTH (activates only when config env vars are present) ---
// All values below are public client config (safe in the browser), supplied as
// VITE_FIREBASE_* env vars. When absent, the app falls back to the simple
// name-only login so nothing breaks before Firebase is provisioned.
const env = (import.meta as any).env ?? {};
const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};
const firebaseEnabled = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
let auth: Auth | null = null;
let firestore: Firestore | null = null;
if (firebaseEnabled) {
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    firestore = getFirestore(app);
  } catch (e) {
    console.error('Firebase init failed:', e);
  }
}

interface AppUser {
  name: string;
  email?: string;
  photo?: string;
  uid?: string; // set when signed in with Google; turns on sync
  getToken?: () => Promise<string | null>;
}

const SYNC_LABEL: Record<SyncStatus, string> = {
  off: '', connecting: 'Connecting…', saving: 'Saving…', synced: 'Synced to your Google account', offline: 'Offline: saved on this phone, syncs later', error: 'Sync problem: saved on this device, will retry',
};

// --- TYPES ---

type ActiveTab = 'planner' | 'today' | 'archives' | 'toolkit';

interface PendingPlan {
  jobId: string;
  form: FormState;
  startedAt: number;
}

// --- UTILITIES ---

const loadArchives = (): SavedTrip[] => {
  const raw = store.get<unknown[]>(STORAGE_KEY, []);
  return (Array.isArray(raw) ? raw : []).map(normaliseSaved).filter((t): t is SavedTrip => t !== null);
};

// --- COMPONENTS ---

const LoadingStage = ({ destination, seconds }: { destination: string; seconds: number }) => {
  const messages = [
    'Mapping the best routes...',
    'Finding food stops on the way...',
    'Hunting for hidden gems...',
    'Checking weather and closures...',
    'Planning each day...',
  ];
  const [msg, setMsg] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setMsg((m) => (m + 1) % messages.length), 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="loading-container" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true"></div>
      <h3>{messages[msg]}</h3>
      <p>Building your journey to {destination} · <span className="tk-mono">{mmss(seconds)}</span></p>
      <p className="tk-dim tk-small">Usually 2–5 minutes. You can switch tabs or close this page: the trip is saved to My trips when it's ready.</p>
    </div>
  );
};

const Toast = ({ message }: { message: string }) => (
  <div className="toast" role="status" aria-live="polite">
    {message}
  </div>
);

// --- LIVE WEATHER (Open-Meteo: free, keyless, CORS-friendly) ---

interface DailyWeather {
  date: string;
  code: number;
  tMax: number;
  tMin: number;
  precip: number;
}

const WMO: Record<number, { icon: string; label: string }> = {
  0: { icon: '☀️', label: 'Clear' },
  1: { icon: '🌤️', label: 'Mainly clear' },
  2: { icon: '⛅', label: 'Partly cloudy' },
  3: { icon: '☁️', label: 'Overcast' },
  45: { icon: '🌫️', label: 'Fog' },
  48: { icon: '🌫️', label: 'Rime fog' },
  51: { icon: '🌦️', label: 'Light drizzle' },
  53: { icon: '🌦️', label: 'Drizzle' },
  55: { icon: '🌦️', label: 'Dense drizzle' },
  61: { icon: '🌧️', label: 'Light rain' },
  63: { icon: '🌧️', label: 'Rain' },
  65: { icon: '🌧️', label: 'Heavy rain' },
  71: { icon: '🌨️', label: 'Light snow' },
  73: { icon: '❄️', label: 'Snow' },
  75: { icon: '❄️', label: 'Heavy snow' },
  80: { icon: '🌦️', label: 'Rain showers' },
  81: { icon: '🌧️', label: 'Showers' },
  82: { icon: '⛈️', label: 'Violent showers' },
  95: { icon: '⛈️', label: 'Thunderstorm' },
  96: { icon: '⛈️', label: 'Storm + hail' },
  99: { icon: '⛈️', label: 'Severe storm' },
};

const describeWeather = (code: number) => WMO[code] ?? { icon: '🌡️', label: '—' };

const dayLabel = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });

const WeatherTracker = ({ destination }: { destination: string }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState<string>('');
  const [days, setDays] = useState<DailyWeather[]>([]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!destination.trim()) return;
      setLoading(true);
      setError(null);
      try {
        const geoRes = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(destination)}&count=1&language=en&format=json`
        );
        const geo = await geoRes.json();
        const loc = geo?.results?.[0];
        if (!loc) throw new Error(`Couldn't locate "${destination}" for a forecast.`);

        const params = new URLSearchParams({
          latitude: String(loc.latitude),
          longitude: String(loc.longitude),
          daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
          timezone: 'auto',
          forecast_days: '7',
        });
        const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
        const w = await wRes.json();
        const times: string[] = w?.daily?.time ?? [];
        const parsed: DailyWeather[] = times.map((date, i) => ({
          date,
          code: w.daily.weather_code[i],
          tMax: Math.round(w.daily.temperature_2m_max[i]),
          tMin: Math.round(w.daily.temperature_2m_min[i]),
          precip: w.daily.precipitation_probability_max?.[i] ?? 0,
        }));
        if (!cancelled) {
          setPlace(`${loc.name}${loc.country ? ', ' + loc.country : ''}`);
          setDays(parsed);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Weather is currently unavailable.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [destination]);

  const today = days[0];

  return (
    <div className="card weather-card">
      <div className="weather-head">
        <h3>Weather</h3>
        {place && <span className="weather-place">{place}</span>}
      </div>

      {loading && <p className="weather-status">Fetching current conditions…</p>}
      {error && !loading && <p className="weather-status weather-error">{error}</p>}

      {!loading && !error && today && (
        <>
          <div className="weather-now">
            <span className="weather-now-icon" aria-hidden="true">{describeWeather(today.code).icon}</span>
            <div className="weather-now-info">
              <strong>{today.tMax}° / {today.tMin}°C</strong>
              <span>{describeWeather(today.code).label} · {today.precip}% precip.</span>
            </div>
          </div>
          <div className="weather-forecast">
            {days.slice(0, 7).map((d) => (
              <div key={d.date} className="weather-day" title={describeWeather(d.code).label}>
                <span className="wd-label">{dayLabel(d.date)}</span>
                <span className="wd-icon" aria-hidden="true">{describeWeather(d.code).icon}</span>
                <span className="wd-temp">{d.tMax}°</span>
                <span className="wd-min">{d.tMin}°</span>
                {d.precip >= 30 && <span className="wd-precip">💧{d.precip}%</span>}
              </div>
            ))}
          </div>
          <p className="weather-note">7-day outlook (needs signal).</p>
        </>
      )}
    </div>
  );
};

// --- MAIN DASHBOARD ---

const Dashboard: React.FC<{ user: AppUser; onLogout: () => void; onSample: () => void }> = ({ user, onLogout, onSample }) => {
  // A trip happening today opens straight into Today mode.
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => (tripToday(loadArchives()) ? 'today' : 'planner'));
  const [todayId, setTodayId] = useState<string | null>(() => tripToday(loadArchives())?.id ?? null);
  const { canInstall, install } = useInstall();
  const [profile, setProfile] = useState<Profile>(loadProfile);
  const [form, setForm] = useState<FormState>(() => emptyForm(loadProfile()));
  const [pending, setPending] = useState<PendingPlan | null>(() => store.get<PendingPlan | null>(PENDING_KEY, null));
  const [seconds, setSeconds] = useState(0);
  const [trip, setTrip] = useState<SavedTrip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archives, setArchives] = useState<SavedTrip[]>(loadArchives);
  const [toast, setToast] = useState<string | null>(null);
  const [packBusy, setPackBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [checking, setChecking] = useState<{ tripId: string; done: number; total: number } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [reminding, setReminding] = useState(false);
  const [changeScope, setChangeScope] = useState<Scope | null>(null); // the Change sheet is open
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(() => store.get<PendingChange | null>(PENDING_CHANGE_KEY, null));
  const [changeSeconds, setChangeSeconds] = useState(0);
  const [changeText, setChangeText] = useState('');
  const [noticesRun, setNoticesRun] = useState<{ tripId: string; seconds: number } | null>(null);
  const archivesRef = useRef<SavedTrip[]>([]);
  const checkingRef = useRef<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2800);
  }, []);

  const getHeaders = useCallback(async () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (user.getToken) {
      const token = await user.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }, [user]);

  const persistArchives = useCallback((updated: SavedTrip[]) => {
    // Base64 hero images from older trips are large; if we hit the storage quota,
    // retry without them rather than losing the save entirely.
    if (store.set(STORAGE_KEY, updated)) return updated;
    const lean = updated.map((t) => ({ ...t, vibeImage: null }));
    if (store.set(STORAGE_KEY, lean)) return lean;
    showToast('Storage is full. Delete an old trip from My trips and try again.');
    return null;
  }, [showToast]);

  // Saves a new or changed trip and keeps the open trip in sync.
  const upsertTrip = useCallback((changed: SavedTrip) => {
    const t = { ...changed, updatedAt: Date.now() };
    setArchives((prev) => {
      const next = [t, ...prev.filter((x) => x.id !== t.id)];
      return persistArchives(next) ?? prev;
    });
    setTrip((cur) => (cur && cur.id === t.id ? t : cur));
  }, [persistArchives]);

  // Changes some fields of a saved trip, starting from its latest saved version.
  const patchTrip = useCallback((id: string, patch: Partial<SavedTrip>) => {
    setArchives((prev) => {
      const current = prev.find((x) => x.id === id);
      if (!current) return prev;
      const next = prev.map((x) => (x.id === id ? { ...current, ...patch, updatedAt: Date.now() } : x));
      return persistArchives(next) ?? prev;
    });
    setTrip((cur) => (cur && cur.id === id ? { ...cur, ...patch, updatedAt: Date.now() } : cur));
  }, [persistArchives]);

  archivesRef.current = archives;

  // Cloud sync (signed-in users only). Changes from other devices replace local copies here.
  const replaceArchives = useCallback((fn: (prev: SavedTrip[]) => SavedTrip[]) => {
    setArchives((prev) => persistArchives(fn(prev)) ?? prev);
  }, [persistArchives]);
  const applyProfile = useCallback((p: Profile) => { saveProfile(p); setProfile(p); }, []);
  const firstName = user.name.split(/\s+/)[0] || user.name;
  const { status: syncStatus, removeTrip, shareTrip, joinTrip, resetInvite } = useCloudSync({
    db: firestore, uid: user.uid || null, name: user.name, archives, replaceArchives, profile, applyProfile,
  });

  // Joining a trip from an invite link, once signed in with Google.
  const openWhenArrives = useRef<string | null>(null);
  useEffect(() => {
    const join = store.get<{ id: string; code: string } | null>(JOIN_KEY, null);
    if (!join) return;
    if (!user.uid) {
      showToast('Sign in with Google to join the trip you were invited to.');
      return;
    }
    store.set(JOIN_KEY, null);
    joinTrip(join.id, join.code)
      .then(() => { openWhenArrives.current = join.id; showToast('You joined the trip. It syncs to your phone now.'); })
      .catch((e: Error) => showToast(e.message));
  }, [user.uid, joinTrip, showToast]);
  useEffect(() => {
    const id = openWhenArrives.current;
    const t = id ? archives.find((x) => x.id === id) : undefined;
    if (t) {
      openWhenArrives.current = null;
      setTrip(t);
      setForm(t.form);
      setActiveTab('planner');
    }
  }, [archives]);

  // Keep the open trip in step with its saved copy: another device may have changed or deleted it.
  useEffect(() => {
    if (!trip) return;
    const saved = archives.find((x) => x.id === trip.id);
    if (!saved) setTrip(null);
    // Newer copy, or new sharing details (a new invite link, someone joined or left), which don't change the version.
    else if ((saved.updatedAt || 0) > (trip.updatedAt || 0) || JSON.stringify(saved.share || null) !== JSON.stringify(trip.share || null)) setTrip(saved);
  }, [archives, trip]);

  // Applies `fn` to the latest saved version of a trip (other edits may have landed meanwhile).
  const updateTrip = useCallback((id: string, fn: (t: SavedTrip) => SavedTrip) => {
    setArchives((prev) => {
      const current = prev.find((x) => x.id === id);
      if (!current) return prev;
      const changed = { ...fn(current), updatedAt: Date.now() };
      const next = prev.map((x) => (x.id === id ? changed : x));
      const saved = persistArchives(next);
      if (saved) setTrip((cur) => (cur && cur.id === id ? changed : cur));
      return saved ?? prev;
    });
  }, [persistArchives]);

  // `newForm` is set when the person edited the trip details; the AI then replans the whole trip for them.
  const startChange = async (t: SavedTrip, scope: Scope, change: string, newForm: FormState | null = null) => {
    setChangeScope(null);
    try {
      const details = newForm || t.form;
      const body = { ...details, profile, plan: t.plan, scope: newForm ? 'all' : scope, change, previous: newForm ? t.form : undefined };
      const jobId = await startJob('/api/revise', body, await getHeaders());
      const next: PendingChange = { jobId, tripId: t.id, scope: newForm ? 'all' : scope, change, startedAt: Date.now(), form: newForm || undefined };
      store.set(PENDING_CHANGE_KEY, next);
      setPendingChange(next);
    } catch (err: any) {
      showToast(err?.message || "Couldn't start the change.");
    }
  };

  const startChangeRef = useRef<typeof startChange | null>(null);
  startChangeRef.current = startChange;

  // Follow a change job until it's ready; survives tab switches and reloads like new plans do.
  useEffect(() => {
    if (!pendingChange) return;
    let cancelled = false;
    const { jobId, tripId, scope, change, startedAt, form: newForm } = pendingChange;
    const tick = () => setChangeSeconds(Math.round((Date.now() - startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    waitForJob<any>(jobId, getHeaders, startedAt, undefined, () => cancelled)
      .then((result) => {
        if (cancelled) return;
        const latest = archivesRef.current.find((x) => x.id === tripId);
        if (!latest) {
          showToast('That trip was deleted, so the change was not applied.');
          return;
        }
        // The AI said this day-only request really changes the whole trip (a new start, dates, travellers).
        if (scope !== 'all' && needsWholeTrip(result)) {
          showToast('That change affects every day, so the whole trip is being updated.');
          startChangeRef.current?.(latest, 'all', change, newForm || null);
          return;
        }
        try {
          const changed = applyChange(latest, scope, change, result, newForm);
          updateTrip(tripId, () => changed);
          showToast(`${scope === 'all' ? 'Trip' : `Day ${scope}`} updated.`);
        } catch (e: any) {
          showToast(e?.message || 'The change could not be applied.');
        }
      })
      .catch((err: Error) => {
        if (cancelled || err.message === 'cancelled') return;
        showToast(err.message);
      })
      .finally(() => {
        if (cancelled) return;
        store.set(PENDING_CHANGE_KEY, null);
        setPendingChange(null);
      });
    return () => { cancelled = true; clearInterval(timer); };
  }, [pendingChange, getHeaders, updateTrip, showToast]);

  // Map results belong to the plan they measured. If the plan changed meanwhile (a change landed, or
  // was undone), they're dropped, and the new plan gets its own check.
  const saveChecks = useCallback((t: SavedTrip, checks: Checks) => {
    const measured = JSON.stringify(t.plan);
    updateTrip(t.id, (cur) => (JSON.stringify(cur.plan) === measured ? { ...cur, checks } : cur));
  }, [updateTrip]);

  // Checks the trip's places and drives against real map data, once at a time.
  const checkFailedAt = useRef(new Map<string, number>());
  const runChecks = useCallback(async (t: SavedTrip) => {
    if (checkingRef.current) return;
    checkingRef.current = t.id;
    setChecking({ tripId: t.id, done: 0, total: 0 });
    try {
      const checks = await checkPlan(t.plan, t.form.fromLocation, t.form.destination,
        (done, total) => setChecking({ tripId: t.id, done, total }),
        // Drives are measured first: show them (map lines, road rules, fuel) while places are looked up.
        (partial) => saveChecks(t, partial));
      saveChecks(t, checks);
    } catch (err) {
      checkFailedAt.current.set(t.id, Date.now());
      console.error('Map check failed:', err);
      showToast("Couldn't reach the map service. Try Check again later.");
    } finally {
      checkingRef.current = null;
      setChecking(null);
    }
  }, [saveChecks, showToast]);

  // The trip on screen (open in the planner, or in Today mode) gets a map check when it has places
  // or drives but none yet. Checks made before road rules or the trip map lack the road paths'
  // rule areas or shapes, so those run once more too.
  const onScreen = activeTab === 'today' ? archives.find((x) => x.id === todayId) || tripToday(archives) || trip : trip;
  useEffect(() => {
    const t = onScreen;
    if (!t || checkingRef.current) return;
    // A check that just failed (no map service answering) waits two minutes before trying again by itself.
    if (Date.now() - (checkFailedAt.current.get(t.id) || 0) < 120_000) return;
    const hasDrives = Boolean(t.plan.roadTrip && typeof t.plan.roadTrip === 'object' && arr(t.plan.roadTrip.legs).length);
    const needsCheck = (!t.checks || t.checks.partial) && (placesIn(t.plan).length > 0 || hasDrives);
    const beforeMap = Boolean(t.checks && Object.values(t.checks.legs || {}).some((l) => l && (!('hits' in l) || !l.path)));
    if ((needsCheck || beforeMap) && navigator.onLine !== false) runChecks(t);
  // `checking` is listed so a plan that changed during a check gets its own check once that one ends.
  }, [onScreen, runChecks, checking]);

  // Follow a plan job until it's ready. Survives tab switches and page reloads via localStorage.
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    const tick = () => setSeconds(Math.round((Date.now() - pending.startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    waitForJob<Plan>(pending.jobId, getHeaders, pending.startedAt, undefined, () => cancelled)
      .then((plan) => {
        if (cancelled) return;
        const saved: SavedTrip = {
          id: Date.now().toString(), form: pending.form, plan, packing: null, packed: {},
          dateCreated: new Date().toLocaleDateString(),
        };
        upsertTrip(saved);
        setTrip(saved);
        setActiveTab('planner');
        showToast('Your trip is ready and saved to My trips.');
      })
      .catch((err: Error) => {
        if (cancelled || err.message === 'cancelled') return;
        setError(err.message);
        setForm(pending.form);
      })
      .finally(() => {
        if (cancelled) return;
        store.set(PENDING_KEY, null);
        setPending(null);
      });
    return () => { cancelled = true; clearInterval(timer); };
  }, [pending, getHeaders, upsertTrip, showToast]);

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const generateItinerary = async () => {
    const duration = Number(form.duration);
    if (!form.destination.trim() || !form.fromLocation.trim() || !form.startDate) {
      setError('Please fill in From, To and Start date.');
      return;
    }
    if (!duration || duration < 1) {
      setError('Please enter at least 1 night.');
      return;
    }
    setError(null);
    setTrip(null);
    try {
      const jobId = await startJob('/api/plan', { ...form, profile }, await getHeaders());
      const next: PendingPlan = { jobId, form, startedAt: Date.now() };
      store.set(PENDING_KEY, next);
      setPending(next);
    } catch (err: any) {
      setError(err?.message || 'Failed to start. Please try again.');
    }
  };

  // Looks up current official road notices for the trip's drives and dates.
  const checkNotices = async (t: SavedTrip) => {
    if (noticesRun) return;
    const startedAt = Date.now();
    setNoticesRun({ tripId: t.id, seconds: 0 });
    try {
      const jobId = await startJob('/api/notices', { ...t.form, profile, plan: t.plan }, await getHeaders());
      const result = await waitForJob<any>(jobId, getHeaders, startedAt, (s) => setNoticesRun({ tripId: t.id, seconds: s }));
      patchTrip(t.id, {
        notices: {
          checkedAt: new Date().toISOString(),
          summary: typeof result?.summary === 'string' ? result.summary : '',
          notices: Array.isArray(result?.notices) ? result.notices.slice(0, 20) : [],
        },
      });
    } catch (err: any) {
      showToast(err?.message || "Couldn't check road notices.");
    } finally {
      setNoticesRun(null);
    }
  };

  const makePackingList = async (t: SavedTrip) => {
    setPackBusy('Starting…');
    const startedAt = Date.now();
    try {
      const planSummary = [t.plan.summary, t.plan.weather].filter(Boolean).join(' ');
      const jobId = await startJob('/api/pack', { ...t.form, profile, planSummary }, await getHeaders());
      const packing = await waitForJob<Packing>(jobId, getHeaders, startedAt, (s) => setPackBusy(`Building your list… ${mmss(s)}`));
      // Onto the latest copy: spends, ticks and map results may have landed while the list was being made.
      updateTrip(t.id, (cur) => ({ ...cur, packing: { groups: arr(packing?.groups) }, packed: {} }));
    } catch (err: any) {
      showToast(err?.message || 'Could not make the packing list.');
    } finally {
      setPackBusy(null);
    }
  };

  const openArchived = (t: SavedTrip) => {
    setTrip(t);
    setForm(t.form);
    setActiveTab('planner');
  };

  // A shared trip is deleted for everyone by the person who started it; anyone else leaves it.
  const leaves = (t: SavedTrip) => Boolean(t.share && user.uid && t.share.owner !== user.uid);
  const deleteArchived = (t: SavedTrip) => {
    const next = archives.filter((x) => x.id !== t.id);
    const saved = persistArchives(next);
    if (saved) setArchives(saved);
    if (trip?.id === t.id) setTrip(null);
    setConfirmDelete(null);
    setSharing(false);
    removeTrip(t);
    showToast(leaves(t) ? 'You left the trip.' : t.share ? 'Trip deleted for everyone.' : 'Trip deleted.');
  };

  // Brings in trips saved by the laptop Trip Kit app (data/trips/*.json).
  const importTripKit = async (files: FileList | null) => {
    if (!files?.length) return;
    let added = 0;
    const failed: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const t = fromTripKit(JSON.parse(await file.text()));
        if (archives.some((a) => a.id === t.id)) continue;
        upsertTrip(t);
        added++;
      } catch {
        failed.push(file.name);
      }
    }
    showToast(failed.length ? `Imported ${added}. Couldn't read: ${failed.join(', ')}` : `Imported ${added} trip${added === 1 ? '' : 's'}.`);
    if (importRef.current) importRef.current.value = '';
  };

  const todayTrip = archives.find((x) => x.id === todayId) || tripToday(archives) || trip;
  const openToday = (t: SavedTrip) => { setTodayId(t.id); setActiveTab('today'); };

  return (
    <div className="app-container">
      <header className="main-header">
        <button className="it-logo-btn" onClick={() => setActiveTab(todayTrip && dayOnDate(todayTrip) !== null ? 'today' : 'planner')} aria-label="IntelliTrip home">
          <Logo />
        </button>
        <MainTabs active={activeTab} onSelect={setActiveTab} todayLive={Boolean(todayTrip && dayOnDate(todayTrip) !== null)} />
        <div className="header-actions">
          {canInstall && (
            <button className="btn-secondary tk-install" onClick={async () => { if (await install()) showToast('IntelliTrip is on your home screen.'); }}>
              <span className="material-symbols-outlined" aria-hidden="true">install_mobile</span><span className="tk-install-label">Install app</span>
            </button>
          )}
          <AccountMenu user={user} syncState={syncStatus} syncLabel={SYNC_LABEL[syncStatus]} onLogout={onLogout} />
        </div>
      </header>

      <main className="content">
        {activeTab === 'planner' && (
          <>
            {!trip && !pending && (
              <div className="card form-card animate-fade-in">
                <h2>Plan a trip</h2>
                <p className="tk-dim it-form-intro">Tell us where and when. Your travellers and car from Toolkit are used automatically.</p>
                <div className="it-form-grid">
                  <div className="field">
                    <label htmlFor="fromLocation">From</label>
                    <input id="fromLocation" name="fromLocation" value={form.fromLocation} onChange={handleInputChange} placeholder="e.g. Madurai" autoComplete="address-level2" />
                  </div>
                  <div className="field">
                    <label htmlFor="destination">To</label>
                    <input id="destination" name="destination" value={form.destination} onChange={handleInputChange} placeholder="e.g. Thekkady" />
                  </div>
                  <div className="field">
                    <label htmlFor="startDate">Start date</label>
                    <input id="startDate" type="date" name="startDate" value={form.startDate} onChange={handleInputChange} />
                  </div>
                  <div className="field">
                    <label htmlFor="duration">Nights</label>
                    <input id="duration" type="number" inputMode="numeric" name="duration" value={form.duration} onChange={handleInputChange} min="1" max="30" />
                  </div>
                  <div className="field">
                    <label htmlFor="adults">Adults</label>
                    <input id="adults" type="number" inputMode="numeric" name="adults" value={form.adults} onChange={handleInputChange} min="1" />
                  </div>
                  <div className="field">
                    <label htmlFor="children">Children</label>
                    <input id="children" type="number" inputMode="numeric" name="children" value={form.children} onChange={handleInputChange} min="0" />
                  </div>
                  <div className="field">
                    <label htmlFor="mode">How you're travelling</label>
                    <select id="mode" name="mode" value={form.mode} onChange={handleInputChange}>
                      <option>Road trip in our own car</option>
                      <option>Road trip with a hired cab and driver</option>
                      <option>Compare road, train and flight</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="leaveAt">Leave home at <span className="it-optional">optional</span></label>
                    <input id="leaveAt" type="time" name="leaveAt" value={form.leaveAt || ''} onChange={handleInputChange} />
                  </div>
                  <div className="field it-span-2">
                    <label htmlFor="maxDrive">Most driving in a day</label>
                    <select id="maxDrive" name="maxDrive" value={form.maxDrive} onChange={handleInputChange}>
                      {['3 hours', '5 hours', '7 hours', '9 hours'].map((o) => <option key={o}>{o}</option>)}
                    </select>
                  </div>
                </div>
                <details className="it-prefs">
                  <summary>
                    <span className="material-symbols-outlined" aria-hidden="true">tune</span>
                    <span className="tk-grow">Trip preferences</span>
                    <span className="tk-dim tk-small">{[form.travelType, form.budget, form.food].filter(Boolean).join(' · ')}</span>
                  </summary>
                  <div className="it-form-grid">
                    <div className="field">
                      <label htmlFor="travelType">Kind of trip</label>
                      <select id="travelType" name="travelType" value={form.travelType} onChange={handleInputChange}>
                        <option value="Family">Family</option>
                        <option value="Luxury">Luxury</option>
                        <option value="Adventure">Adventure</option>
                        <option value="Solo">Solo</option>
                        <option value="Group">Friends</option>
                        <option value="Romantic">Couple</option>
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="budget">Budget</label>
                      <select id="budget" name="budget" value={form.budget} onChange={handleInputChange}>
                        {['Budget', 'Mid-range', 'Comfortable', 'Splurge'].map((o) => <option key={o}>{o}</option>)}
                      </select>
                    </div>
                    <div className="field it-span-2">
                      <label htmlFor="food">Food</label>
                      <input id="food" name="food" value={form.food} onChange={handleInputChange} placeholder="e.g. South Indian vegetarian" />
                    </div>
                    <div className="field it-span-2">
                      <label htmlFor="idealTripDescription">Anything else? <span className="it-optional">optional</span></label>
                      <textarea id="idealTripDescription" name="idealTripDescription" value={form.idealTripDescription} onChange={handleInputChange} placeholder="e.g. quiet viewpoints, an elderly parent, a wedding at 6 pm on day 2, avoid long walks" />
                    </div>
                  </div>
                </details>
                {error && <p className="error" role="alert">{error}</p>}
                <button className="btn-primary" onClick={generateItinerary}>Create my plan</button>
                <button className="btn-secondary it-form-sample" onClick={onSample}>Not sure what you'll get? See a sample trip</button>
                <p className="tk-dim tk-small tk-center">Takes 2 to 5 minutes. You can close the app meanwhile; the plan is saved to My trips.</p>
              </div>
            )}

            {pending && !trip && <LoadingStage destination={pending.form.destination} seconds={seconds} />}

            {trip && (
              <div className="results-container animate-fade-in">
                <div className="results-header">
                  <div className="title-group">
                    <h2>{trip.plan.title || trip.form.destination}</h2>
                    <p className="tk-route">
                      {trip.form.fromLocation} → {trip.form.destination} · {fmtTripDates(trip.form)} · {trip.form.adults} {Number(trip.form.adults) === 1 ? 'adult' : 'adults'}{Number(trip.form.children) ? `, ${trip.form.children} ${Number(trip.form.children) === 1 ? 'child' : 'children'}` : ''}
                    </p>
                    <p>{trip.plan.summary}</p>
                  </div>
                  <div className="action-btns">
                    <span className="tk-saved" title="Saved in My trips">
                      <span className="material-symbols-outlined" aria-hidden="true">check_circle</span>Saved
                    </span>
                    <button onClick={() => setChangeScope('all')} className="btn-secondary tk-share-btn" disabled={Boolean(pendingChange)}
                      title={pendingChange ? 'A change is already being made' : 'Change part of this trip'}>
                      <span className="material-symbols-outlined" aria-hidden="true">edit_note</span>Change
                    </button>
                    <button onClick={() => setSharing(true)} className="btn-secondary tk-share-btn">
                      <span className="material-symbols-outlined" aria-hidden="true">{trip.share ? 'group' : 'share'}</span>
                      {trip.share ? `Shared · ${trip.share.members.length}` : 'Share'}
                    </button>
                    <button onClick={() => openToday(trip)} className="btn-accent tk-share-btn">
                      <span className="material-symbols-outlined" aria-hidden="true">today</span>Today mode
                    </button>
                    <button onClick={() => { setTrip(null); setForm(emptyForm(profile)); }} className="btn-icon-bg" aria-label="Close itinerary">
                      <span className="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                  </div>
                </div>

                {trip.vibeImage && (
                  <div className="results-vibe-hero card animate-fade-in">
                    <img src={trip.vibeImage} alt={`Scenery of ${trip.form.destination}`} />
                  </div>
                )}

                <PlanView
                  trip={trip}
                  checkProgress={checking && checking.tripId === trip.id ? checking : null}
                  onChangeDay={pendingChange ? undefined : (d) => setChangeScope(d)}
                  sidebarSlot={<RemindersCard trip={trip} onOpen={() => setReminding(true)} />}
                  rulesSlot={
                    <RoadRulesCard trip={trip} busy={noticesRun && noticesRun.tripId === trip.id ? noticesRun.seconds : null}
                      onCheckNotices={() => checkNotices(trip)}
                      onFix={(day, text) => { if (!pendingChange) { setChangeText(text); setChangeScope(day); } }} />
                  }
                  changeSlot={
                    <ChangeBanner trip={trip} pending={pendingChange} seconds={changeSeconds}
                      onUndo={() => { updateTrip(trip.id, undoChange); showToast('Change undone.'); }}
                      onDismiss={() => updateTrip(trip.id, (t) => ({ ...t, lastChange: null }))} />
                  }
                  onRecheck={() => runChecks(trip)}
                  mapSlot={<TripMap trip={trip} />}
                  packingSlot={
                    <>
                      <PackingCard trip={trip} onChange={upsertTrip} makeList={() => makePackingList(trip)} busy={packBusy} />
                      <WalletCard trip={trip} profile={profile} onChange={upsertTrip} by={firstName} />
                    </>
                  }
                />
              </div>
            )}
          </>
        )}

        {activeTab === 'today' && (
          todayTrip ? (
            <TodayView trip={todayTrip} onChange={upsertTrip} by={firstName}
              weatherSlot={(place) => <WeatherTracker destination={place} />}
              onOpenPlan={() => openArchived(todayTrip)} />
          ) : (
            <div className="card tk-card today-empty animate-fade-in">
              <h2>Today</h2>
              <p>When you're on a trip, this screen shows the day's drive and plan, a Navigate button for the next stop, road-rule warnings and a quick way to log spends. It opens by itself on trip days and works offline.</p>
              {archives.length > 0 ? (
                <>
                  <p className="tk-dim tk-small">No trip today. Preview one:</p>
                  <div className="archive-list">
                    {archives.slice(0, 5).map((t) => (
                      <button key={t.id} className="card archive-card" onClick={() => openToday(t)}>
                        <div className="arc-info"><strong>{t.plan.title || t.form.destination}</strong><span>{fmtTripDates(t.form)}</span></div>
                        <span className="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <button className="btn-secondary" onClick={() => setActiveTab('planner')}>Plan a trip</button>
              )}
            </div>
          )
        )}

        {activeTab === 'archives' && (
          <div className="archives-view animate-fade-in">
            <div className="tk-archive-head">
              <h2>My trips</h2>
              <button className="btn-secondary" onClick={() => importRef.current?.click()}>Import trip files</button>
              <input ref={importRef} type="file" accept=".json,application/json" multiple hidden onChange={(e) => importTripKit(e.target.files)} />
            </div>
            {archives.length === 0 ? (
              <p className="empty-msg">No trips yet. Plan one and it's saved here.</p>
            ) : (
              <div className="archive-list">
                {archives.map((t) => (
                  <div key={t.id} className="tk-archive-row">
                    <button className="card archive-card" onClick={() => openArchived(t)}>
                      <div className="arc-info">
                        <strong>
                          {t.plan.title || t.form.destination}
                          {t.share && <span className="tk-chip util tk-shared-chip"><span className="material-symbols-outlined" aria-hidden="true">group</span>Shared</span>}
                        </strong>
                        <span>{t.form.fromLocation ? `${t.form.fromLocation} → ` : ''}{t.form.destination} • {fmtTripDates(t.form)}</span>
                      </div>
                      <span className="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                    </button>
                    {confirmDelete === t.id ? (
                      <button className="btn-secondary tk-danger" onClick={() => deleteArchived(t)}>
                        {leaves(t) ? 'Tap again to leave' : t.share ? 'Tap again to delete for everyone' : 'Tap again to delete'}
                      </button>
                    ) : (
                      <button className="btn-icon-bg" aria-label={`Delete ${t.plan.title || t.form.destination}`} onClick={() => setConfirmDelete(t.id)}>
                        <span className="material-symbols-outlined" aria-hidden="true">delete</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'toolkit' && (
          <div className="tk-toolkit animate-fade-in">
            <TravellersCard profile={profile} onSave={(p) => { applyProfile({ ...p, updatedAt: Date.now() }); showToast('Travellers saved.'); }} />
            <InstallCard />
            <BookByCard />
            <LeaveCard />
          </div>
        )}
      </main>

      {sharing && trip && (
        <ShareSheet trip={trip} onClose={() => setSharing(false)}
          extra={
            <TogetherSection trip={trip} uid={user.uid}
              onShare={() => shareTrip(trip)}
              onReset={(removeUid) => resetInvite(trip, removeUid)}
              onLeave={() => deleteArchived(trip)} />
          } />
      )}
      {reminding && trip && <RemindersSheet trip={trip} onClose={() => setReminding(false)} />}
      {changeScope !== null && trip && (
        <ChangeSheet trip={trip} initialScope={changeScope} initialText={changeText}
          onSubmit={(scope, change, newForm) => startChange(trip, scope, change, newForm)} onClose={() => { setChangeScope(null); setChangeText(''); }} />
      )}
      {toast && <Toast message={toast} />}
    </div>
  );
};

const fmtTripDates = (f: FormState) => {
  if (!f.startDate) return '';
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  const a = new Date(f.startDate + 'T00:00:00').toLocaleDateString('en-IN', opts);
  const b = new Date(endDateOf(f) + 'T00:00:00').toLocaleDateString('en-IN', { ...opts, year: 'numeric' });
  return `${a} – ${b}`;
};

const InstallButton = () => {
  const { canInstall, install } = useInstall();
  return canInstall ? (
    <button className="btn-secondary tk-install" onClick={() => install()}>
      <span className="material-symbols-outlined" aria-hidden="true">install_mobile</span><span className="tk-install-label">Install app</span>
    </button>
  ) : null;
};

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
    <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
  </svg>
);

// Firebase-backed Google sign-in. Falls back to a name-only login when Firebase
// is not configured, so the app still works before provisioning.
const LoginPage = ({ onLogin, onBack, onSample }: { onLogin: (n: string) => void; onBack: () => void; onSample: () => void }) => {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invited = Boolean(store.get(JOIN_KEY, null));

  const signIn = async () => {
    if (!auth) return;
    setBusy(true);
    setError(null);
    try {
      try {
        await signInWithPopup(auth, new GoogleAuthProvider());
      } catch (e: any) {
        // Some phone browsers block pop-ups: sign in on a full page instead.
        if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/operation-not-supported-in-this-environment') {
          await signInWithRedirect(auth, new GoogleAuthProvider());
          return;
        }
        throw e;
      }
      // onAuthStateChanged in <App> handles the move to the app.
    } catch (e: any) {
      if (e?.code !== 'auth/popup-closed-by-user' && e?.code !== 'auth/cancelled-popup-request') {
        setError(e?.message || 'Sign-in failed. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="it-landing">
      <header className="it-public-head">
        <button className="btn-secondary it-back" onClick={onBack}>
          <span className="material-symbols-outlined" aria-hidden="true">arrow_back</span>Home
        </button>
        <Logo small />
        <span className="it-head-spacer" aria-hidden="true" />
      </header>
      <main className="login-screen">
        <div className="login-card card">
          <h1>{invited ? 'Join the trip' : 'Sign in to plan'}</h1>
          <p className="tk-dim">
            {invited
              ? "You've been invited to plan a trip together. Sign in with Google to join it."
              : 'Your trips save to your Google account and appear on every phone and laptop you sign in on.'}
          </p>
          {firebaseEnabled && auth ? (
            <button className="btn-primary google-btn" onClick={signIn} disabled={busy}>
              <GoogleIcon /> {busy ? 'Signing in…' : 'Continue with Google'}
            </button>
          ) : (
            <>
              <div className="field">
                <label htmlFor="explorerName">Your name</label>
                <input id="explorerName" autoFocus placeholder="Your name" value={name}
                  onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onLogin(name.trim() || 'Traveller')} />
              </div>
              <button className="btn-primary" onClick={() => onLogin(name.trim() || 'Traveller')}>Continue</button>
            </>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          {!invited && <button className="btn-secondary it-login-sample" onClick={onSample}>Or look at a sample trip first</button>}
        </div>
      </main>
    </div>
  );
};

type View = 'landing' | 'login' | 'sample' | 'dashboard';

const App = () => {
  // An invite link, or opening the installed app, skips the home page.
  const [view, setView] = useState<View>(() =>
    store.get(JOIN_KEY, null) || window.matchMedia?.('(display-mode: standalone)').matches ? 'login' : 'landing');
  const [user, setUser] = useState<AppUser | null>(null);

  // With Firebase on, auth state is the source of truth for who is signed in.
  useEffect(() => {
    if (!firebaseEnabled || !auth) return;
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      if (fbUser) {
        claimDevice(fbUser.uid, [PENDING_CHANGE_KEY]);
        setUser({
          // Never the email: the name is shown to family on shared trips.
          name: fbUser.displayName || 'Traveller',
          email: fbUser.email || undefined,
          photo: fbUser.photoURL || undefined,
          uid: fbUser.uid,
          getToken: () => fbUser.getIdToken(),
        });
        // Someone reading the sample stays on it; everyone else goes into the app.
        setView((v) => (v === 'sample' ? v : 'dashboard'));
      } else {
        setUser(null);
        setView((v) => (v === 'dashboard' ? 'login' : v));
      }
    });
    return unsub;
  }, []);

  useEffect(() => { window.scrollTo(0, 0); }, [view]);

  const handleLogout = () => {
    if (firebaseEnabled && auth) signOut(auth);
    else setUser(null);
    setView('landing');
  };

  const start = () => setView(user ? 'dashboard' : 'login');
  const startLabel = user ? 'Open my trips' : 'Plan a trip';
  if (view === 'landing') return <LandingPage onStart={start} onSample={() => setView('sample')} startLabel={startLabel} headExtra={<InstallButton />} />;
  if (view === 'sample') return <SampleView onBack={() => setView(user ? 'dashboard' : 'landing')} onStart={start} startLabel={user ? 'Open my trips' : 'Plan my own'} />;
  if (view === 'login' || !user) {
    return <LoginPage onBack={() => setView('landing')} onSample={() => setView('sample')}
      onLogin={(n) => { setUser({ name: n }); setView('dashboard'); }} />;
  }
  return <Dashboard user={user} onLogout={handleLogout} onSample={() => setView('sample')} />;
};

const root = createRoot(document.getElementById('root')!);
root.render(<SafeArea name="IntelliTrip" fallback={<AppCrashed />}><App /></SafeArea>);
