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
 */
export function trustProxyHops(hops: number): false | ((address: string, hop: number) => boolean) {
  if (hops === 0) return false;
  return (address, hop) => hop < hops && (hop > 0 || isPlatformPeer(address));
}

/**
 * Drops `X-Forwarded-For` when it holds fewer entries than the configured hops. A chain shorter than the platform
 * always appends means the request did not pass through all of it, and proxy-addr would then return the
 * leftmost entry, which the client chose. With the header gone `request.ip` is the socket address.
 * Run it before anything reads `request.ip`.
 */
export function dropShortForwardedChain(hops: number) {
  return async (request: FastifyRequest) => {
    if (hops === 0) return;
    const header = request.raw.headers['x-forwarded-for'];
    const entries = typeof header === 'string' ? header.split(',').filter((entry) => entry.trim() !== '').length : 0;
    if (entries < hops) delete request.raw.headers['x-forwarded-for'];
  };
}
