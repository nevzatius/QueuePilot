import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/**
 * Where the first proxy may connect from. Only a private, loopback or link-local peer can be a platform proxy;
 * a public peer is a client talking to the origin directly and must not be able to supply its own chain.
 * Render's origin sees its proxy on loopback (ADR-019 spike, n=1).
 */
const PLATFORM_PEERS = new BlockList();
for (const [network, prefix] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16]] as const) {
  PLATFORM_PEERS.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) PLATFORM_PEERS.addSubnet(network, prefix, 'ipv6');
const isPlatformPeer = (address: string) => {
  const family = isIP(address);
  return family !== 0 && PLATFORM_PEERS.check(address, family === 4 ? 'ipv4' : 'ipv6');
};

/**
 * Fastify `trustProxy` for a fixed proxy chain of `hops` hops, the socket peer counting as hop 0: the client is
 * the address `hops` places to the left of the socket in `[socket, ...X-Forwarded-For from the right]`.
 *
 * It is a function, not the number: Fastify 5.12 deliberately maps a numeric `trustProxy` to "trust nobody"
 * (`request.ip` stays the socket address, so behind Render every client is 127.0.0.1). It is never `true`,
 * which trusts the whole header and so the leftmost, attacker-chosen entry. The peer must also be a private
 * or loopback address, because a hop count alone cannot tell a proxy from a direct client. Hops 0 trusts nothing.
 *
 * Limit: the result is correct only while the platform appends exactly `hops` entries. A request that reaches the
 * origin through a shorter chain (for example a bypass of the CDN) and carries enough forged entries to satisfy
 * `dropShortForwardedChain` yields an address the client chose. Callers must not treat the IP as a guarantee.
 */
export function trustProxyHops(hops: number): false | ((address: string, hop: number) => boolean) {
  if (hops === 0) return false;
  return (address, hop) => hop < hops && (hop > 0 || isPlatformPeer(address));
}

/**
 * Drops `X-Forwarded-For` when it holds fewer entries than the configured hops. A chain shorter than the platform
 * always appends means the request did not pass through all of it, and proxy-addr would then return the
 * leftmost entry, which the client chose. With the header gone `request.ip` is the socket address.
 * A chain padded to `hops` entries is not detected (see `trustProxyHops`).
 *
 * It also deletes `X-Forwarded-Host` and `X-Forwarded-Proto`, whatever the hops: Fastify would trust them from a
 * trusted peer, and nothing here may depend on them. The API must never read `request.host`, `hostname` or
 * `protocol`; use configuration (`QP_WORKER_URL`, `QP_CORS_ORIGINS`) instead.
 * Run it before anything reads `request.ip`.
 */
export function dropShortForwardedChain(hops: number) {
  return async (request: FastifyRequest) => {
    delete request.raw.headers['x-forwarded-host'];
    delete request.raw.headers['x-forwarded-proto'];
    if (hops === 0) return;
    const header = request.raw.headers['x-forwarded-for'];
    const entries = typeof header === 'string' ? header.split(',').filter((entry) => entry.trim() !== '').length : 0;
    if (entries < hops) delete request.raw.headers['x-forwarded-for'];
  };
}

/**
 * Canonical form of an address for use in a rate-limit key: `::ffff:a.b.c.d` becomes the IPv4 form, and an IPv6
 * address collapses to its /64 prefix (one subscriber normally holds a whole /64, so per-address buckets would be
 * free to rotate). IPv4 and unparseable input are returned unchanged.
 */
export function normalizeIp(address: string): string {
  const bare = address.split('%')[0] ?? address;
  if (isIP(bare) !== 6) return address;
  const groups = expandIpv6(bare);
  if (!groups) return address;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

/** Eight 16-bit groups of a valid IPv6 address (the URL parser canonicalises embedded IPv4 and `::`). */
function expandIpv6(address: string): number[] | undefined {
  if (!URL.canParse(`http://[${address}]/`)) return undefined;
  const host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head = '', tail] = host.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : undefined;
}

/**
 * The bucket key address of a request: `request.ip` when it is a valid IP, else the socket address (a trailing
 * port, markup or an empty client slot must not become a key), normalised by `normalizeIp`.
 */
export function rateLimitAddress(request: FastifyRequest): string {
  const selected = request.ip;
  return normalizeIp(isIP(selected) !== 0 ? selected : request.socket.remoteAddress ?? 'unknown');
}
