# QueuePilot local load report (B6)

Commit `8c5b1dd` (dirty tree) · 2026-10-20T10:19:00.418Z · Node v24.18.0 · Windows_NT 10.0.19045 x64 · 12 CPUs (Intel(R) Core(TM) i7-8750H CPU @ 2.20GHz) · 16 GB · reps=3

> Emulators + in-process LocalDispatchQueue (20 dispatches/s) on one machine. Not comparable with Cloud Run / Cloud Tasks / Upstash.

## Explicit local limits

- Local dispatch queue (`LocalDispatchQueue`): **20 dispatches/s**, concurrency 30, pumped every 100 ms. Not configurable by env. It caps accepted->COMPLETED throughput in every end-to-end scenario below.
- API admission: 40 req/s per instance, 32 in flight, backlog cap 20000. Excess is rejected `503 OVERLOADED`.
- Redis: `redis-off` = disabled; `redis-unreachable` = enabled but dead port (fail-closed/degraded path); `redis-on` = **NOT RUN: no reachable Redis (set QP_LOAD_REDIS_URL)**.

## Results (median across reps, min–max in parentheses)

### API admission (HTTP create path)

| variant/scenario | sent | accepted | accepted/s | rejected (all reps) | HTTP p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| redis-off/baseline | 300 (300–300) | 300 (300–300) | 20 (20–20) | none | 42.8 (40.1–43.2) | 53.2 (52.8–58.4) | 57.3 (56.9–88.1) |
| redis-off/spike | 800 (800–800) | 353 (353–354) | 44.1 (44–44.2) | 503 OVERLOADED: 1340 | 18.1 (18.1–18.4) | 39.1 (38.5–39.5) | 45.3 (44.9–48.6) |
| redis-off/recovery (spike phase) | 800 (800–800) | 359 (359–360) | 44.8 (44.4–44.9) | 503 OVERLOADED: 1322 | 25 (23.3–26) | 182.2 (146–219) | 250.8 (203.2–332) |
| redis-unreachable/baseline | 300 (300–300) | 300 (300–300) | 20 (20–20) | none | 40 (39.1–40) | 52.9 (52.2–53) | 67.8 (67–68.1) |
| redis-unreachable/spike | 800 (800–800) | 355 (353–356) | 44.2 (44.1–44.3) | 503 OVERLOADED: 1336 | 18.1 (18–18.3) | 38.7 (38.5–40.3) | 45.4 (44.3–51.9) |

HTTP latency covers all responses (accepted and rejected) measured by the load client on the same machine.

### Completion (queue + worker, end to end)

| variant/scenario | accepted | completed | failed | still pending | accept→COMPLETED p50 ms | p95 ms | p99 ms | drain wall s |
|---|---|---|---|---|---|---|---|---|
| redis-off/baseline | 300 (300–300) | 300 (300–300) | 0 (0–0) | 0 (0–0) | 8115 (8016–8163) | 14436 (14382–14441) | 14972 (14963–14985) | 2.2 (1.5–2.4) |
| redis-off/spike | 353 (353–354) | 353 (353–354) | 0 (0–0) | 0 (0–0) | 7476 (7218–7595) | 9627 (9348–9729) | 9942 (9873–10317) | 10.3 (9.5–10.9) |
| redis-off/recovery | 769 (769–770) | 769 (769–770) | 0 (0–0) | 0 (0–0) | 5229 (5202–5452) | 10912 (10892–11207) | 11761 (11633–12345) | n/a |
| redis-unreachable/baseline | 300 (300–300) | 300 (300–300) | 0 (0–0) | 0 (0–0) | 8550 (8516–8670) | 14512 (14512–14527) | 15044 (15001–15051) | 2.3 (2.3–2.4) |
| redis-unreachable/spike | 355 (353–356) | 355 (353–356) | 0 (0–0) | 0 (0–0) | 7901 (7891–7947) | 10854 (10124–10864) | 11048 (10463–11117) | 11.1 (10.9–11.1) |

Accept→COMPLETED is observed by polling `GET /requests/:id` every ~0.5–1 s, so its resolution is about that interval.

### Backlog and recovery (warm-up → spike → low tail)

| rep | peak outstanding | outstanding at spike end | recovery to ≤10 outstanding (s after spike end) | tail accept→COMPLETED p50 / p95 ms | warm-up p50 / p95 ms |
|---|---|---|---|---|---|
| redis-off #1 | 222 | 216 | 24.5 | 5174 / 10687 | 1864 / 2878 |
| redis-off #2 | 235 | 215 | 23.1 | 5067 / 11194 | 1906 / 2804 |
| redis-off #3 | 228 | 228 | 21.2 | 5381 / 11154 | 1776 / 2569 |

### Worker throughput (direct delivery, bypasses the 20/s local queue and admission)

| concurrency | deliveries/s | delivery p50 ms | p95 ms | p99 ms | completed / deliveries |
|---|---|---|---|---|---|
| 1 | 1.7 (1.7–1.7) | 578.1 (563.3–626.8) | 859.2 (854.7–859.4) | 880.3 (876.7–889.8) | 150/150, 150/150, 150/150 |
| 8 | 14 (13.3–14) | 545.4 (521.4–605.6) | 832.3 (824.3–839.2) | 863.2 (862.5–884.8) | 150/150, 150/150, 150/150 |
| 32 | 51.3 (49.6–51.7) | 543.3 (534.6–552.4) | 810 (800.7–825.4) | 860.1 (845.3–879.2) | 150/150, 150/150, 150/150 |

This measures worker handler + Firestore **emulator** transactions on one machine, not Cloud Run.

## Not run

- Redis enabled against a real Redis: NOT RUN: no reachable Redis (set QP_LOAD_REDIS_URL).
- Cloud Run, Cloud Tasks, Upstash, real Google OAuth: never exercised (no cloud load tests by design).
- k6: not installed here; see `tests/load/README.md` for the optional k6 plan.
