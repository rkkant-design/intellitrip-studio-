/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Known road rules on South Indian road-trip routes: forest night closures,
 * permits and rain-time ghat bans that general trip planners don't know about.
 * Used by the browser (to check each drive against them) and by the planner
 * prompt (so new plans avoid them in the first place).
 *
 * Every rule lists its sources and when it was last checked. Rules change, so
 * anything not long-standing is marked "check" and the app says so.
 */

export type RuleKind = 'night-closure' | 'permit' | 'no-tourists' | 'on-alert';

export interface RoadRule {
  id: string;
  name: string;
  kind: RuleKind;
  /** 'standing': long-running and confirmed in recent reports; 'check': confirm before travelling. */
  certainty: 'standing' | 'check';
  /** Areas the rule covers: a point and radius in km. A drive passing through any of them is affected. */
  zones: { lat: number; lon: number; km: number }[];
  /** Words that identify the area in plan text, used when the map check hasn't measured the drive. */
  keywords: string[];
  /** For closures: local time the road shuts and reopens, "HH:MM". */
  closed?: { from: string; to: string };
  summary: string;
  whatToDo: string;
  link?: { label: string; url: string };
  sources: { title: string; url: string }[];
  checked: string; // YYYY-MM-DD
}

export const ROAD_RULES: RoadRule[] = [
  {
    id: 'bandipur-mudumalai-night',
    name: 'Bandipur–Mudumalai forest night closure',
    kind: 'night-closure',
    certainty: 'standing',
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
  },
  {
    id: 'kalhatty-no-tourists',
    name: 'Kalhatty ghat (Masinagudi → Ooty) closed to tourist vehicles',
    kind: 'no-tourists',
    certainty: 'check',
    zones: [{ lat: 11.475, lon: 76.665, km: 6 }],
    keywords: ['kalhatty', 'kalhatti', 'masinagudi'],
    summary: 'A Nilgiris district notice (29 April 2026) says tourist vehicles are not permitted on the Kalhatti road; reports describe it as a seasonal measure.',
    whatToDo: 'Plan the Theppakadu → Gudalur → Ooty route instead, and confirm with the Nilgiris control room (1077) before you go.',
    sources: [
      { title: 'Nilgiris district notice, P.R. No. 220 (29 Apr 2026)', url: 'https://nilgiris.nic.in/?p=60435' },
      { title: 'Onmanorama: Masinagudi travel restrictions (Sep 2026)', url: 'https://www.onmanorama.com/travel/kerala/2026/09/26/masinagudi-travel-restrictions.html' },
    ],
    checked: '2026-11-10',
  },
  {
    id: 'nilgiris-epass',
    name: 'E-pass for vehicles entering the Nilgiris (Ooty)',
    kind: 'permit',
    certainty: 'check',
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
  },
  {
    id: 'kodaikanal-epass',
    name: 'E-pass for vehicles entering Kodaikanal',
    kind: 'permit',
    certainty: 'check',
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
  },
  {
    id: 'sathyamangalam-night',
    name: 'Sathyamangalam forest (Bannari–Hasanur, Dhimbam ghat) night ban',
    kind: 'night-closure',
    certainty: 'check',
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
  },
  {
    id: 'idukki-alert-night',
    name: 'Idukki hill roads: night bans on heavy-rain alert days',
    kind: 'on-alert',
    certainty: 'check',
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
  },
  {
    id: 'wayanad-ghat-alert',
    name: 'Wayanad (Thamarassery) ghat: restrictions after landslides',
    kind: 'on-alert',
    certainty: 'check',
    zones: [{ lat: 11.505, lon: 76.01, km: 8 }],
    keywords: ['thamarassery', 'lakkidi', 'wayanad ghat', 'adivaram'],
    summary: 'The Kozhikode–Wayanad ghat road has had traffic restrictions after landslides and heavy rain (reported in Aug 2025, Jan 2026 and Jun 2026).',
    whatToDo: 'Check current traffic restrictions on the ghat the day before, especially in the monsoon.',
    sources: [
      { title: 'Onmanorama: Wayanad ghat road disruptions (Jun 2026)', url: 'https://www.onmanorama.com/kerala/top-news/2026/06/15/wayanad-ghat-road-disruptions.html' },
      { title: 'Onmanorama: traffic restriction on Wayanad ghat roads (Jan 2026)', url: 'https://www.onmanorama.com/news/kerala/2026/01/04/traffic-restriction-wayanad-ghat-roads.html' },
    ],
    checked: '2026-11-10',
  },
];

/** One line per rule for the planner prompt, so plans avoid them from the start. */
export const ROAD_RULES_FOR_PROMPT = ROAD_RULES.map((r) =>
  `- ${r.name}${r.closed ? ` (closed ${r.closed.from}–${r.closed.to})` : ''}: ${r.whatToDo}${r.certainty === 'check' ? ' [confirm current status]' : ''}`
).join('\n');
