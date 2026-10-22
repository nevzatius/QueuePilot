import { describe, expect, it } from 'vitest';
import type { RateLimiter } from '@queuepilot/core';
import { normalizeIp } from '../src/proxy.js';
import { edgeApp } from './edge-fixture.js';

// Documentation-range addresses only (RFC 5737). The first hop is a loopback peer, like Render's origin sees it.
const SPOOF = '192.0.2.66';
const SPOOF_2 = '192.0.2.67';
const CLIENT = '198.51.100.7';
const CLOUDFLARE = '203.0.113.20';
const RENDER = '203.0.113.30';
const CHAIN = `${CLIENT}, ${CLOUDFLARE}, ${RENDER}`;
const PEER = '127.0.0.1';

/** The IP the bootstrap limiter is keyed on is request.ip (the only IP consumer in the API). */
async function clientIp(env: Record<string, string>, remoteAddress: string, forwardedFor?: string) {
  const keys: string[] = [];
  const limiter: RateLimiter = { consume: async (key) => { keys.push(key); } };
  const { app } = edgeApp(env, limiter);
  const response = await app.inject({ method: 'POST', url: '/api/v1/session/bootstrap', remoteAddress, payload: {},
    headers: { authorization: 'Bearer valid', ...(forwardedFor !== undefined && { 'x-forwarded-for': forwardedFor }) } });
  await app.close();
  expect(response.statusCode).toBe(200);
  const ip = keys.find((key) => key.startsWith('ip:'));
  expect(ip).toBeDefined();
  return ip!.slice('ip:'.length);
}
const render = { TRUST_PROXY_HOPS: '3' };

describe('client IP behind a three-hop proxy chain (Render, ADR-019)', () => {
  it('takes the 4th address from the right, counting the socket as hop 0', async () => {
    expect(await clientIp(render, PEER, `${SPOOF}, ${CHAIN}`)).toBe(CLIENT);
  });
  it('is not changed by forged entries added on the left of a complete chain', async () => {
    expect(await clientIp(render, PEER, `${SPOOF}, ${CHAIN}`)).toBe(CLIENT);
    expect(await clientIp(render, PEER, `${SPOOF_2}, ${SPOOF}, ${SPOOF_2}, ${SPOOF}, ${CHAIN}`)).toBe(CLIENT);
    expect(await clientIp(render, PEER, `not-an-ip, ${SPOOF}, ${CHAIN}`)).toBe(CLIENT);
    expect(await clientIp(render, PEER, CHAIN)).toBe(CLIENT);
  });
  it('uses the socket address when there is no X-Forwarded-For', async () => {
    expect(await clientIp(render, PEER)).toBe(PEER);
  });
  it('LIMIT, not a guarantee: a chain padded to the hop count by the attacker yields an attacker-chosen address', async () => {
    // Two forged entries plus the one entry a bypassed platform still appends make three entries, so the guard passes
    // and the first (forged) entry is taken. The result is safe only while the platform appends exactly TRUST_PROXY_HOPS entries.
    expect(await clientIp(render, PEER, `${SPOOF}, ${SPOOF_2}, ${RENDER}`)).toBe(SPOOF);
  });
  it('uses the socket address, not a too-short chain: the header is ignored when it holds fewer entries than the hops', async () => {
    expect(await clientIp(render, PEER, SPOOF)).toBe(PEER);
    expect(await clientIp(render, PEER, `${SPOOF}, ${CLOUDFLARE}`)).toBe(PEER);
    expect(await clientIp(render, PEER, ' , ,')).toBe(PEER);
  });
  it.each(['2001:db8::1', '::ffff:8.8.8.8', '172.32.0.1', '172.15.255.255', '100.64.0.1', '192.169.0.1', '11.0.0.1', '9.255.255.255', '2000::1'])(
    'does not trust a public or shared-space peer (%s)', async (peer) => {
      const ip = await clientIp(render, peer, CHAIN);
      expect(ip).not.toBe(CLIENT);
      expect(ip).toBe(normalizeIp(peer));
    });
  it('ignores the header from a public peer: a direct client cannot supply its own chain', async () => {
    expect(await clientIp(render, SPOOF_2, `${SPOOF}, ${CHAIN}`)).toBe(SPOOF_2);
    expect(await clientIp(render, '198.51.100.99', CHAIN)).toBe('198.51.100.99');
  });
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.20.30.40', '172.20.1.1', '192.168.1.1', '169.254.1.1', 'fd00::1'])(
    'trusts a private or loopback peer (%s)', async (peer) => {
      expect(await clientIp(render, peer, CHAIN)).toBe(CLIENT);
    });
});

describe('TRUST_PROXY_HOPS', () => {
  it('defaults to 0 and then ignores X-Forwarded-For, whatever it holds', async () => {
    expect(await clientIp({}, PEER, `${SPOOF}, ${CHAIN}`)).toBe(PEER);
    expect(await clientIp({ TRUST_PROXY_HOPS: '0' }, PEER, CHAIN)).toBe(PEER);
    expect(await clientIp({}, PEER, SPOOF)).toBe(PEER);
  });
  it.each([1, 2, 3, 4, 5])('trusts exactly %i hop(s): the client is the address that many places left of the socket', async (hops) => {
    // [spoofed, client, then hops-1 proxy entries]; the socket itself is hop 0.
    const proxies = Array.from({ length: hops - 1 }, (_, index) => `203.0.113.${100 + index}`);
    expect(await clientIp({ TRUST_PROXY_HOPS: String(hops) }, PEER, [SPOOF, CLIENT, ...proxies].join(', '))).toBe(CLIENT);
  });
  it('is not "trust everything": with one hop the leftmost entry is not taken', async () => {
    expect(await clientIp({ TRUST_PROXY_HOPS: '1' }, PEER, `${SPOOF}, ${CLIENT}`)).toBe(CLIENT);
  });
});

describe('the address used as the rate-limit key', () => {
  it.each([
    ['IPv6', '2001:db8:1:2:3:4:5:6'], ['::ffff: mapped', '::ffff:198.51.100.7'],
  ])('accepts a valid %s value at the client slot', async (_label, value) => {
    const ip = await clientIp(render, PEER, `${SPOOF}, ${value}, ${CLOUDFLARE}, ${RENDER}`);
    expect(ip).toBe(normalizeIp(value));
  });
  it.each([['a trailing port', '198.51.100.7:4444'], ['markup', '<script>'], ['text', 'unknown'], ['a bracketed IPv6 with port', '[2001:db8::1]:443']])(
    'falls back to the socket address when the client slot holds %s', async (_label, value) => {
      expect(await clientIp(render, PEER, `${SPOOF}, ${value}, ${CLOUDFLARE}, ${RENDER}`)).toBe(PEER);
    });
  it('falls back to the socket address for an empty header (proxy-addr drops empty entries, so an empty slot cannot exist)', async () => {
    expect(await clientIp(render, PEER, '')).toBe(PEER);
  });
  it('treats the mapped and the plain spelling of an IPv4 address as one bucket', async () => {
    expect(await clientIp(render, PEER, `${SPOOF}, ::ffff:${CLIENT}, ${CLOUDFLARE}, ${RENDER}`)).toBe(CLIENT);
    expect(normalizeIp('::ffff:198.51.100.7')).toBe(normalizeIp('198.51.100.7'));
    expect(normalizeIp('::ffff:c633:6407')).toBe('198.51.100.7');
    expect(normalizeIp('0:0:0:0:0:ffff:198.51.100.7')).toBe('198.51.100.7');
  });
  it('shares one bucket within an IPv6 /64 and separates different /64s', () => {
    expect(normalizeIp('2001:db8:1:2::1')).toBe(normalizeIp('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(normalizeIp('2001:db8:1:2:0:0:0:1')).toBe(normalizeIp('2001:DB8:1:2::abcd'));
    expect(normalizeIp('2001:db8:1:2::1')).not.toBe(normalizeIp('2001:db8:1:3::1'));
    expect(normalizeIp('2001:db8:1:2::1')).not.toBe(normalizeIp('2001:db9:1:2::1'));
  });
  it('leaves IPv4 unchanged', () => {
    for (const address of ['198.51.100.7', '127.0.0.1', '0.0.0.0', '255.255.255.255']) expect(normalizeIp(address)).toBe(address);
  });
  it('is applied to the key built by the app', async () => {
    expect(await clientIp(render, PEER, `${SPOOF}, 2001:db8:1:2::9, ${CLOUDFLARE}, ${RENDER}`)).toBe('2001:db8:1:2::/64');
  });
});

describe('X-Forwarded-Host and X-Forwarded-Proto', () => {
  it.each(['0', '3'])('are not trusted from the client (TRUST_PROXY_HOPS=%s): request.host and protocol stay the real ones', async (hops) => {
    const { app } = edgeApp({ TRUST_PROXY_HOPS: hops });
    const seen: Array<{ host: string; hostname: string; protocol: string }> = [];
    app.addHook('onRequest', async (request) => { seen.push({ host: request.host, hostname: request.hostname, protocol: request.protocol }); });
    await app.inject({ url: '/health', remoteAddress: PEER,
      headers: { host: 'api.example.test', 'x-forwarded-host': 'evil.example.test', 'x-forwarded-proto': 'https', 'x-forwarded-for': CHAIN } });
    await app.close();
    expect(seen).toEqual([{ host: 'api.example.test', hostname: 'api.example.test', protocol: 'http' }]);
  });
});
