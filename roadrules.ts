/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Known road rules on Indian road-trip routes: forest night closures, permits,
 * seasonal pass closures and rain-time ghat bans that general trip planners don't know
 * about. South India is below; the rest of India is in roadrules-india.ts.
 * Used by the browser (to check each drive against them) and by the planner
 * prompt (so new plans avoid them in the first place).
 *
 * Every rule lists its sources and when it was last checked. Rules change, so
 * anything not long-standing is marked "check" and the app says so.
 */

import { PAN_INDIA_RULES } from './roadrules-india';

export type RuleKind =
  | 'night-closure' // a road shut every night (closed.from–closed.to)
  | 'permit' // a permit, registration or entry fee needed to enter the area
  | 'no-tourists' // closed to tourist vehicles
  | 'on-alert' // restrictions that apply on alert days (rain, snow, unrest)
  | 'seasonal-closure' // shut for part of the year (season = when it is closed)
  | 'no-outside-cars' // cars registered outside the state can't use these roads
  | 'advisory'; // worth knowing on this route; never stops the drive by itself

/**
 * How sure we are, from the source that was actually read:
 *  A: an official page was read; its figures can be shown.
 *  B: reported by reliable news; the app says "reported, confirm".
 *  C: only travel blogs; the app gives no figures and says "check the official portal".
 */
export type Grade = 'A' | 'B' | 'C';

export interface RoadRule {
  id: string;
  name: string;
  region: string; // for grouping, e.g. "Ladakh", "Himachal Pradesh"
  kind: RuleKind;
  /** 'standing': long-running and confirmed in recent reports; 'check': confirm before travelling. */
  certainty: 'standing' | 'check';
  grade: Grade;
  /** Areas the rule covers: a point and radius in km. A drive passing through any of them is affected. */
  zones: { lat: number; lon: number; km: number }[];
  /** Words that identify the area in plan text, used when the map check hasn't measured the drive. */
  keywords: string[];
  /** For closures: local time the road shuts and reopens, "HH:MM". */
  closed?: { from: string; to: string };
  /**
   * Part of the year, as "MM-DD" (the end may be earlier than the start: it wraps past New Year).
   * For a seasonal closure it is when the road is shut; for anything else it is when the rule applies.
   */
  season?: { from: string; to: string };
  /** Rules that depend on the car. Missing car details mean the rule is shown, worded as "if…". */
  vehicle?: {
    outsideState?: string; // applies only to cars registered outside this state (code, e.g. "HP")
    maxAgeYears?: number; // cars older than this are refused
    exemptFuels?: string[]; // e.g. ["Electric", "CNG"]
    oldEmissionNorms?: boolean; // applies to BS-III petrol and BS-IV diesel cars
    minClearanceMm?: number;
  };
  /** Override the level the rule shows at. */
  level?: 'blocker' | 'warning' | 'todo' | 'caution';
  summary: string;
  whatToDo: string;
  link?: { label: string; url: string };
  sources: { title: string; url: string }[];
  checked: string; // YYYY-MM-DD: when the sources were last read
  reviewBy: string; // YYYY-MM-DD: after this the app says the rule is due for a re-check
}

const SOUTH_RULES: RoadRule[] = [
  {
    id: 'bandipur-mudumalai-night',
    name: 'Bandipur–Mudumalai forest night closure',
    kind: 'night-closure',
    region: 'Karnataka / Tamil Nadu',
    certainty: 'standing',
    grade: 'B',
    zones: [
      { lat: 11.664, lon: 76.633, km: 14 }, // Bandipur Tiger Reserve on the Gundlupet–Ooty and Mysuru–Wayanad highways
      { lat: 11.568, lon: 76.592, km: 9 }, // Theppakadu, Mudumalai
    ],
    keywords: ['bandipur', 'mudumalai', 'theppakadu', 'gundlupet', 'muthanga', 'kakkanhalla'],
    closed: { from: '21:00', to: '06:00' },
    summary: 'The highways through Bandipur and Mudumalai are closed to traffic from 9 pm to 6 am. Vehicles arriving late wait at the checkpost until morning.',
    whatToDo: 'Plan to clear the forest stretch well before 9 pm, or stay the night before it.',
    sources: [
      { title: 'Kerala Kaumudi: 14 years of the Bandipur night ban (Oct 2026)', url: 'https://keralakaumudi.com/en/kerala/general/14-years-since-bandipur-night-traffic-ban-travel-woes-continue-for-malayalees-1517117' },
      { title: 'Trekgo: Ooty from Bangalore via Bandipur', url: 'https://trekgo.in/blog/how-to-reach-ooty-from-bangalore-via-mysore-and-bandipur' },
    ],
    checked: '2026-11-10',
    reviewBy: '2027-02-10',
  },
  {
    id: 'kalhatty-no-tourists',
    name: 'Kalhatty ghat (Masinagudi → Ooty) closed to tourist vehicles',
    kind: 'no-tourists',
    region: 'Tamil Nadu',
    certainty: 'check',
    grade: 'A',
    zones: [{ lat: 11.475, lon: 76.665, km: 6 }],
    keywords: ['kalhatty', 'kalhatti', 'masinagudi'],
    summary: 'A Nilgiris district notice (29 April 2026) says tourist vehicles are not permitted on the Kalhatti road; reports describe it as a seasonal measure.',
    whatToDo: 'Plan the Theppakadu → Gudalur → Ooty route instead, and confirm with the Nilgiris control room (1077) before you go.',
    sources: [
      { title: 'Nilgiris district notice, P.R. No. 220 (29 Apr 2026)', url: 'https://nilgiris.nic.in/?p=60435' },
      { title: 'Onmanorama: Masinagudi travel restrictions (Sep 2026)', url: 'https://www.onmanorama.com/travel/kerala/2026/09/26/masinagudi-travel-restrictions.html' },
    ],
    checked: '2026-11-10',
    reviewBy: '2027-02-10',
  },
  {
    id: 'nilgiris-epass',
    name: 'E-pass for vehicles entering the Nilgiris (Ooty)',
    kind: 'permit',
    region: 'Tamil Nadu',
    certainty: 'check',
    grade: 'B',
    zones: [{ lat: 11.41, lon: 76.7, km: 22 }],
    keywords: ['ooty', 'udhagamandalam', 'nilgiris', 'coonoor', 'kotagiri', 'gudalur'],
    summary: 'Under Madras High Court orders, tourist vehicles from outside the district have needed an e-pass, with daily vehicle limits in peak season. Whether it applies on your dates isn\'t confirmed.',
    whatToDo: 'Check the official e-pass portal a few days before and apply if it is required.',
    link: { label: 'Official e-pass portal', url: 'https://epass.tnega.org/home' },
    sources: [
      { title: 'LiveLaw: Supreme Court declines to interfere with vehicle limits', url: 'https://www.livelaw.in/top-stories/supreme-court-declines-to-interfere-with-madras-hc-order-limiting-tourist-vehicles-in-nilgiris-kodaikanal-287855' },
      { title: 'Outlook Traveller: e-pass for Ooty and Kodaikanal', url: 'https://www.outlooktraveller.com/whats-new/now-tourists-need-an-e-pass-to-enter-ooty-and-kodaikanal' },
    ],
    checked: '2026-11-10',
    reviewBy: '2027-02-10',
  },
  {
    id: 'kodaikanal-epass',
    name: 'E-pass for vehicles entering Kodaikanal',
    kind: 'permit',
    region: 'Tamil Nadu',
    certainty: 'check',
    grade: 'B',
    zones: [{ lat: 10.238, lon: 77.489, km: 14 }],
    keywords: ['kodaikanal', 'kodai'],
    summary: 'Under Madras High Court orders, tourist vehicles have needed an e-pass for Kodaikanal, with daily vehicle limits in peak season. Whether it applies on your dates isn\'t confirmed.',
    whatToDo: 'Check the official e-pass portal a few days before and apply if it is required.',
    link: { label: 'Official e-pass portal', url: 'https://epass.tnega.org/home' },
    sources: [
      { title: 'LiveLaw: Supreme Court declines to interfere with vehicle limits', url: 'https://www.livelaw.in/top-stories/supreme-court-declines-to-interfere-with-madras-hc-order-limiting-tourist-vehicles-in-nilgiris-kodaikanal-287855' },
      { title: 'Outlook Traveller: Kodaikanal and Ooty e-pass extended', url: 'https://outlooktraveller.com/travelnews/whats-new/kodaikanal-and-ooty-e-pass-extended-heres-all-you-need-to-know-about-it' },
    ],
    checked: '2026-11-10',
    reviewBy: '2027-02-10',
  },
  {
    id: 'sathyamangalam-night',
    name: 'Sathyamangalam forest (Bannari–Hasanur, Dhimbam ghat) night ban',
    kind: 'night-closure',
    region: 'Tamil Nadu',
    certainty: 'check',
    grade: 'B',
    zones: [{ lat: 11.615, lon: 77.165, km: 12 }],
    keywords: ['bannari', 'hasanur', 'dhimbam', 'dimbam', 'sathyamangalam', 'thalavadi'],
    closed: { from: '21:00', to: '06:00' },
    summary: 'Night traffic on the Bannari–Hasanur road through the Sathyamangalam Tiger Reserve has been banned under Collector and High Court orders (cars from 9 pm to 6 am under the original order; stricter limits for heavy vehicles). Current timings aren\'t confirmed.',
    whatToDo: 'Plan to cross in daylight, and check the current timings with the Erode district administration.',
    sources: [
      { title: 'DT Next: HC bans night traffic on Bannari road (Feb 2022)', url: 'https://www.dtnext.in/tamilnadu/2022/02/08/hc-bans-vehicular-traffic-at-night-on-bannari-road-from-feb-10' },
      { title: 'The Hans India: HC upholds night ban in tiger reserve', url: 'https://www.thehansindia.com/tamilnadu/chennai-hc-upholds-night-vehicular-traffic-ban-in-tiger-reserve-728411' },
    ],
    checked: '2026-11-10',
    reviewBy: '2027-02-10',
  },
  {
    id: 'idukki-alert-night',
    name: 'Idukki hill roads: night bans on heavy-rain alert days',
    kind: 'on-alert',
    region: 'Kerala',
    certainty: 'check',
    grade: 'B',
    zones: [
      { lat: 10.089, lon: 77.06, km: 25 }, // Munnar, Devikulam, Gap Road
      { lat: 9.604, lon: 77.165, km: 18 }, // Kumily, Thekkady
      { lat: 9.686, lon: 76.905, km: 14 }, // Vagamon
      { lat: 9.752, lon: 77.115, km: 14 }, // Kattappana, Idukki
    ],
    keywords: ['munnar', 'idukki', 'devikulam', 'gap road', 'vagamon', 'thekkady', 'kumily', 'peermade', 'kattappana'],
    closed: { from: '19:00', to: '06:00' },
    summary: 'On orange or red rain-alert days the Idukki Collector often bans travel on hill roads from 7 pm to 6 am (most recently found: 7 June 2026), and the Munnar Gap Road has been closed for days at a time.',
    whatToDo: 'Finish ghat drives by evening, and check the weather alert for Idukki the day before.',
    sources: [
      { title: 'Onmanorama: Idukki night travel ban, 7 pm–6 am (Jun 2026)', url: 'https://www.onmanorama.com/news/kerala/2026/06/07/kerala-news-idukki-travel-ban-orange-alert.html' },
      { title: 'Onmanorama: Munnar Gap Road closed (Jun 2025)', url: 'https://www.onmanorama.com/news/kerala/2025/06/13/night-travel-banned-on-munnar-gap-road-until-june-17.html' },
    ],
    checked: '2026-11-10',
    reviewBy: '2027-02-10',
  },
  {
    id: 'wayanad-ghat-alert',
    name: 'Wayanad (Thamarassery) ghat: restrictions after landslides',
    kind: 'on-alert',
    region: 'Kerala',
    certainty: 'check',
    grade: 'B',
    zones: [{ lat: 11.505, lon: 76.01, km: 8 }],
    keywords: ['thamarassery', 'lakkidi', 'wayanad ghat', 'adivaram'],
    summary: 'The Kozhikode–Wayanad ghat road has had traffic restrictions after landslides and heavy rain (reported in Aug 2025, Jan 2026 and Jun 2026).',
    whatToDo: 'Check current traffic restrictions on the ghat the day before, especially in the monsoon.',
    sources: [
      { title: 'Onmanorama: Wayanad ghat road disruptions (Jun 2026)', url: 'https://www.onmanorama.com/kerala/top-news/2026/06/15/wayanad-ghat-road-disruptions.html' },
      { title: 'Onmanorama: traffic restriction on Wayanad ghat roads (Jan 2026)', url: 'https://www.onmanorama.com/news/kerala/2026/01/04/traffic-restriction-wayanad-ghat-roads.html' },
    ],
    checked: '2026-11-10',
    reviewBy: '2027-02-10',
  },
];

/** State and union territory codes, as on number plates (Odisha is OD, Telangana TS, Uttarakhand UK). */
export const STATE_NAMES: Record<string, string> = {
  AN: 'Andaman & Nicobar', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar', CG: 'Chhattisgarh',
  CH: 'Chandigarh', DD: 'Dadra & Nagar Haveli and Daman & Diu', DL: 'Delhi', GA: 'Goa', GJ: 'Gujarat', HP: 'Himachal Pradesh',
  HR: 'Haryana', JH: 'Jharkhand', JK: 'Jammu & Kashmir', KA: 'Karnataka', KL: 'Kerala', LA: 'Ladakh', LD: 'Lakshadweep',
  MH: 'Maharashtra', ML: 'Meghalaya', MN: 'Manipur', MP: 'Madhya Pradesh', MZ: 'Mizoram', NL: 'Nagaland', OD: 'Odisha',
  PB: 'Punjab', PY: 'Puducherry', RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TR: 'Tripura', TS: 'Telangana',
  UK: 'Uttarakhand', UP: 'Uttar Pradesh', WB: 'West Bengal',
};

/** Every rule IntelliTrip knows, South India first. */
export const ROAD_RULES: RoadRule[] = [...SOUTH_RULES, ...PAN_INDIA_RULES];

const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether plan or trip text names one of the rule's places (whole words, so "gir" doesn't match "girl"). */
export const mentionsRule = (rule: RoadRule, text: string) =>
  rule.keywords.some((k) => new RegExp(`(^|[^a-z])${esc(k.toLowerCase())}([^a-z]|$)`).test(text.toLowerCase()));

/** The known rules for the planner, limited to the ones whose places appear in this trip's text. */
export function rulesForPrompt(text: string): string {
  const hits = ROAD_RULES.filter((r) => mentionsRule(r, text)).slice(0, 25);
  if (!hits.length) return '(none of the rules IntelliTrip knows apply to the places in this trip)';
  return hits.map((r) =>
    `- ${r.name}${r.closed ? ` (closed ${r.closed.from}–${r.closed.to})` : ''}${r.season ? ` [${r.kind === 'seasonal-closure' ? 'closed' : 'applies'} ${r.season.from} to ${r.season.to}]` : ''}: ${r.whatToDo}${r.certainty === 'check' ? ' [confirm current status]' : ''}`
  ).join('\n');
}
