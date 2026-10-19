import type { TriageResult } from '@queuepilot/contracts';
import { stableHash32 } from '../fingerprint.js';
import { RULES_V1 } from './rules-v1.js';
import type { RuleCondition, RuleSet, TriageInput, TriageRule } from './types.js';

export type { Lane, LocationType, PreferredWindow, RuleCondition, RuleSet, TriageInput, TriageRule } from './types.js';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Every published rules version. Versions are never edited or removed while requests may reference them. */
export const RULE_SETS: Readonly<Record<string, RuleSet>> = deepFreeze({ [RULES_V1.version]: RULES_V1 });

/** Version pinned on newly accepted requests. */
export const CURRENT_RULES_VERSION: string = RULES_V1.version;

export function isKnownRulesVersion(version: string): boolean {
  return Object.hasOwn(RULE_SETS, version);
}

export type TriageOutcome =
  | { readonly ok: true; readonly result: TriageResult }
  /** The worker treats this as a permanent error (S7): retrying cannot help. */
  | { readonly ok: false; readonly code: 'UNKNOWN_RULES_VERSION' };

/** Deterministic triage: a pure function of `(input, rulesVersion)` (I6). */
export function triage(input: TriageInput, rulesVersion: string): TriageOutcome {
  if (!isKnownRulesVersion(rulesVersion)) return { ok: false, code: 'UNKNOWN_RULES_VERSION' };
  const ruleSet = RULE_SETS[rulesVersion] as RuleSet;
  const rule: TriageRule | undefined = ruleSet.rules[input.type].find((r) => matches(r.when, input));
  // Unreachable for published rule sets: the last rule of every type is a catch-all (tested).
  if (rule === undefined) throw new Error(`rules ${rulesVersion} have no catch-all for ${input.type}`);
  return {
    ok: true,
    result: {
      rulesVersion: ruleSet.version,
      lane: rule.lane,
      slaTargetMinutes: rule.slaTargetMinutes,
      team: rule.team,
      score: score(ruleSet, input),
    },
  };
}

function matches(when: RuleCondition, input: TriageInput): boolean {
  const { safetyRisk, locationType, preferredWindow } = input.attributes;
  if (when.priority !== undefined && !when.priority.includes(input.priority)) return false;
  if (when.safetyRisk !== undefined && when.safetyRisk !== (safetyRisk === true)) return false;
  if (when.locationType !== undefined && (locationType === undefined || !when.locationType.includes(locationType))) {
    return false;
  }
  if (when.preferredWindow !== undefined && !when.preferredWindow.includes(preferredWindow ?? 'anytime')) return false;
  return true;
}

function score(ruleSet: RuleSet, input: TriageInput): number {
  const { safetyRisk, locationType } = input.attributes;
  const w = ruleSet.score;
  const raw =
    w.priority[input.priority] +
    (safetyRisk === true ? w.safetyRisk : 0) +
    (locationType === undefined ? 0 : w.locationType[locationType]) +
    w.type[input.type];
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/** Bounds of the simulated "team capacity lookup" latency (ARCHITECTURE §17). */
export const CAPACITY_LOOKUP_MIN_MS = 200;
export const CAPACITY_LOOKUP_MAX_MS = 800;

/**
 * Simulated latency of the slow capacity lookup, seeded by `requestId`. The worker sleeps this long;
 * the value is reproducible, so reprocessing behaves the same way.
 */
export function capacityLookupDelayMs(requestId: string): number {
  const span = CAPACITY_LOOKUP_MAX_MS - CAPACITY_LOOKUP_MIN_MS + 1;
  return CAPACITY_LOOKUP_MIN_MS + (stableHash32(`capacity:${requestId}`) % span);
}
