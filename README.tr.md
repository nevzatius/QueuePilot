# QueuePilot

[English](README.md) · [Mimari](docs/ARCHITECTURE.md) · [Kararlar (ADR)](docs/DECISIONS.md) · [Görevler](docs/TASKS.md) · [Proje durumu](docs/PROJECT_STATE.md)

QueuePilot, **kalıcı (durable) istek kabulü ve asenkron işleme** üzerine bir mühendislik vitrin projesidir.
İstemciler ani yük dalgaları (burst) halinde istek gönderir. API her isteği `202 Accepted` yanıtı vermeden önce
kalıcı olarak saklar; bağımsız bir worker isteği daha sonra yeniden deneme, kira (lease) ve kaybolan işi geri
kazanan bir reconciler ile işler.

**Durum:** Yerel MVP (API, worker, reconciler, Redis limitleri, React paneli) Firebase emülatörlerinde uçtan uca
çalışır ve CI'dan geçer. **Google Cloud'a hiçbir şey dağıtılmamıştır** ve bulut davranışının hiçbiri doğrulanmamıştır.
Bkz. [Bilinen sınırlamalar](#bilinen-sınırlamalar) ve [Bulut dağıtım durumu](#bulut-dağıtım-durumu).

## Proje neden var?

Ani yük dalgaları klasik bir güvenilirlik problemidir: işi işlenebileceğinden hızlı kabul ederken onu kaybetmemek,
zararlı biçimde iki kez işlememek ve bir kiracının (tenant) diğerlerini aç bırakmasını önlemek gerekir. QueuePilot bu
probleme bilinçli olarak küçük tutulmuş bir alanda (*burst kabulü → kalıcı kayıt → hız sınırlı asenkron değerlendirme →
durum takibi*) bir çözüm gösterir ve **neyi iddia etmediğini** açıkça belirtir (aşağıya bakın).

## Teknolojiler

Node.js 24 · TypeScript (strict) · Fastify · Zod · Firestore (doğruluk kaynağı) · Firebase Authentication (Google ile
giriş) · Google Cloud Tasks · Redis (ioredis; yalnızca limit ve önbellek) · React + Vite + Tailwind · pnpm 10 workspace ·
Vitest · GitHub Actions. Hedef platform (henüz dağıtılmadı): Cloud Run, Cloud Scheduler, Firebase Hosting, bölge `europe-west1`.

Proje modüler bir monolittir: `packages/contracts` (Zod şemaları), `packages/domain` (saf durum makinesi ve karar
tabloları), `packages/core` (adaptörler), `apps/api`, `apps/worker`, `apps/web`. Bağımlılık yönü ESLint ile zorlanır.
Tam tasarım: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (İngilizce). Akış diyagramı için [README.md](README.md) dosyasına bakın.

## İstek yaşam döngüsü

1. API, Firebase ID token'ını doğrular; sonra kiracı üyeliğini, gövde doğrulamasını, dakikalık hız sınırını, gönderim
   kotasını ve kabul (admission) kontrolünü uygular.
2. Tek bir atomik Firestore yazımı idempotency kaydını, isteği (`ACCEPTED`) ve ilk olayı oluşturur. **Bu commit başarılı
   olduğunda istek kalıcı olarak kabul edilmiştir** ve API `202` döner. Commit başarısız olursa veya zaman aşımına uğrarsa
   `503` döner; istemci aynı anahtarla tekrar dener.
3. API ardından Cloud Tasks'ta en iyi çaba (best-effort) bir uyandırma görevi oluşturur. Başarısız olursa reconciler
   işi geri kazanır.
4. Worker, bir Firestore transaction'ında kira alır, deterministik değerlendirmeyi çalıştırır ve sonucu kira ile
   korunmuş (fenced) olarak `COMPLETED` (veya `FAILED`) şeklinde yazar. Durumlar: `ACCEPTED → PROCESSING → COMPLETED | FAILED`.

## Teslimat garantileri (neyi iddia ediyoruz, neyi etmiyoruz)

QueuePilot **en az bir kez (at-least-once) teslimat + uygulama düzeyinde korumalar** kullanır. **Tam bir kez (exactly-once)
teslimat, Cloud Tasks için exactly-once semantiği veya kuyruk bekleme süresi üzerinde bir üst sınır iddia edilmez.**
Yinelenen veya fazladan teslimatlar mümkündür; aşağıdaki korumalar bunları zararsız hale getirir.

- **Idempotency.** `POST` için `Idempotency-Key` zorunludur. Kapsam kiracı + kullanıcıdır; parmak izi doğrulanmış
  gövdenin kanonik hash'idir. 24 saat içinde aynı anahtar ve aynı gövde → aynı `requestId` ve `Idempotent-Replayed: true`
  ile `202`. Aynı anahtar, farklı gövde → `409 IDEMPOTENCY_KEY_REUSED`. Süre dolumu Firestore TTL'ine değil kod içindeki
  kontrole dayanır.
- **Yeniden denemeler.** Cloud Tasks yeniden denemeleri yalnızca emniyet ağıdır. Deneme bütçesi (`MAX_ATTEMPTS=5`)
  kuyruk başlıklarından değil Firestore'da sayılır. Geçici hatalar isteği `ACCEPTED` durumuna döndürür; bütçe tükenirse `FAILED`.
- **ADR-017: dispatch bir uyandırmadır, doğruluk sinyali değildir.** Görev yalnızca worker'ı uyandırır; yürütme kararını
  yalnızca Firestore verir. Her dispatch emri `createTask`'tan önce `seq++` değerini commit eder; böylece her `r-{id}-{seq}`
  görev adının tek bir yaratıcısı olur ve `ALREADY_EXISTS` "oluşturuldu" sayılır. Reconciler kaybolan işi yeniden dispatch eder
  (önce hızlı emirler, sonra daha seyrek "attention" emirleri) ve dispatch sorunları yüzünden bir isteği asla başarısız yapmaz.
  Fazladan görevlerin maliyeti 409/200 yanıtlarıdır; yanlış durum değildir.
- **Worker kirası ve fencing.** Teslimat, transaction içinde 60 sn'lik bir kira (`leaseId`) alır. Yalnızca güncel `leaseId`
  sahibi `COMPLETED`/`FAILED` yazabilir (değişmez I4); kirası devralınmış takılı bir worker sonucu ezemez. Terminal
  durumlar değişmezdir (I3).
- **I1–I7 değişmezleri** [ARCHITECTURE §7](docs/ARCHITECTURE.md) içinde listelenmiştir; tablo güdümlü domain testleri,
  yarış (race) paketi ve fuzz testleriyle sınanır.

## Doğruluk kaynağı Firestore

Tüm iş durumu (istekler, olaylar, idempotency anahtarları, üyelikler, kiracılar) Firestore'dadır. Redis hiçbir zaman iş
durumu tutmaz: Redis'in kaybı bir isteği kaybettirmez veya çoğaltmaz.

## Redis kota politikası

Redis yalnızca hız limiti, gönderim kotası ve 5 sn'lik metrik önbelleği için kullanılır.

| Kullanım | Redis sağlıklı | Redis erişilemez |
|---|---|---|
| Burst limiti (kullanıcı başına dakika) | paylaşılan atomik sayaç (Lua) | instance başına bellek limiti (`limit / maxInstances`), "degraded" olarak loglanır |
| Gönderim kotası (kullanıcı/gün, kiracı/gün), `quotaMode=enforced` kiracılar | kullanıcı + kiracı sayaçlarının atomik Lua rezervasyonu | **fail-closed: `Retry-After` ile `503 QUOTA_UNAVAILABLE`**. Daha önce kabul edilmiş isteklerin tekrarı (replay) yine başarılı olur |
| Metrik önbelleği | Redis | bellek içi önbellek + Firestore `count()` |

Kota aşımı, UTC gün sınırına kalan saniye kadar `Retry-After` ile `429 QUOTA_EXCEEDED` döner. Rezervasyon yalnızca Firestore
commit'inin kesin başarısız olduğu durumda iade edilir; belirsiz sonuçta UTC gün dönümüne kadar tutulur
([ADR-018](docs/DECISIONS.md)). `QP_QUOTA_FAILURE_MODE=open` yalnızca production dışı kullanım içindir.

## Yerel kurulum

Gereksinimler: Node 24, Java 21+ (Firebase emülatörleri) ve Redis testleri için `localhost:6379` üzerinde bir Redis.
pnpm sürümü `package.json` içinde sabittir; `PATH`'te değilse komutların başına `corepack` ekleyin (örn. `corepack pnpm install`).
Global kurulum gerekmez. Windows'ta JDK `bin` dizinini Oracle `javapath`'ten önce `PATH`'e koyun. Redis Windows için paketlenmemiştir:
WSL, Docker veya Memurai kullanın ya da Redis paketi için CI'a güvenin.

```sh
pnpm install --frozen-lockfile
pnpm build
```

### Ortam yapılandırması

[.env.example](.env.example) yerel ayarları açıklar (demo proje `demo-queuepilot`, emülatör adresleri, `REDIS_URL`,
`QP_REDIS_ENABLED`, `QP_MAX_INSTANCES`, `QP_QUOTA_FAILURE_MODE`). Betikler `.env` dosyasını **otomatik yüklemez**; değişkenleri
dışa aktarın veya komuta satır içinde verin. Depoya asla gerçek kimlik bilgisi koymayın.

### Firebase emülatörleri

```sh
pnpm emulators        # Auth (9099) ve Firestore (8080), proje demo-queuepilot, giriş gerekmez
```

### API ve worker'ı başlatma

`pnpm build` sonrası ve emülatörler çalışırken API ve worker'ı iki ayrı süreç olarak başlatın. Tamamen yerel bir çiftin (yerel kuyruk
pompası, yerel worker kimlik doğrulaması, yalnızca demo proje) tam komutları [docs/verification/README.md](docs/verification/README.md)
içindedir. `pnpm build` ayrıca dağıtılabilir paketleri (`apps/api/dist/index.js`, `apps/worker/dist/index.js`) üretir; CI bunların
sözdizimini denetler. Web uygulaması `pnpm --filter @queuepilot/web dev` ile çalışır.

## Testler

| Komut | Ne çalıştırır | Gerekenler |
|---|---|---|
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | ESLint (bağımlılık sınırları dahil), TypeScript, paketleme | – |
| `pnpm test` | Node birim testleri (Vitest), web jsdom testleri, çevrimdışı altyapı ve sahip-betiği testleri | – |
| `pnpm test:integration` | Auth + Firestore emülatörlerini başlatır; API/worker entegrasyonu, web→API smoke, worker açılış smoke ve **gerçek Redis paketlerini** çalıştırır | Java 21, `REDIS_URL` üzerinde Redis |

Gerçek Redis testleri: `tests/integration/redis.test.ts` (Lua betikleri), `tests/integration/redis-adapters.test.ts` (kota deposu,
hız sınırlayıcı, bağlantı kurtarma) ve `apps/api/test/integration/redis-quota.test.ts` (Firestore emülatörü ve gerçek Redis ile HTTP API).
Atlama yolu yoktur: Redis yoksa başarısız olurlar. Diğer paketler emülatör veya test double kullanır; her dosyada belirtilmiştir.
Gerçek bulut dışında Cloud Tasks kuyruğu her zaman bir test double'dır.

### Yerel smoke testleri

`docs/verification/e2e-local.mjs` (gerçek derlenmiş API ve worker'a karşı 25 kontrol, emülatörler, Redis gerekmez) ve
`pnpm test:integration` içindeki smoke adımları. Kimlik doğrulama emülatörün Google sağlayıcısıdır, **gerçek OAuth değildir**.
Bkz. [docs/verification/README.md](docs/verification/README.md).

## Yerel yük testleri (B6)

```sh
pnpm build
node tests/load/run.mjs                 # baseline, spike, recovery, worker throughput; her biri 3 tekrar (~15 dk)
node tests/load/run.mjs --quick --reps 1
```

Yöntem ve senaryo tablosu: [tests/load/README.md](tests/load/README.md). Kaydedilen çalıştırmanın ham verisi ve raporu:
[tests/load/results/2026-10-20T10-19-00-417Z/](tests/load/results/2026-10-20T10-19-00-417Z/REPORT.md).

**Yerel koşullarda ölçülenler (Windows dizüstü, i7-8750H, 12 mantıksal CPU, 16 GB, Firebase emülatörleri, tek API ve tek worker süreci,
3 tekrar, medyanlar):**

| Senaryo | Gözlem |
|---|---|
| Baseline, 20 istek/sn × 15 sn | Her tekrarda 300/300 kabul edildi ve tamamlandı; create yolu HTTP p50 ≈ 43 ms, p95 ≈ 53 ms, p99 ≈ 57 ms |
| Spike, 100 istek/sn × 8 sn | Çalıştırma başına 800 isteğin ≈ 353'ü kabul edildi, kabul edilenlerin hepsi tamamlandı (0 başarısız, 0 kayıp); kalanı admission control tarafından `503 OVERLOADED` ile reddedildi |
| Spike sonrası toparlanma | Backlog tepe noktası 222–235; spike bitiminden 21–24,5 sn sonra bekleyen ≤ 10 |
| Worker verimi (kuyruksuz doğrudan teslimat) | Eşzamanlılık 1'de ≈ 1,7/sn, 8'de ≈ 14/sn, 32'de ≈ 51/sn (handler + Firestore **emülatörü**) |

Bu sayılar **production benchmark'ı değildir**. Yük üreteci test edilen sistemle aynı makineyi paylaşır; Firestore emülatördür; uçtan uca
tamamlanma süreleri saniyede 20 dispatch ile hız sınırlı süreç içi yerel kuyrukla sınırlıdır; gerçek Redis ile Redis-açık varyantı
**çalıştırılmadı** (yalnızca Redis kapalı ve Redis açık ama erişilemez varyantları ölçüldü); k6 çalıştırılmadı; Cloud Run, Cloud Tasks ve
Upstash hiç ölçülmedi. "10.000 RPS" gibi bir verim iddia edilmez ve gösterilmemiştir.

## Bilinen sınırlamalar

- **Production'a hazır değildir.** Bulut dağıtımı yok, güvenlik sertifikasyonu veya bağımsız denetim yok.
- Tasarımın varsaydığı Cloud Tasks semantiği (ADR-003/011/017), sahibin bulut spike'ını (C1–C9 kontrolleri, **ÇALIŞTIRILMADI**)
  çalıştırmasına kadar **doğrulanmamıştır**. Varsayımlar yanlışsa tasarım yanlış duruma değil, fazladan görevlere dönüşür.
- Redis Lua betikleri ve adaptörleri gerçek Redis'e karşı yalnızca CI'da çalışır; geliştirici Windows makinesinde Redis yoktur.
- Google ile giriş yalnızca Auth emülatörü üzerinden denenmiştir; gerçek Google OAuth kullanılmamıştır.
- Yük rakamları yereldir ve emülatör tabanlıdır (yukarıya bakın). Bulut ölçeklenebilirliği iddia edilmez.
- Başarısız isteklerin yönetici tarafından yeniden denenmesi bilerek etkinleştirilmemiştir. Henüz lisans dosyası yoktur; lisans konusu
  sahibin kararını beklemektedir.

## Bulut dağıtım durumu

**Başlanmadı.** Google Cloud projesi, faturalandırma, Cloud Run servisi, kuyruk, Scheduler işi veya Upstash veritabanı yoktur.
Altyapı betikleri, API ve worker Dockerfile'ları, korumalı deploy/shutdown sarmalayıcıları, yönetici yetkisi verme betiği ve demo tohum betiği
yazılmış ve yalnızca çevrimdışı veya emülatörde test edilmiştir ([infra/README.md](infra/README.md), [infra/CLOUD_VERIFICATION.md](infra/CLOUD_VERIFICATION.md));
durum değiştiren her adım sahibin açık onayını gerektirir ve varsayılan olarak dry-run'dır. Yerel hazırlık kontrolü: `node scripts/preflight.mjs`
(Google Cloud'a hiç bağlanmaz). Adım adım sahip rehberi: [docs/DEPLOYMENT_RUNBOOK.md](docs/DEPLOYMENT_RUNBOOK.md). Yerel emülatör demosu ile bulut
dağıtımı farklı şeylerdir: bugün gösterilen yalnızca ilkidir; bulut tarafı doğrulanmamıştır (C1-C9, gerçek Google OAuth, Cloud Run/Tasks davranışı ve
Upstash/TLS ÇALIŞTIRILMADI).

## GitHub Actions doğrulaması

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) her push ve pull request'te Ubuntu üzerinde Node 24, Java 21 ve `redis:7.4-alpine`
servisiyle çalışır: dondurulmuş lockfile ile kurulum, lint, typecheck, birim testleri (node, web, altyapı), build, ardından entegrasyon
paketi (emülatörler, gerçek Redis, smoke testleri) ve Node ESM çıktı kontrolü. İkinci bir iş, API ve worker imajlarını depo kökünden derler
(`docker build -f apps/<app>/Dockerfile .`), yalnızca demo ayarlarıyla smoke testten geçirir; hiçbir registry'ye giriş yapmaz veya push etmez. Son sonuç
için deponun Actions sekmesine bakın; bu README sonucu sabit olarak yazmaz.
