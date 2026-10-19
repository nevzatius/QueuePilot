import { z } from 'zod';
import { ActiveStateSchema, RoleSchema, TenantIdSchema, UidSchema } from './common.js';

/** The caller's tenant membership as resolved from `memberships/{uid}` and `tenants/{tenantId}`. */
export const MembershipSchema = z.object({
  tenantId: TenantIdSchema,
  tenantName: z.string().min(1).max(128),
  tenantStatus: ActiveStateSchema,
  role: RoleSchema,
  status: ActiveStateSchema,
});
export type Membership = z.infer<typeof MembershipSchema>;

/**
 * `GET /api/v1/me`. Reachable without a membership: `membership === null` means the client must
 * call the bootstrap endpoint (every other endpoint answers `403 ONBOARDING_REQUIRED`).
 */
export const MeResponseSchema = z.object({
  uid: UidSchema,
  email: z.string().max(320).nullable(),
  membership: MembershipSchema.nullable(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/**
 * `POST /api/v1/session/bootstrap` takes no input. The body must be absent or `{}`: the role is a
 * server constant and `{"role":"admin"}` is rejected, never ignored (ADR-008).
 */
export const BootstrapRequestSchema = z.strictObject({}).optional();

/** Idempotent: `created` is false when the membership already existed. The role is always `member`. */
export const BootstrapResponseSchema = z.object({
  created: z.boolean(),
  membership: MembershipSchema,
});
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;
