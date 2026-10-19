import { z } from 'zod';

/** Request IDs are random UUIDv4 values (ARCHITECTURE §13: time-ordered IDs are forbidden). */
export const RequestIdSchema = z.uuid({ version: 'v4' });

/** Tenant slug, e.g. `sandbox` or `loadtest`. */
export const TenantIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'must be a lowercase slug of 2-63 chars');

/** Firebase Auth uid. */
export const UidSchema = z.string().min(1).max(128);

/** Safe, opaque trace identifier. The server generates it; it is echoed in errors and task payloads. */
export const CorrelationIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, 'invalid correlation id');

/** UTC instant serialised as an ISO 8601 string ending in `Z`. */
export const IsoTimestampSchema = z.iso.datetime();

export const RoleSchema = z.enum(['member', 'admin']);
export type Role = z.infer<typeof RoleSchema>;

export const ActiveStateSchema = z.enum(['active', 'suspended']);
export type ActiveState = z.infer<typeof ActiveStateSchema>;
