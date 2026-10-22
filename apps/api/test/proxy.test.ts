import { describe, expect, it } from 'vitest';
import type { RateLimiter } from '@queuepilot/core';
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
  it('is not changed by spoofed entries added on the left', async () => {
    expect(await clientIp(render, PEER, `${SPOOF}, ${CHAIN}`)).toBe(CLIENT);
    expect(await clientIp(render, PEER, `${SPOOF_2}, ${SPOOF}, ${SPOOF_2}, ${SPOOF}, ${CHAIN}`)).toBe(CLIENT);
    expect(await clientIp(render, PEER, `not-an-ip, ${SPOOF}, ${CHAIN}`)).toBe(CLIENT);
    expect(await clientIp(render, PEER, CHAIN)).toBe(CLIENT);
  });
  it('uses the socket address when there is no X-Forwarded-For', async () => {
    expect(await clientIp(render, PEER)).toBe(PEER);
  });
  it('never lets a too-short chain choose the address: the header is ignored and the socket address is used', async () => {
    expect(await clientIp(render, PEER, SPOOF)).toBe(PEER);
    expect(await clientIp(render, PEER, `${SPOOF}, ${CLOUDFLARE}`)).toBe(PEER);
    expect(await clientIp(render, PEER, ' , ,')).toBe(PEER);
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
