import type { Priority, RequestAttributes, RequestType, TriageResult } from '@queuepilot/contracts';

export type Lane = TriageResult['lane'];
export type LocationType = NonNullable<RequestAttributes['locationType']>;
export type PreferredWindow = NonNullable<RequestAttributes['preferredWindow']>;

/** Triage reads only these fields (ARCHITECTURE §17). Extra attributes never influence the result. */
export interface TriageInput {
  readonly type: RequestType;
  readonly priority: Priority;
  readonly attributes: Pick<RequestAttributes, 'safetyRisk' | 'locationType' | 'preferredWindow'>;
}

/**
 * Declarative rule condition. Every listed field must match; an empty condition always matches.
 * `safetyRisk: true` matches only an explicit `true`. A missing `preferredWindow` is treated as `anytime`.
 * A missing `locationType` matches no `locationType` list.
 */
export interface RuleCondition {
  readonly priority?: readonly Priority[];
  readonly safetyRisk?: boolean;
  readonly locationType?: readonly LocationType[];
  readonly preferredWindow?: readonly PreferredWindow[];
}

export interface TriageRule {
  readonly when: RuleCondition;
  readonly lane: Lane;
  readonly slaTargetMinutes: number;
  readonly team: string;
}

/**
 * One immutable rules version. Changing any value requires a new version: requests keep the version
 * they were accepted with, so reprocessing reproduces the original result (I6).
 */
export interface RuleSet {
  readonly version: string;
  /** Ordered per type; first match wins. The last rule of every type has an empty condition. */
  readonly rules: Readonly<Record<RequestType, readonly TriageRule[]>>;
  /** Additive score weights; the sum is clamped to 0..100. */
  readonly score: {
    readonly priority: Readonly<Record<Priority, number>>;
    readonly safetyRisk: number;
    readonly locationType: Readonly<Record<LocationType, number>>;
    readonly type: Readonly<Record<RequestType, number>>;
  };
}
