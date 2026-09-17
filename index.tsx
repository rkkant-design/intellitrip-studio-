/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// --- TYPES ---

type TravelType = 'Family' | 'Solo' | 'Group' | 'Luxury' | 'Adventure' | 'Romantic';
type ActiveTab = 'planner' | 'radar' | 'archives';

interface FormState {
  fromLocation: string;
  destination: string;
  startDate: string;
  duration: number | '';
  adults: number;
  children: number;
  travelType: TravelType;
  idealTripDescription: string;
}

interface Activity {
  time: string;
  name: string;
  description: string;
  heroMoment: string;
}

interface LiveAlert {
  condition: 'Crowded' | 'Weather' | 'Traffic' | 'Closure';
  description: string;
  alternativeSuggestion: string;
}

interface Accommodation {
  name: string;
  type: string;
  reason: string;
  estimatedPricePerNight: number;
}

interface DayPlan {
  day: number;
  theme: string;
  vibe?: string;
  narrative: string;
  localSecret: string;
  activities: Activity[];
  liveAlerts: LiveAlert[];
}

interface CostBreakdown {
  totalAccommodation: number;
  totalFood: number;
  totalMisc: number;
}

interface ItineraryResults {
  tripTitle: string;
  tripSummary: string;
  overallTripTotalCost: number;
  accommodationRecommendation: Accommodation;
  costBreakdown: CostBreakdown;
  dailyItinerary: DayPlan[];
}

interface SavedTrip {
  id: string;
  results: ItineraryResults;
  form: FormState;
  vibeImage: string | null;
  dateCreated: string;
}

// --- UTILITIES ---

const STORAGE_KEY = 'intellitrip_v5_saved';

const formatINR = (n: number | undefined | null): string =>
  `₹${Number(n ?? 0).toLocaleString('en-IN')}`;

const loadArchives = (): SavedTrip[] => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('Could not read archives from storage; starting fresh.', e);
    return [];
  }
};

// --- COMPONENTS ---

const LoadingStage = ({ destination }: { destination: string }) => {
  const messages = [
    'Consulting local informants...',
    'Scanning satellite imagery...',
    'Curating atmospheric vibes...',
    'Optimizing logistics...',
    'Finalizing architecture...',
  ];
  const [msg, setMsg] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setMsg((m) => (m + 1) % messages.length), 2500);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="loading-container" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true"></div>
      <h3>{messages[msg]}</h3>
      <p>Building your journey to {destination}</p>
    </div>
  );
};

const Toast = ({ message }: { message: string }) => (
  <div className="toast" role="status" aria-live="polite">
    {message}
  </div>
);

// --- MAIN DASHBOARD ---

const Dashboard: React.FC<{ user: { name: string }; onLogout: () => void }> = ({ user, onLogout }) => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('planner');
  const [form, setForm] = useState<FormState>({
    fromLocation: '',
    destination: '',
    startDate: '',
    duration: 3,
    adults: 2,
    children: 0,
    travelType: 'Family',
    idealTripDescription: '',
  });

  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ItineraryResults | null>(null);
  const [vibeImage, setVibeImage] = useState<string | null>(null);
  const [isTripCommenced, setIsTripCommenced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archives, setArchives] = useState<SavedTrip[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setArchives(loadArchives());
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2800);
  }, []);

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const generateItinerary = async () => {
    const duration = Number(form.duration);
    if (!form.destination.trim() || !form.fromLocation.trim() || !form.startDate) {
      setError('Please fill in Origin, Destination, and Date.');
      return;
    }
    if (!duration || duration < 1) {
      setError('Please enter at least 1 night.');
      return;
    }

    setLoading(true);
    setError(null);
    setResults(null);
    setVibeImage(null);
    setIsTripCommenced(false);

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to generate. Please try again.');
      }

      const data = await res.json();
      if (!data.itinerary) throw new Error('The curation engine returned no itinerary.');

      setResults(data.itinerary as ItineraryResults);
      setVibeImage((data.vibeImage as string | null) ?? null);
    } catch (err: any) {
      setError(err?.message || 'Failed to generate. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const persistArchives = (updated: SavedTrip[]) => {
    // Base64 hero images are large; if we hit the storage quota, retry without
    // the images rather than losing the save entirely.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      return true;
    } catch {
      try {
        const lean = updated.map((t) => ({ ...t, vibeImage: null }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(lean));
        setArchives(lean);
        showToast('Trip archived (image omitted to save space).');
        return true;
      } catch {
        showToast('Storage is full — could not archive this trip.');
        return false;
      }
    }
  };

  const saveTrip = () => {
    if (!results) return;
    const newEntry: SavedTrip = {
      id: Date.now().toString(),
      results,
      form,
      vibeImage,
      dateCreated: new Date().toLocaleDateString(),
    };
    const updated = [newEntry, ...archives];
    if (persistArchives(updated)) {
      setArchives(updated);
      showToast('Trip archived successfully.');
    }
  };

  const openArchived = (trip: SavedTrip) => {
    setResults(trip.results);
    setForm(trip.form);
    setVibeImage(trip.vibeImage);
    setIsTripCommenced(false);
    setActiveTab('planner');
  };

  const cost = results?.costBreakdown;
  const stay = results?.accommodationRecommendation;

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
      </nav>

      <main className="content">
        {activeTab === 'planner' && (
          <>
            {!results && !loading && (
              <div className="card form-card animate-fade-in">
                <h2>Plan New Adventure</h2>
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="fromLocation">From</label>
                    <input id="fromLocation" name="fromLocation" value={form.fromLocation} onChange={handleInputChange} placeholder="e.g. Mumbai" />
                  </div>
                  <div className="field">
                    <label htmlFor="destination">To</label>
                    <input id="destination" name="destination" value={form.destination} onChange={handleInputChange} placeholder="e.g. Kyoto" />
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
                <div className="field">
                  <label htmlFor="idealTripDescription">Describe your ideal experience</label>
                  <textarea id="idealTripDescription" name="idealTripDescription" value={form.idealTripDescription} onChange={handleInputChange} placeholder="e.g. Wheelchair accessible, slow-paced, great street food..." />
                </div>
                {error && <p className="error" role="alert">{error}</p>}
                <button className="btn-primary" onClick={generateItinerary}>Curate Journey</button>
              </div>
            )}

            {loading && <LoadingStage destination={form.destination} />}

            {results && (
              <div className="results-container animate-fade-in">
                <div className="results-header">
                  <div className="title-group">
                    <h2>{results.tripTitle}</h2>
                    <p>{results.tripSummary}</p>
                  </div>
                  <div className="action-btns">
                    <button onClick={saveTrip} className="btn-secondary">Archive</button>
                    <button onClick={() => { setIsTripCommenced(true); setActiveTab('radar'); }} className="btn-accent">Commence Journey</button>
                    <button onClick={() => { setResults(null); setVibeImage(null); }} className="btn-icon-bg" aria-label="Close itinerary">
                      <span className="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                  </div>
                </div>

                {vibeImage && (
                  <div className="results-vibe-hero card animate-fade-in">
                    <img src={vibeImage} alt={`Scenery of ${form.destination}`} />
                  </div>
                )}

                <div className="results-grid">
                  <div className="itinerary-list">
                    {results.dailyItinerary?.map((day) => (
                      <div key={day.day} className="day-card card">
                        <div className="day-head">
                          <span className="day-num">Day {day.day}</span>
                          <h3>{day.theme}</h3>
                        </div>
                        <p className="day-narrative">{day.narrative}</p>
                        {day.localSecret && (
                          <div className="local-secret">
                            <span className="material-symbols-outlined" aria-hidden="true">vpn_key</span>
                            <div>
                              <strong>Local Secret:</strong> {day.localSecret}
                            </div>
                          </div>
                        )}
                        <div className="activities">
                          {day.activities?.map((act, i) => (
                            <div key={i} className="activity-item">
                              <span className="act-time">{act.time}</span>
                              <div className="act-info">
                                <strong>{act.name}</strong>
                                <p>{act.description}</p>
                                {act.heroMoment && (
                                  <span className="hero-moment">✨ Hero Moment: {act.heroMoment}</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  <aside className="summary-sidebar">
                    {stay && (
                      <div className="card info-card">
                        <h3>Stay Recommendation</h3>
                        <div className="stay-info">
                          <strong>{stay.name}</strong>
                          <span className="tag">{stay.type}</span>
                          <p>{stay.reason}</p>
                          <div className="cost-line">Est. {formatINR(stay.estimatedPricePerNight)}/night</div>
                        </div>
                      </div>
                    )}
                    <div className="card budget-card">
                      <h3>Investment Summary</h3>
                      <div className="budget-item"><span>Stays</span> <strong>{formatINR(cost?.totalAccommodation)}</strong></div>
                      <div className="budget-item"><span>Food</span> <strong>{formatINR(cost?.totalFood)}</strong></div>
                      <div className="budget-item"><span>Misc</span> <strong>{formatINR(cost?.totalMisc)}</strong></div>
                      <div className="total-line"><span>Total</span> <strong>{formatINR(results.overallTripTotalCost)}</strong></div>
                    </div>
                  </aside>
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'radar' && (
          <div className="radar-view animate-fade-in">
            <div className="radar-head">
              <h2>Trip Environmental Briefing</h2>
              <p>Curated context for <strong>{form.destination}</strong></p>
            </div>

            <div className="radar-grid-layout">
              <div className="alerts-feed">
                {results?.dailyItinerary?.map((day) => (
                  <div key={day.day} className="radar-day-section">
                    <h4>Day {day.day} Contextual Updates</h4>
                    {day.liveAlerts?.map((alert, idx) => (
                      <div key={idx} className={`alert-card ${alert.condition.toLowerCase()}`}>
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
                          {alert.condition} Advisory
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
                  <div className="metric"><span>Density</span><strong>Moderate</strong></div>
                  <div className="metric"><span>Climate</span><strong>Stable</strong></div>
                  <div className="metric"><span>Transit</span><strong>Fluent</strong></div>
                </div>
                <p className="radar-note">Advisories are generated with your itinerary as planning guidance.</p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'archives' && (
          <div className="archives-view animate-fade-in">
            <h2>Your Journey Archives</h2>
            {archives.length === 0 ? (
              <p className="empty-msg">No journeys preserved yet.</p>
            ) : (
              <div className="archive-list">
                {archives.map((trip) => (
                  <button key={trip.id} className="card archive-card" onClick={() => openArchived(trip)}>
                    <div className="arc-info">
                      <strong>{trip.results.tripTitle}</strong>
                      <span>{trip.form.destination} • {trip.dateCreated}</span>
                    </div>
                    <span className="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {toast && <Toast message={toast} />}
    </div>
  );
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
        <p>A Gemini-powered curation engine builds tailored, cinematic narratives for every journey.</p>
      </div>
      <div className="feature-card card">
        <span className="material-symbols-outlined feature-icon" aria-hidden="true">radar</span>
        <h3>Trip Briefing</h3>
        <p>Context-aware advisories flag likely crowd spikes, weather shifts, and closures along your route.</p>
      </div>
      <div className="feature-card card">
        <span className="material-symbols-outlined feature-icon" aria-hidden="true">vpn_key</span>
        <h3>Local Secrets</h3>
        <p>Uncover hidden gems and a "Hero Moment" for every stop, curated by the AI architect.</p>
      </div>
      <div className="feature-card card">
        <span className="material-symbols-outlined feature-icon" aria-hidden="true">account_balance_wallet</span>
        <h3>Budget Logic</h3>
        <p>Precise cost breakdowns in INR, optimized for group savings and high-value stays.</p>
      </div>
    </section>
  </div>
);

const LoginPage = ({ onLogin }: { onLogin: (n: string) => void }) => {
  const [name, setName] = useState('');
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
  const [user, setUser] = useState<{ name: string } | null>(null);

  if (view === 'landing') return <LandingPage onStart={() => setView('login')} />;
  if (view === 'login') return <LoginPage onLogin={(n) => { setUser({ name: n }); setView('dashboard'); }} />;
  return <Dashboard user={user!} onLogout={() => setView('landing')} />;
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
