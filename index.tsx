/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import {
  type FormState, type Profile, type SavedTrip, type Packing, type Plan,
  BookByCard, LeaveCard, PackingCard, PENDING_KEY, PlanView, STORAGE_KEY, TravellersCard,
  emptyForm, fromTripKit, loadProfile, mmss, normaliseSaved, saveProfile, startJob, store, waitForJob, arr, endDateOf,
} from './tripkit';
import { checkPlan, placesIn } from './placecheck';
import { ShareSheet } from './share';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type Auth,
} from 'firebase/auth';

// Mapbox public token (safe to expose; restrict by URL in Mapbox settings).
const MAPBOX_TOKEN = (import.meta as any).env?.VITE_MAPBOX_TOKEN as string | undefined;

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
if (firebaseEnabled) {
  try {
    auth = getAuth(initializeApp(firebaseConfig));
  } catch (e) {
    console.error('Firebase init failed:', e);
  }
}

interface AppUser {
  name: string;
  getToken?: () => Promise<string | null>;
}

// --- TYPES ---

type ActiveTab = 'planner' | 'radar' | 'archives' | 'toolkit';

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
      <p className="tk-dim tk-small">Usually 2–5 minutes. You can switch tabs or close this page: the trip is saved to Archives when it's ready.</p>
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
        <h3>Live Weather</h3>
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
          <p className="weather-note">Current 7-day outlook for the destination (updates in real time).</p>
        </>
      )}
    </div>
  );
};

// --- LIVE TRAFFIC MAP (Mapbox GL + live traffic tiles) ---

const CONGESTION_COLORS: Record<string, string> = {
  low: '#3fb950',
  moderate: '#f2cc60',
  heavy: '#f85149',
  severe: '#b62324',
};

const TrafficMap = ({ destination }: { destination: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [error, setError] = useState<'token' | 'locate' | null>(MAPBOX_TOKEN ? null : 'token');

  useEffect(() => {
    if (!MAPBOX_TOKEN || !destination.trim() || !containerRef.current) return;
    let cancelled = false;

    const init = async () => {
      try {
        const geoRes = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(destination)}&count=1&language=en&format=json`
        );
        const geo = await geoRes.json();
        const loc = geo?.results?.[0];
        if (!loc) throw new Error('locate');
        if (cancelled || !containerRef.current) return;

        mapboxgl.accessToken = MAPBOX_TOKEN;
        const map = new mapboxgl.Map({
          container: containerRef.current,
          style: 'mapbox://styles/mapbox/dark-v11',
          center: [loc.longitude, loc.latitude],
          zoom: 11,
          attributionControl: true,
        });
        mapRef.current = map;
        map.addControl(new mapboxgl.NavigationControl(), 'top-right');
        new mapboxgl.Marker({ color: '#58a6ff' })
          .setLngLat([loc.longitude, loc.latitude])
          .addTo(map);

        map.on('load', () => {
          map.addSource('mapbox-traffic', {
            type: 'vector',
            url: 'mapbox://mapbox.mapbox-traffic-v1',
          });
          map.addLayer({
            id: 'traffic',
            type: 'line',
            source: 'mapbox-traffic',
            'source-layer': 'traffic',
            paint: {
              'line-width': 2.5,
              'line-color': [
                'match',
                ['get', 'congestion'],
                'low', CONGESTION_COLORS.low,
                'moderate', CONGESTION_COLORS.moderate,
                'heavy', CONGESTION_COLORS.heavy,
                'severe', CONGESTION_COLORS.severe,
                '#8b949e',
              ],
            },
          });
        });
      } catch {
        if (!cancelled) setError('locate');
      }
    };

    init();
    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [destination]);

  return (
    <div className="card map-card">
      <div className="map-head">
        <h3>Live Traffic</h3>
        {!error && (
          <div className="map-legend" aria-hidden="true">
            <span><i style={{ background: CONGESTION_COLORS.low }} />Free</span>
            <span><i style={{ background: CONGESTION_COLORS.moderate }} />Moderate</span>
            <span><i style={{ background: CONGESTION_COLORS.heavy }} />Heavy</span>
            <span><i style={{ background: CONGESTION_COLORS.severe }} />Severe</span>
          </div>
        )}
      </div>

      {error === 'token' && (
        <p className="weather-status">
          Live traffic map is not configured yet. Add a <code>VITE_MAPBOX_TOKEN</code> to enable it.
        </p>
      )}
      {error === 'locate' && (
        <p className="weather-status weather-error">Couldn't place "{destination}" on the map.</p>
      )}
      {!error && <div ref={containerRef} className="map-container" />}
    </div>
  );
};

// --- MAIN DASHBOARD ---

const Dashboard: React.FC<{ user: AppUser; onLogout: () => void }> = ({ user, onLogout }) => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('planner');
  const [profile, setProfile] = useState<Profile>(loadProfile);
  const [form, setForm] = useState<FormState>(() => emptyForm(loadProfile()));
  const [pending, setPending] = useState<PendingPlan | null>(() => store.get<PendingPlan | null>(PENDING_KEY, null));
  const [seconds, setSeconds] = useState(0);
  const [trip, setTrip] = useState<SavedTrip | null>(null);
  const [isTripCommenced, setIsTripCommenced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archives, setArchives] = useState<SavedTrip[]>(loadArchives);
  const [toast, setToast] = useState<string | null>(null);
  const [packBusy, setPackBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [checking, setChecking] = useState<{ tripId: string; done: number; total: number } | null>(null);
  const [sharing, setSharing] = useState(false);
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
    showToast('Storage is full. Delete an old trip from Archives and try again.');
    return null;
  }, [showToast]);

  // Saves a new or changed trip and keeps the open trip in sync.
  const upsertTrip = useCallback((t: SavedTrip) => {
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
      const next = prev.map((x) => (x.id === id ? { ...current, ...patch } : x));
      return persistArchives(next) ?? prev;
    });
    setTrip((cur) => (cur && cur.id === id ? { ...cur, ...patch } : cur));
  }, [persistArchives]);

  // Checks the trip's places and drives against real map data, once at a time.
  const runChecks = useCallback(async (t: SavedTrip) => {
    if (checkingRef.current) return;
    checkingRef.current = t.id;
    setChecking({ tripId: t.id, done: 0, total: 0 });
    try {
      const checks = await checkPlan(t.plan, t.form.fromLocation, t.form.destination,
        (done, total) => setChecking({ tripId: t.id, done, total }));
      patchTrip(t.id, { checks });
    } catch (err) {
      console.error('Map check failed:', err);
      showToast("Couldn't reach the map service. Try Check again later.");
    } finally {
      checkingRef.current = null;
      setChecking(null);
    }
  }, [patchTrip, showToast]);

  // Any open trip that has places but no map check yet gets one.
  useEffect(() => {
    if (trip && !trip.checks && placesIn(trip.plan).length && !checkingRef.current) runChecks(trip);
  }, [trip, runChecks]);

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
        showToast('Your trip is ready and saved to Archives.');
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
    setIsTripCommenced(false);
    try {
      const jobId = await startJob('/api/plan', { ...form, profile }, await getHeaders());
      const next: PendingPlan = { jobId, form, startedAt: Date.now() };
      store.set(PENDING_KEY, next);
      setPending(next);
    } catch (err: any) {
      setError(err?.message || 'Failed to start. Please try again.');
    }
  };

  const makePackingList = async (t: SavedTrip) => {
    setPackBusy('Starting…');
    const startedAt = Date.now();
    try {
      const planSummary = [t.plan.summary, t.plan.weather].filter(Boolean).join(' ');
      const jobId = await startJob('/api/pack', { ...t.form, profile, planSummary }, await getHeaders());
      const packing = await waitForJob<Packing>(jobId, getHeaders, startedAt, (s) => setPackBusy(`Building your list… ${mmss(s)}`));
      upsertTrip({ ...t, packing: { groups: arr(packing?.groups) }, packed: {} });
    } catch (err: any) {
      showToast(err?.message || 'Could not make the packing list.');
    } finally {
      setPackBusy(null);
    }
  };

  const openArchived = (t: SavedTrip) => {
    setTrip(t);
    setForm(t.form);
    setIsTripCommenced(false);
    setActiveTab('planner');
  };

  const deleteArchived = (id: string) => {
    const next = archives.filter((t) => t.id !== id);
    const saved = persistArchives(next);
    if (saved) setArchives(saved);
    if (trip?.id === id) setTrip(null);
    setConfirmDelete(null);
    showToast('Trip deleted.');
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

  const destination = trip?.form.destination || form.destination;

  return (
    <div className="app-container">
      <header className="main-header">
        <div className="logo">
          <span className="material-symbols-outlined" aria-hidden="true">explore</span>
          <h1>IntelliTrip</h1>
        </div>
        <div className="header-actions">
          <span>{user.name}</span>
          <button onClick={onLogout} className="btn-icon" aria-label="Log out">
            <span className="material-symbols-outlined" aria-hidden="true">logout</span>
          </button>
        </div>
      </header>

      <nav className="main-nav" aria-label="Primary">
        <button
          className={activeTab === 'planner' ? 'active' : ''}
          onClick={() => setActiveTab('planner')}
          aria-current={activeTab === 'planner'}
        >
          Architect
        </button>
        <button
          className={`${activeTab === 'radar' ? 'active' : ''} ${!isTripCommenced ? 'locked' : ''}`}
          onClick={() => isTripCommenced && setActiveTab('radar')}
          disabled={!isTripCommenced}
          aria-disabled={!isTripCommenced}
        >
          {isTripCommenced ? (
            <span className="radar-dot" aria-hidden="true"></span>
          ) : (
            <span className="material-symbols-outlined" aria-hidden="true">lock</span>
          )}
          Live Radar
        </button>
        <button
          className={activeTab === 'archives' ? 'active' : ''}
          onClick={() => setActiveTab('archives')}
          aria-current={activeTab === 'archives'}
        >
          Archives
        </button>
        <button
          className={activeTab === 'toolkit' ? 'active' : ''}
          onClick={() => setActiveTab('toolkit')}
          aria-current={activeTab === 'toolkit'}
        >
          Toolkit
        </button>
      </nav>

      <main className="content">
        {activeTab === 'planner' && (
          <>
            {!trip && !pending && (
              <div className="card form-card animate-fade-in">
                <h2>Plan New Adventure</h2>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="fromLocation">From</label>
                    <input id="fromLocation" name="fromLocation" value={form.fromLocation} onChange={handleInputChange} placeholder="e.g. Madurai" />
                  </div>
                  <div className="field">
                    <label htmlFor="destination">To</label>
                    <input id="destination" name="destination" value={form.destination} onChange={handleInputChange} placeholder="e.g. Vagamon" />
                  </div>
                </div>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="startDate">Start Date</label>
                    <input id="startDate" type="date" name="startDate" value={form.startDate} onChange={handleInputChange} />
                  </div>
                  <div className="field">
                    <label htmlFor="duration">Nights</label>
                    <input id="duration" type="number" name="duration" value={form.duration} onChange={handleInputChange} min="1" max="30" />
                  </div>
                </div>
                <div className="grid-3">
                  <div className="field">
                    <label htmlFor="adults">Adults</label>
                    <input id="adults" type="number" name="adults" value={form.adults} onChange={handleInputChange} min="1" />
                  </div>
                  <div className="field">
                    <label htmlFor="children">Children</label>
                    <input id="children" type="number" name="children" value={form.children} onChange={handleInputChange} min="0" />
                  </div>
                  <div className="field">
                    <label htmlFor="travelType">Vibe</label>
                    <select id="travelType" name="travelType" value={form.travelType} onChange={handleInputChange}>
                      <option value="Family">Family Friendly</option>
                      <option value="Luxury">Luxury</option>
                      <option value="Adventure">Adventure</option>
                      <option value="Solo">Solo</option>
                      <option value="Group">Group</option>
                      <option value="Romantic">Romantic</option>
                    </select>
                  </div>
                </div>
                <div className="grid-3">
                  <div className="field">
                    <label htmlFor="mode">How you're travelling</label>
                    <select id="mode" name="mode" value={form.mode} onChange={handleInputChange}>
                      <option>Road trip in our own car</option>
                      <option>Road trip with a hired cab and driver</option>
                      <option>Compare road, train and flight</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="maxDrive">Most driving a day</label>
                    <select id="maxDrive" name="maxDrive" value={form.maxDrive} onChange={handleInputChange}>
                      {['3 hours', '5 hours', '7 hours', '9 hours'].map((o) => <option key={o}>{o}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="budget">Budget</label>
                    <select id="budget" name="budget" value={form.budget} onChange={handleInputChange}>
                      {['Budget', 'Mid-range', 'Comfortable', 'Splurge'].map((o) => <option key={o}>{o}</option>)}
                    </select>
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="food">Food preference</label>
                  <input id="food" name="food" value={form.food} onChange={handleInputChange} placeholder="e.g. South Indian vegetarian" />
                </div>
                <div className="field">
                  <label htmlFor="idealTripDescription">Describe your ideal experience</label>
                  <textarea id="idealTripDescription" name="idealTripDescription" value={form.idealTripDescription} onChange={handleInputChange} placeholder="e.g. Quiet viewpoints, good local food on the way, elderly parent, avoid long walks..." />
                </div>
                {error && <p className="error" role="alert">{error}</p>}
                <button className="btn-primary" onClick={generateItinerary}>Curate Journey</button>
                <p className="tk-dim tk-small tk-center">Your travellers and car from the Toolkit tab are used automatically.</p>
              </div>
            )}

            {pending && !trip && <LoadingStage destination={pending.form.destination} seconds={seconds} />}

            {trip && (
              <div className="results-container animate-fade-in">
                <div className="results-header">
                  <div className="title-group">
                    <h2>{trip.plan.title || trip.form.destination}</h2>
                    <p className="tk-route">
                      {trip.form.fromLocation} → {trip.form.destination} · {fmtTripDates(trip.form)} · {trip.form.adults} adults{Number(trip.form.children) ? `, ${trip.form.children} children` : ''}
                    </p>
                    <p>{trip.plan.summary}</p>
                  </div>
                  <div className="action-btns">
                    <span className="tk-saved" title="Saved in Archives on this device">
                      <span className="material-symbols-outlined" aria-hidden="true">check_circle</span>Saved
                    </span>
                    <button onClick={() => setSharing(true)} className="btn-secondary tk-share-btn">
                      <span className="material-symbols-outlined" aria-hidden="true">share</span>Share
                    </button>
                    <button onClick={() => { setIsTripCommenced(true); setActiveTab('radar'); }} className="btn-accent">Commence Journey</button>
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
                  onRecheck={() => runChecks(trip)}
                  packingSlot={<PackingCard trip={trip} onChange={upsertTrip} makeList={() => makePackingList(trip)} busy={packBusy} />}
                />
              </div>
            )}
          </>
        )}

        {activeTab === 'radar' && (
          <div className="radar-view animate-fade-in">
            <div className="radar-head">
              <h2>Trip Environmental Briefing</h2>
              <p>Curated context for <strong>{destination}</strong></p>
            </div>

            <WeatherTracker destination={destination} />

            <TrafficMap destination={destination} />

            <div className="radar-grid-layout">
              <div className="alerts-feed">
                {arr(trip?.plan.days).map((day) => (
                  <div key={day.day} className="radar-day-section">
                    <h4>Day {day.day} Contextual Updates</h4>
                    {arr(day.liveAlerts).map((alert, idx) => (
                      <div key={idx} className={`alert-card ${String(alert.condition || '').toLowerCase()}`}>
                        <div className="alert-title">
                          <span className="material-symbols-outlined" aria-hidden="true">
                            {alert.condition === 'Crowded'
                              ? 'groups'
                              : alert.condition === 'Weather'
                              ? 'cloudy_snowing'
                              : alert.condition === 'Closure'
                              ? 'block'
                              : 'traffic'}
                          </span>
                          {alert.condition || 'Heads-up'} Advisory
                        </div>
                        <p>{alert.description}</p>
                        <div className="pivot">
                          <strong>Architect's Pivot:</strong> {alert.alternativeSuggestion}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <div className="radar-visualization card">
                <div className="radar-circle">
                  <div className="radar-sweep"></div>
                  <div className="radar-blip b1"></div>
                  <div className="radar-blip b2"></div>
                </div>
                <div className="radar-metrics">
                  <div className="metric"><span>Days</span><strong>{arr(trip?.plan.days).length}</strong></div>
                  <div className="metric"><span>Advisories</span><strong>{arr(trip?.plan.days).reduce((s, d) => s + arr(d.liveAlerts).length, 0)}</strong></div>
                  <div className="metric"><span>Hidden gems</span><strong>{arr(trip?.plan.days).reduce((s, d) => s + arr(d.hiddenGems).length, 0)}</strong></div>
                </div>
                <p className="radar-note">Advisories are generated with your itinerary as planning guidance. Weather and traffic above are live.</p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'archives' && (
          <div className="archives-view animate-fade-in">
            <div className="tk-archive-head">
              <h2>Your Journey Archives</h2>
              <button className="btn-secondary" onClick={() => importRef.current?.click()}>Import Trip Kit trips</button>
              <input ref={importRef} type="file" accept=".json,application/json" multiple hidden onChange={(e) => importTripKit(e.target.files)} />
            </div>
            <p className="tk-dim tk-small">Trips are saved in this browser. To bring in trips from the laptop Trip Kit app, pick their files from <code>C:\Users\kamal\Apps\TripKit\data\trips</code>.</p>
            {archives.length === 0 ? (
              <p className="empty-msg">No journeys preserved yet.</p>
            ) : (
              <div className="archive-list">
                {archives.map((t) => (
                  <div key={t.id} className="tk-archive-row">
                    <button className="card archive-card" onClick={() => openArchived(t)}>
                      <div className="arc-info">
                        <strong>{t.plan.title || t.form.destination}</strong>
                        <span>{t.form.fromLocation ? `${t.form.fromLocation} → ` : ''}{t.form.destination} • {fmtTripDates(t.form)}</span>
                      </div>
                      <span className="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                    </button>
                    {confirmDelete === t.id ? (
                      <button className="btn-secondary tk-danger" onClick={() => deleteArchived(t.id)}>Tap again to delete</button>
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
            <TravellersCard profile={profile} onSave={(p) => { saveProfile(p); setProfile(p); showToast('Travellers saved.'); }} />
            <BookByCard />
            <LeaveCard />
          </div>
        )}
      </main>

      {sharing && trip && <ShareSheet trip={trip} onClose={() => setSharing(false)} />}
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

const LandingPage = ({ onStart }: { onStart: () => void }) => (
  <div className="landing-screen">
    <div className="landing-hero animate-fade-in">
      <span className="material-symbols-outlined xl-icon" aria-hidden="true">explore</span>
      <h1>IntelliTrip</h1>
      <p className="hero-subtitle">High-fidelity AI Travel Architecture</p>
      <button className="btn-primary mega-btn" onClick={onStart}>Initialize Architect</button>
    </div>

    <section className="features-grid container">
      <div className="feature-card card">
        <span className="material-symbols-outlined feature-icon" aria-hidden="true">auto_awesome</span>
        <h3>AI Architecture</h3>
        <p>An AI planner builds road trips with real routes, food stops on the way and a story for every day.</p>
      </div>
      <div className="feature-card card">
        <span className="material-symbols-outlined feature-icon" aria-hidden="true">radar</span>
        <h3>Trip Briefing</h3>
        <p>Context-aware advisories flag likely crowd spikes, weather shifts, and closures along your route.</p>
      </div>
      <div className="feature-card card">
        <span className="material-symbols-outlined feature-icon" aria-hidden="true">vpn_key</span>
        <h3>Local Secrets</h3>
        <p>Lesser-known places worth the detour, and a "Hero Moment" for every stop, each one a tap away in Google Maps.</p>
      </div>
      <div className="feature-card card">
        <span className="material-symbols-outlined feature-icon" aria-hidden="true">account_balance_wallet</span>
        <h3>Budget Logic</h3>
        <p>Cost estimates in INR, booking deadlines, packing lists and a leave-home checklist.</p>
      </div>
    </section>
  </div>
);

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
const LoginPage = ({ onLogin }: { onLogin: (n: string) => void }) => {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (firebaseEnabled && auth) {
    const signIn = async () => {
      setBusy(true);
      setError(null);
      try {
        await signInWithPopup(auth, new GoogleAuthProvider());
        // onAuthStateChanged in <App> handles the transition to the dashboard.
      } catch (e: any) {
        if (e?.code !== 'auth/popup-closed-by-user' && e?.code !== 'auth/cancelled-popup-request') {
          setError(e?.message || 'Sign-in failed. Please try again.');
        }
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="login-screen">
        <div className="login-card card">
          <span className="material-symbols-outlined xl-icon" aria-hidden="true">explore</span>
          <h1>Sign in</h1>
          <p>Continue with your Google account to start planning.</p>
          <button className="btn-primary google-btn" onClick={signIn} disabled={busy}>
            <GoogleIcon /> {busy ? 'Signing in…' : 'Continue with Google'}
          </button>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <div className="login-card card">
        <span className="material-symbols-outlined xl-icon" aria-hidden="true">account_circle</span>
        <h1>Welcome</h1>
        <p>Enter your explorer identity to begin.</p>
        <label className="sr-only" htmlFor="explorerName">Explorer name</label>
        <input
          id="explorerName"
          autoFocus
          placeholder="Explorer Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onLogin(name.trim() || 'Explorer')}
        />
        <button className="btn-primary" onClick={() => onLogin(name.trim() || 'Explorer')}>Enter Workspace</button>
      </div>
    </div>
  );
};

const App = () => {
  const [view, setView] = useState<'landing' | 'login' | 'dashboard'>('landing');
  const [user, setUser] = useState<AppUser | null>(null);

  // With Firebase on, auth state is the source of truth for who is signed in.
  useEffect(() => {
    if (!firebaseEnabled || !auth) return;
    const unsub = onAuthStateChanged(auth, (fbUser) => {
      if (fbUser) {
        setUser({
          name: fbUser.displayName || fbUser.email || 'Explorer',
          getToken: () => fbUser.getIdToken(),
        });
        setView('dashboard');
      } else {
        setUser(null);
        setView((v) => (v === 'dashboard' ? 'login' : v));
      }
    });
    return unsub;
  }, []);

  const handleLogout = () => {
    if (firebaseEnabled && auth) {
      signOut(auth);
      setView('landing');
    } else {
      setUser(null);
      setView('landing');
    }
  };

  if (view === 'landing') return <LandingPage onStart={() => setView('login')} />;
  if (view === 'login') return <LoginPage onLogin={(n) => { setUser({ name: n }); setView('dashboard'); }} />;
  return <Dashboard user={user!} onLogout={handleLogout} />;
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
