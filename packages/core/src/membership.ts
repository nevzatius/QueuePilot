import { z } from 'zod';
import { MembershipSchema, TenantIdSchema, RoleSchema, ActiveStateSchema } from '@queuepilot/contracts';
import type { Membership } from '@queuepilot/contracts';
import type { Clock } from '@queuepilot/domain';
import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import { ApiError, storageCall } from './errors.js';

const MemberDocument = z.object({ tenantId: TenantIdSchema, role: RoleSchema, status: ActiveStateSchema, schemaVersion: z.literal(1) });
export const TenantDocument = z.object({
  name: z.string().min(1).max(128), status: ActiveStateSchema, openSignup: z.boolean(),
  quotaMode: z.enum(['enforced', 'none']), schemaVersion: z.literal(1),
  limits: z.object({ submitPerMin: z.number().int().positive(), submitPerDayUser: z.number().int().positive(), submitPerDayTenant: z.number().int().positive() }),
});
export type Tenant = z.infer<typeof TenantDocument>;

export interface MembershipStore {
  member(uid: string): Promise<z.infer<typeof MemberDocument> | null>;
  tenant(id: string): Promise<Tenant | null>;
  bootstrap(uid: string, now: number): Promise<boolean>;
}

export class FirestoreMembershipStore implements MembershipStore {
  constructor(private readonly db: Firestore) {}
  member(uid: string) {
    return storageCall(async () => {
      const snapshot = await this.db.doc(`memberships/${uid}`).get();
      return snapshot.exists ? MemberDocument.parse(snapshot.data()) : null;
    });
  }
  tenant(id: string) {
    return storageCall(async () => {
      const snapshot = await this.db.doc(`tenants/${id}`).get();
      return snapshot.exists ? TenantDocument.parse(snapshot.data()) : null;
    });
  }
  bootstrap(uid: string, now: number) {
    return storageCall(() => this.db.runTransaction(async (tx) => {
      const reference = this.db.doc(`memberships/${uid}`);
      const member = await tx.get(reference);
      if (member.exists) { MemberDocument.parse(member.data()); return false; }
      const sandbox = await tx.get(this.db.doc('tenants/sandbox'));
      if (!sandbox.exists) throw new ApiError('SIGNUP_CLOSED');
      const tenant = TenantDocument.parse(sandbox.data());
      if (tenant.status !== 'active') throw new ApiError('TENANT_SUSPENDED');
      if (!tenant.openSignup) throw new ApiError('SIGNUP_CLOSED');
      tx.create(reference, { tenantId: 'sandbox', role: 'member', status: 'active', createdBy: 'bootstrap', updatedAt: Timestamp.fromMillis(now), schemaVersion: 1 });
      return true;
    }));
  }
}

/** Bounded positive-only caches. Expiry starts before IO, so slow reads cannot extend revocation. */
export class MembershipService {
  private readonly members = new Map<string, { value: NonNullable<Awaited<ReturnType<MembershipStore['member']>>>; until: number }>();
  private readonly tenants = new Map<string, { value: Tenant; until: number }>();
  constructor(private readonly store: MembershipStore, private readonly clock: Clock, private readonly ttlMs = 30_000) {
    if (ttlMs < 0 || ttlMs > 30_000) throw new Error('Membership TTL must be at most 30s');
  }

  async lookup(uid: string, uncached = false): Promise<{ membership: Membership; tenant: Tenant } | null> {
    return storageCall(async () => {
      const member = await this.read(this.members, uid, () => this.store.member(uid), uncached);
      if (member === null) return null;
      const tenant = await this.read(this.tenants, member.tenantId, () => this.store.tenant(member.tenantId), uncached);
      if (tenant === null) throw new ApiError('SERVICE_UNAVAILABLE', 1);
      const membership = MembershipSchema.parse({ ...member, tenantName: tenant.name, tenantStatus: tenant.status });
      return { membership, tenant };
    });
  }

  async require(uid: string, uncached = false) {
    const resolved = await this.lookup(uid, uncached);
    if (resolved === null) throw new ApiError('ONBOARDING_REQUIRED');
    if (resolved.membership.status !== 'active') throw new ApiError('MEMBERSHIP_SUSPENDED');
    if (resolved.tenant.status !== 'active') throw new ApiError('TENANT_SUSPENDED');
    return resolved;
  }

  async bootstrap(uid: string) {
    const created = await this.store.bootstrap(uid, this.clock.now());
    this.members.delete(uid);
    const { membership } = await this.require(uid, true);
    return { created, membership };
  }

  private async read<T>(cache: Map<string, { value: T; until: number }>, key: string, fetch: () => Promise<T | null>, uncached: boolean): Promise<T | null> {
    const now = this.clock.now();
    const entry = cache.get(key);
    if (!uncached && entry && now < entry.until) return entry.value;
    cache.delete(key);
    const value = await fetch();
    if (value !== null && this.clock.now() < now + this.ttlMs) {
      if (cache.size >= 10_000) cache.delete(cache.keys().next().value!);
      cache.set(key, { value, until: now + this.ttlMs });
    }
    return value;
  }
}
