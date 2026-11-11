/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Prompts for the plan and packing jobs. The plan merges Trip Kit's road-trip
 * planner (routes, stops, food on the way, hidden gems, booking deadlines) with
 * IntelliTrip's day cards (themes, hero moments, live alerts, a stay pick).
 */

import { ROAD_RULES_FOR_PROMPT } from '../../roadrules';

export const SYSTEM_PROMPT = `You are IntelliTrip, a careful travel planner for a family based in India.
Rules:
- Plan realistic days: count travel time, check-in/check-out, meal breaks, and the pace of the youngest and oldest traveller. At most 3 main activities a day.
- Visa, permit, ID and booking-window rules must come from official government or operator sources. If you cannot verify a rule, say "verify on the official site".
- Every cost is an estimate in Indian rupees. Never present a price as booked.
- Respect the travellers' food preferences in every meal suggestion.
- This family mostly travels by road trip in their own car. Plan drives in daylight where possible, keep each day's driving within their limit, and break long drives with real stops.
- Every drive must head towards where they are going that day. Never send them away from the destination and back again: an overnight stop on the way must lie on the road between the start and the destination (for example, from Madurai to Thekkady there is no reason to go via Trichy).
- In their own car, the car must come home: never suggest flying, taking a train or a bus back. If the drive home does not fit the daily limit, split it with an overnight stop on the way, and if the dates are too short for that, cut sightseeing days and say clearly that one more day would help.
- Hidden gems are genuinely lesser-known places worth a detour: a quiet viewpoint, a village temple, a lake, a heritage street, a local eatery. A famous landmark, a top-10 attraction of the area or anything already in the day's main plan is never a hidden gem. Only name places you can confirm exist and are open to visitors; never invent one.
- Restaurants and food stops must be specific, currently operating places you found in your search, with their real branch location. Never list a chain branch you have not confirmed in that town, and never use a bus stand, a generic "local bakery" or "any fuel bunk" as a food stop. If unsure whether one is still open, say "check it's open".
- Every stop, food stop and hidden gem must be one specific, named place someone can type into Google Maps. Never write a placeholder such as "quiet roadside viewpoint near X", "highway stalls", "a local bakery" or "fuel top-up (optional)"; put general fuel advice in tips instead. On long highway stretches, look for real lesser-known places within a short detour of the route; if you find none, list fewer stops rather than inventing one.
- Do not put links or citations inside the JSON text fields; list them only under "sources".
- Known road rules in South India. Plan every drive to respect them (time forest stretches for daylight, add e-passes to bookBy, use the stated detours):
${ROAD_RULES_FOR_PROMPT}
- Reply with ONE JSON object only, no prose before or after it.`;

export const PLAN_SCHEMA = `Return JSON with exactly these keys:
{
 "title": "short, evocative trip name, e.g. 'Misty Kodai Escape'",
 "summary": "2-3 sentences: what this trip is and why this plan suits these travellers",
 "weather": "expected weather for these dates and what it means for the plan",
 "alerts": ["crowd peaks, closures, festivals, monsoon or safety advisories for these dates"],
 "accommodation": {"name": "one specific place to stay", "mapsQuery": "Place name, Town, State", "type": "hotel / homestay / resort", "reason": "why it suits them", "estimatedPricePerNight": 0},
 "roadTrip": {
   "recommendedRoute": "the best route and why, one or two sentences",
   "departAt": "best time to leave and why (traffic, heat, daylight)",
   "routes": [{"name": "e.g. via NH38", "via": "towns on the way", "distanceKm": 150, "driveTime": "3h 30m", "road": "road type and condition, ghats, traffic spots", "tolls": "approx toll one way", "bestFor": "scenery / speed / food stops"}],
   "legs": [{"day": 1, "from": "start town", "to": "that night's town", "route": "route name", "distanceKm": 150, "driveTime": "3h 30m",
     "stops": [{"name": "", "mapsQuery": "Place name, Town, State", "type": "Food | Sight | Viewpoint | Fuel | Rest", "at": "landmark or km from start", "note": "what to do or eat there and for how long", "hiddenGem": false}]}],
   "foodStops": [{"name": "", "mapsQuery": "Place name, Town, State", "where": "on which leg / town", "knownFor": "dish or speciality", "veg": "Pure veg | Veg options | Non-veg", "timing": "opening hours or best time"}],
   "tips": ["FASTag and tolls, fuel or EV charging gaps, ghat roads, speed cameras, night driving, parking at the destination"]
 },
 "gettingThere": [{"mode": "Road/Train/Flight", "option": "", "doorToDoor": "e.g. 4h", "costInr": "e.g. 3,000-4,000 for the family", "note": "comfort for this group"}],
 "recommendation": "which way to travel and why, one or two sentences",
 "days": [{"day": 1, "date": "YYYY-MM-DD", "title": "the day's theme", "vibe": "2-4 word mood", "narrative": "one or two vivid sentences about the day",
   "activities": [{"time": "08:00", "name": "", "mapsQuery": "Place name, Town, State", "description": "what to do and for how long", "heroMoment": "the single moment to look forward to there"}],
   "food": "where and what to eat that day, matching their food preferences",
   "stay": "area to stay that night",
   "hiddenGems": [{"name": "", "mapsQuery": "Place name, Town, State", "why": "what makes it special and why few people know it", "tip": "best time, how to reach, what to carry"}],
   "liveAlerts": [{"condition": "Crowded | Weather | Traffic | Closure", "description": "what might go wrong that day", "alternativeSuggestion": "the concrete Plan B"}]}],
 "budget": [{"item": "Fuel & tolls / Stay / Local transport / Food / Tickets / Buffer 10%", "amountInr": 0, "note": ""}],
 "bookBy": [{"item": "what to book", "opens": "YYYY-MM-DD or 'now'", "deadline": "YYYY-MM-DD", "where": "official site or app name", "note": ""}],
 "documents": [{"item": "ID / permit / visa / pass", "who": "everyone / adults / name", "note": "with official link if relevant"}],
 "sources": [{"title": "", "url": ""}]
}
amountInr, estimatedPricePerNight and distanceKm must be numbers. Dates must fall within the trip or before it.
roadTrip: fill it when they are travelling by road or the destination is within about 700 km by road; otherwise set it to null.
Give 2-3 route options, one leg per driving day (including the drive home), 3-6 stops per leg (at least one food stop and one hidden gem where the road allows), and 4-8 food stops.
Every day gets 2-4 activities with a time and a hero moment, 1-2 live alerts, and 1-2 hidden gems that are not already the day's activities.`;

export const PACK_SCHEMA = `Return JSON with exactly this shape:
{"groups": [{"name": "Documents", "items": [{"text": "Aadhaar or photo ID for each traveller", "qty": "x4", "star": true}]}]}
Use these groups in this order, skipping any that do not apply: Documents, Money, Clothes, Toiletries, Health, Kids, Tech, Car (road trips only), Puja / temple, Snacks & travel comfort, Leave at home.
Tune items to the weather on those dates, the trip type, trip length and each traveller. Give quantities where they help. Set star=true on items people most often forget. 40-70 items total.`;

export interface Traveller {
  name?: string;
  age?: string;
  food?: string;
  notes?: string;
}

export interface Profile {
  homeCity?: string;
  vehicle?: string;
  travellers?: Traveller[];
  pace?: string;
  food?: string;
  alwaysCarry?: string;
  budgetPerDay?: string;
}

export interface TripRequest {
  fromLocation?: string;
  destination?: string;
  startDate?: string;
  duration?: number | string;
  adults?: number | string;
  children?: number | string;
  travelType?: string;
  mode?: string;
  maxDrive?: string;
  budget?: string;
  food?: string;
  idealTripDescription?: string;
  leaveAt?: string;
  profile?: Profile;
}

const clip = (v: unknown, max = 600) => String(v ?? '').slice(0, max).trim();

export const endDate = (start: string, nights: number) => {
  const d = new Date(start + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + nights);
  return d.toISOString().slice(0, 10);
};

/** Describes the trip and the family for the model. Every field is user input, so it is length-limited. */
export function tripContext(req: TripRequest): string {
  const p = req.profile || {};
  const nights = Math.max(1, Math.min(30, Number(req.duration) || 1));
  const start = clip(req.startDate, 10);
  const travellers = (Array.isArray(p.travellers) ? p.travellers : []).slice(0, 12).map((t) => ({
    name: clip(t?.name, 40), age: clip(t?.age, 10), food: clip(t?.food, 80), notes: clip(t?.notes, 160),
  }));
  return [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    `Starting from: ${clip(req.fromLocation, 80) || clip(p.homeCity, 80) || 'not given'}`,
    `Destination: ${clip(req.destination, 120)}`,
    `Dates: ${start} to ${endDate(start, nights)} (${nights} nights, ${nights + 1} days)`,
    `Travellers on THIS trip: ${Number(req.adults) || 1} adults, ${Number(req.children) || 0} children (this overrides the usual group for counts and quantities)`,
    `Usual travellers (use for food, health and age preferences): ${JSON.stringify(travellers)}`,
    `Trip vibe: ${clip(req.travelType, 30) || 'Family'}; preferred pace: ${clip(p.pace, 30) || 'Balanced'}`,
    `Budget: ${clip(req.budget, 30) || clip(p.budgetPerDay, 40) || 'Mid-range'}`,
    `Food: ${clip(req.food, 120) || clip(p.food, 120) || 'not specified'}`,
    `How they're travelling: ${clip(req.mode, 60) || 'Road trip in our own car'}`,
    `Most driving they want in a day: ${clip(req.maxDrive, 20) || '5 hours'}`,
    `Leaving home on day 1 at: ${clip(req.leaveAt, 10) ? `${clip(req.leaveAt, 10)} (fixed: plan day 1 from this time and set roadTrip.departAt to it)` : 'not fixed (suggest the best time in roadTrip.departAt)'}`,
    `Vehicle: ${clip(p.vehicle, 80) || 'car (type not given)'}`,
    `Always carry: ${clip(p.alwaysCarry, 200) || 'nothing specific'}`,
    `What they want from the trip: ${clip(req.idealTripDescription, 800) || 'a memorable, well-paced trip'}`,
  ].join('\n');
}

// --- Changing part of an existing plan ---

const REVISE_RULES = `Apply only the requested change. Keep everything the change does not touch exactly as it is:
the same places, times, wording and order. Follow every planning rule above, including real named places,
hidden gems that are genuinely lesser-known, food that fits their preferences, and the daily driving limit.
If the change alters where they start, where they are going, the dates, how many are travelling or how they travel,
it touches the whole trip: rebuild every route, drive, stop, overnight town, stay, budget line and booking date from
the new details, as if planning afresh. Do not keep stops or overnight towns that only made sense for the old details,
and never route them away from the destination and back.`;

export const REVISE_DAY_SCHEMA = `Return JSON with exactly these keys:
{
 "needsWholeTrip": false, set it to true (and leave the other keys empty) if this change really alters where they start, where they are going, the dates or who is travelling, because then the whole trip must be replanned,
 "changeNote": "one short sentence telling the family what you changed",
 "day": { the revised day, in exactly the same shape as the days in the current plan },
 "leg": { the revised road-trip leg for this day, in the same shape as the current legs } or null if this day's drive is unchanged or there is no drive,
 "budget": [ the full revised budget list, same shape ] or null if the costs did not change
}`;

export const REVISE_TRIP_SCHEMA = `${PLAN_SCHEMA}
Also add two more keys:
"changeNote": "one short sentence telling the family what you changed",
"tripDetails": null, or, only if the requested change itself alters them, the new values:
  {"fromLocation": "town they now start from", "startDate": "YYYY-MM-DD", "nights": 2, "adults": 2, "children": 0}
  (include only the fields that changed).`;

export type ReviseScope = 'all' | number;

/** The model's input for a change: the trip, the current plan and the requested change. */
const DETAIL_LABELS: [keyof TripRequest, string][] = [
  ['fromLocation', 'Starting from'], ['destination', 'Destination'], ['startDate', 'Start date'], ['duration', 'Nights'],
  ['adults', 'Adults'], ['children', 'Children'], ['mode', "How they're travelling"], ['maxDrive', 'Most driving in a day'],
  ['budget', 'Budget'], ['food', 'Food'], ['leaveAt', 'Leaving home at'],
];

/** "Starting from: Chennai → Madurai" lines for every trip detail that changed. */
export function detailChanges(before: TripRequest | undefined, after: TripRequest): string[] {
  if (!before) return [];
  return DETAIL_LABELS
    .filter(([k]) => clip(before[k], 120) !== clip(after[k], 120))
    .map(([k, label]) => `${label}: ${clip(before[k], 120) || '(none)'} → ${clip(after[k], 120) || '(none)'}`);
}

export function reviseInput(req: TripRequest, plan: unknown, scope: ReviseScope, change: string, before?: TripRequest): string {
  const current = { ...(plan as Record<string, unknown>) };
  delete current.sources;
  const where = scope === 'all' ? 'the whole trip' : `day ${scope} only`;
  const changed = detailChanges(before, req);
  return [
    tripContext(req),
    '',
    changed.length
      ? `THE TRIP DETAILS HAVE CHANGED. The plan below was made for the old details; the details above are the new ones:\n${changed.join('\n')}\nRebuild everything that depends on them.`
      : '',
    'CURRENT PLAN (JSON):',
    JSON.stringify(current),
    '',
    `REQUESTED CHANGE, for ${where}: ${clip(change, 600) || 'Replan the trip for the new details.'}`,
    '',
    REVISE_RULES,
    scope === 'all' ? '' : `Change day ${scope} and, only if needed, its road-trip leg and the budget. Do not return other days.`,
    '',
    scope === 'all' ? REVISE_TRIP_SCHEMA : REVISE_DAY_SCHEMA,
  ].join('\n');
}


// --- Current road notices for a planned trip ---

export const NOTICES_SCHEMA = `Return JSON with exactly these keys:
{
 "summary": "one sentence: is the planned driving likely to go ahead as planned?",
 "notices": [{
   "title": "short name of the restriction, e.g. 'Night traffic ban, Idukki hill roads'",
   "area": "road or district it covers",
   "when": "dates it applies, or 'ongoing'",
   "timeWindow": "hours it applies, e.g. '7 pm to 6 am', or ''",
   "severity": "blocker if it would stop or close part of the planned drive at the planned time; caution if it might (weather alerts, permits to check); info otherwise",
   "whatToDo": "the practical step for this family",
   "sourceTitle": "", "sourceUrl": ""
 }]
}`;

export const NOTICES_RULES = `Search for road restrictions that affect the drives listed below on these dates: forest night traffic bans,
ghat or road closures, landslide or flood closures, district collector orders, e-pass or permit requirements, tourist-vehicle bans,
checkpost timings, and weather alerts (IMD orange or red) for the districts on the route.
Include only items backed by an official source (government, police, forest department, district administration, IMD) or a dated
news report from the last 60 days, plus standing rules that are still in force. Never invent a restriction. If you find nothing
that applies, return an empty "notices" list and say so in "summary". Every notice needs a sourceUrl.`;

/** What the model needs to look up notices: where they drive, on which days, and at what times. */
export function noticesInput(req: TripRequest, plan: any): string {
  const legs = Array.isArray(plan?.roadTrip?.legs) ? plan.roadTrip.legs : [];
  const nights = Math.max(1, Math.min(30, Number(req.duration) || 1));
  const start = clip(req.startDate, 10);
  const drives = legs.slice(0, 12).map((l: any, i: number) => {
    const day = Number(l?.day) || i + 1;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(start) ? endDate(start, day - 1) : '';
    const stops = (Array.isArray(l?.stops) ? l.stops : []).slice(0, 8).map((s: any) => clip(s?.name, 60)).filter(Boolean).join(', ');
    return `Day ${day}${date ? ` (${date})` : ''}: ${clip(l?.from, 60)} → ${clip(l?.to, 60)} via ${clip(l?.route, 120) || 'the planned route'}${stops ? `; stops: ${stops}` : ''}; about ${clip(l?.driveTime, 30)}`;
  });
  return [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    `Trip: ${clip(req.fromLocation, 80)} → ${clip(req.destination, 120)}, ${start} to ${endDate(start, nights)}, ${clip(req.mode, 60) || 'road trip in their own car'}.`,
    `Departure on day 1: ${clip(plan?.roadTrip?.departAt, 160) || 'not stated'}.`,
    'Drives:',
    ...(drives.length ? drives : ['(no drives listed; check the destination and the roads into it)']),
    '',
    'These known rules are already shown to the family; report them only if their current status or timings differ:',
    ROAD_RULES_FOR_PROMPT,
    '',
    NOTICES_RULES,
    '',
    NOTICES_SCHEMA,
  ].join('\n');
}
