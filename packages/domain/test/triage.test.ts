import { PrioritySchema, REQUEST_TYPES, TriageResultSchema, type Priority, type RequestType } from '@queuepilot/contracts';
import { describe, expect, it } from 'vitest';
import {
  CAPACITY_LOOKUP_MAX_MS,
  CAPACITY_LOOKUP_MIN_MS,
  CURRENT_RULES_VERSION,
  RULE_SETS,
  canonicalJson,
  capacityLookupDelayMs,
  isKnownRulesVersion,
  sha256Hex,
  triage,
  type LocationType,
  type PreferredWindow,
  type TriageInput,
} from '../src/index.js';

const V1 = 'triage-v1';

function input(type: RequestType, priority: Priority, attributes: TriageInput['attributes'] = {}): TriageInput {
  return { type, priority, attributes };
}

function run(i: TriageInput, version = V1) {
  const out = triage(i, version);
  if (!out.ok) throw new Error(out.code);
  return out.result;
}

describe('triage v1 across industries', () => {
  const rows: Array<[string, TriageInput, string, number, string, number]> = [
    // Roadside assistance
    ['roadside: safety risk on a highway', input('roadside_assistance', 'urgent', { safetyRisk: true, locationType: 'highway' }), 'emergency', 30, 'roadside-highway', 100],
    ['roadside: safety risk off-highway', input('roadside_assistance', 'normal', { safetyRisk: true, locationType: 'rural' }), 'emergency', 45, 'roadside-rapid', 65],
    ['roadside: highway, high priority', input('roadside_assistance', 'high', { locationType: 'highway' }), 'standard', 60, 'roadside-highway', 70],
    ['roadside: rural', input('roadside_assistance', 'low', { locationType: 'rural' }), 'standard', 120, 'roadside-rural', 20],
    ['roadside: urban, high priority', input('roadside_assistance', 'high', { locationType: 'urban' }), 'standard', 60, 'roadside-urban', 60],
    ['roadside: default', input('roadside_assistance', 'normal'), 'standard', 90, 'roadside-urban', 35],
    ['roadside: safetyRisk false is not a risk', input('roadside_assistance', 'normal', { safetyRisk: false, locationType: 'highway' }), 'standard', 60, 'roadside-highway', 45],
    // Technical service
    ['technical: safety risk', input('technical_service', 'normal', { safetyRisk: true }), 'emergency', 120, 'field-service-priority', 55],
    ['technical: urgent beats a window', input('technical_service', 'urgent', { preferredWindow: 'morning' }), 'standard', 240, 'field-service', 75],
    ['technical: booked window', input('technical_service', 'normal', { preferredWindow: 'afternoon' }), 'scheduled', 2880, 'field-service-scheduled', 30],
    ['technical: high, anytime', input('technical_service', 'high', { preferredWindow: 'anytime' }), 'standard', 480, 'field-service', 55],
    ['technical: default', input('technical_service', 'low'), 'standard', 1440, 'field-service', 10],
    // Appointments
    ['appointment: urgent', input('appointment', 'urgent', { preferredWindow: 'evening' }), 'standard', 120, 'scheduling-priority', 65],
    ['appointment: morning', input('appointment', 'normal', { preferredWindow: 'morning' }), 'scheduled', 1440, 'scheduling-am', 20],
    ['appointment: afternoon', input('appointment', 'normal', { preferredWindow: 'afternoon' }), 'scheduled', 1440, 'scheduling-pm', 20],
    ['appointment: evening', input('appointment', 'high', { preferredWindow: 'evening' }), 'scheduled', 1440, 'scheduling-evening', 45],
    ['appointment: no window means anytime', input('appointment', 'low'), 'scheduled', 2880, 'scheduling-flex', 0],
    // Support tickets
    ['support: safety risk', input('support_ticket', 'low', { safetyRisk: true }), 'emergency', 60, 'support-l2', 35],
    ['support: urgent', input('support_ticket', 'urgent'), 'standard', 60, 'support-l2', 75],
    ['support: high', input('support_ticket', 'high'), 'standard', 240, 'support-l1', 55],
    ['support: normal', input('support_ticket', 'normal'), 'standard', 480, 'support-l1', 30],
    ['support: low', input('support_ticket', 'low'), 'scheduled', 2880, 'support-l1', 10],
    // Bookings
    ['booking: urgent', input('booking', 'urgent'), 'standard', 120, 'reservations-priority', 65],
    ['booking: normal', input('booking', 'normal', { preferredWindow: 'evening' }), 'scheduled', 1440, 'reservations', 20],
    ['booking: low clamps the score at 0', input('booking', 'low'), 'scheduled', 1440, 'reservations', 0],
    // General
    ['general: safety risk', input('general', 'normal', { safetyRisk: true }), 'emergency', 60, 'triage-desk', 55],
    ['general: high', input('general', 'high'), 'standard', 240, 'triage-desk', 55],
    ['general: default', input('general', 'low'), 'standard', 1440, 'triage-desk', 10],
  ];

  it.each(rows)('%s', (_name, i, lane, sla, team, score) => {
    expect(run(i)).toEqual({ rulesVersion: V1, lane, slaTargetMinutes: sla, team, score });
  });

  it('covers every request type', () => {
    expect(new Set(rows.map(([, i]) => i.type))).toEqual(new Set(REQUEST_TYPES));
  });
});

/** Every combination of the inputs that triage reads (6 × 4 × 2 × 4 × 5 = 960). */
function matrix(): TriageInput[] {
  const locations: Array<LocationType | undefined> = [undefined, 'highway', 'urban', 'rural'];
  const windows: Array<PreferredWindow | undefined> = [undefined, 'morning', 'afternoon', 'evening', 'anytime'];
  const out: TriageInput[] = [];
  for (const type of REQUEST_TYPES) {
    for (const priority of PrioritySchema.options) {
      for (const safetyRisk of [false, true]) {
        for (const locationType of locations) {
          for (const preferredWindow of windows) {
            out.push(input(type, priority, {
              safetyRisk,
              ...(locationType !== undefined && { locationType }),
              ...(preferredWindow !== undefined && { preferredWindow }),
            }));
          }
        }
      }
    }
  }
  return out;
}

describe('triage: versioning and determinism (I6)', () => {
  it('every output in the input space satisfies the TriageResult contract', () => {
    for (const i of matrix()) expect(TriageResultSchema.safeParse(run(i)).success, JSON.stringify(i)).toBe(true);
  });

  it('is a pure function: same input, same output, regardless of extra attributes', () => {
    for (const i of matrix().slice(0, 120)) {
      const withExtras = { ...i, attributes: { ...i.attributes, plate: 'AB123', vip: true } } as TriageInput;
      expect(run(i)).toEqual(run(i));
      expect(run(withExtras)).toEqual(run(i));
    }
  });

  it('v1 output over the whole input space is pinned (edit rules only under a new version)', () => {
    const digest = sha256Hex(canonicalJson(matrix().map((i) => run(i))));
    expect(digest).toBe('d0895befc955615a012657cf884588f61caa23373fed96cefb5bfda5f0db0d3e');
  });

  it('pins the current version for new requests and rejects unknown versions', () => {
    expect(CURRENT_RULES_VERSION).toBe(V1);
    expect(isKnownRulesVersion(V1)).toBe(true);
    expect(isKnownRulesVersion('triage-v0')).toBe(false);
    expect(isKnownRulesVersion('toString')).toBe(false);
    expect(triage(input('general', 'normal'), 'triage-v999')).toEqual({ ok: false, code: 'UNKNOWN_RULES_VERSION' });
  });

  it('rule sets are frozen, versioned and end every type with a catch-all', () => {
    for (const [version, ruleSet] of Object.entries(RULE_SETS)) {
      expect(ruleSet.version).toBe(version);
      expect(Object.isFrozen(ruleSet) && Object.isFrozen(ruleSet.rules) && Object.isFrozen(ruleSet.score)).toBe(true);
      for (const type of REQUEST_TYPES) {
        const rules = ruleSet.rules[type];
        expect(rules.length, type).toBeGreaterThan(0);
        expect(rules.at(-1)?.when, type).toEqual({});
        expect(rules.every((r) => Object.isFrozen(r) && Object.isFrozen(r.when)), type).toBe(true);
      }
    }
    expect(() => {
      (RULE_SETS[V1]?.rules.general[0] as { slaTargetMinutes: number }).slaTargetMinutes = 1;
    }).toThrow(TypeError);
  });
});

describe('capacity lookup simulation (ARCHITECTURE §17)', () => {
  it('is seeded by requestId, stays within 200-800 ms and varies across requests', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const delays = ids.map(capacityLookupDelayMs);
    expect(ids.map(capacityLookupDelayMs)).toEqual(delays);
    for (const d of delays) {
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(CAPACITY_LOOKUP_MIN_MS);
      expect(d).toBeLessThanOrEqual(CAPACITY_LOOKUP_MAX_MS);
    }
    expect(new Set(delays).size).toBeGreaterThan(100);
  });
});
