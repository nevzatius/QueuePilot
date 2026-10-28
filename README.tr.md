# QueuePilot

[English](README.md) · [Mimari](docs/ARCHITECTURE.md) · [Kararlar (ADR)](docs/DECISIONS.md) · [Görevler](docs/TASKS.md) · [Proje durumu](docs/PROJECT_STATE.md)

QueuePilot, **kalıcı (durable) istek kabulü ve asenkron işleme** için bir referans uygulamadır: istekleri hızlı kabul eder,
kabul edilmiş işi kaybetmez ve tekrarları zararsız hale getirir. Hazır bir ürün değil, tek küçük iş (servis taleplerinin
deterministik değerlendirmesi, triage) üzerinde gösterilen bir kalıptır.

İstemciler ani yük dalgaları (burst) halinde istek gönderir. API her isteği `202 Accepted` yanıtı vermeden önce
kalıcı olarak saklar; bağımsız bir worker isteği daha sonra yeniden deneme, kira (lease) ve kaybolan işi geri
kazanan bir reconciler ile işler.

**Durum:** Yerel MVP (API, worker, reconciler, Redis limitleri, React paneli) Firebase emülatörlerinde uçtan uca
çalışır ve CI'dan geçer; buna ek olarak 2026-10-22/23'te **tek bir geçici ücretsiz katman çalıştırması** (Render free, Firebase Spark,
Upstash) yapılmıştır. Google Cloud yolu (Cloud Run, Cloud Tasks, Cloud Scheduler) **çalıştırılmadı**: C1-C9 kontrolleri ÇALIŞTIRILMADI.
Ücretsiz katman çalıştırmasındaki her rakam tek bir çalıştırmadır (n=1). Bkz. [Bilinen sınırlamalar](#bilinen-sınırlamalar) ve [Bulut dağıtım durumu](#bulut-dağıtım-durumu).

- **Bu çalıştırmada canlı görülenler (her biri n=1):** Firebase Hosting'den Google ile giriş; tarayıcıdan farklı origin'e çağrı (CORS); bir
  isteğin kabul edilmesi, kuyruğa girmesi, worker tarafından işlenmesi ve Firestore'da `COMPLETED` yazılması; worker'ın dahili
  uç noktasına imzasız çağrının `401` dönmesi; art arda 15 saatlik scheduler tick'inin teslim edilmesi; idempotent tekrar (`202` + `Idempotent-Replayed: true`) ve
  `409 IDEMPOTENCY_KEY_REUSED` canlıda API düzeyinde Postman ile görüldü, tek koşu (arayüz anahtarı göstermez); soğuk başlangıçlar (worker için yaklaşık 25-35 s,
  API için yaklaşık 25 s, ikisi de soğukken yaklaşık bir dakika; n=1/2, yaklaşık; işlemin kendisi yaklaşık 1 s).
- **Otomatik testlerle kapsananlar, canlı gösterilmeyenler:** mükerrer teslimat bastırma, kira devralma
  (lease takeover), yeniden deneme bütçesi ve reconciler (modellenmiş kuyrukta domain ve worker testleri T1-T13, emülatör entegrasyon
  setleri; replay, çakışma ve mükerrer teslimat için ayrıca yerel emülatör e2e betiği).
- **Yapılmadı:** webhook teslimatı, kaos / hata enjeksiyonu ve herkese açık vitrin (yalnızca planlı, [ADR-020](docs/DECISIONS.md));
  bulut ölçeklenebilirliği veya production-hazırlık iddiası; Google Cloud yolu.

## Proje neden var?

Ani yük dalgaları klasik bir güvenilirlik problemidir: işi işlenebileceğinden hızlı kabul ederken onu kaybetmemek,
zararlı biçimde iki kez işlememek ve bir kiracının (tenant) diğerlerini aç bırakmasını önlemek gerekir. QueuePilot bu
probleme bilinçli olarak küçük tutulmuş bir alanda (*burst kabulü → kalıcı kayıt → hız sınırlı asenkron değerlendirme →
durum takibi*) bir çözüm gösterir ve **neyi iddia etmediğini** açıkça belirtir (aşağıya bakın).

**Bir benzetme (yalnızca benzetme).** Bir kargo şirketi düşünün. Gişe kolinizi kabul ettiğinde bir makbuz alırsınız: bu `HTTP 202`
demektir ve koli sisteme kaydedildi anlamına gelir, teslim edildi anlamına gelmez. Teslimat daha sonra olur. Kolinize atanan kurye
gelmezse süresi dolunca başka bir kurye devralır; ayrıca bir kontrolcü depoyu gezip kimsenin taşımadığı kolileri arar. Aynı koliyi
aynı referans numarasıyla iki kez kaydederseniz yine tek koli olur. QueuePilot istekler için aynısını yapar; gerçek bir kargo
şirketinden farkı, dış dünyaya giden gerçek bir yan etkisinin olmaması, yalnızca triage sonucunu üretmesidir.

**Bu depoda kullanılan terimler (bir kez açıklanır):**

- **Lease (kira)**: bir işin süreli sahipliği. Worker işlemeden önce 60 s'lik bir kira alır; sonucu yalnızca mevcut kira sahibi
  yazabilir, bu yüzden takılıp kalmış eski bir worker yeni sonucun üzerine yazamaz.
- **Reconciler**: zamanlanmış çalışan, uyandırması kaybolmuş veya worker'ı ortadan kaybolmuş istekleri bulup yeniden gönderen kontrolcü.
- **Idempotency key**: istemcinin bir `POST` ile gönderdiği anahtar. Aynı anahtar ve aynı gövde, ikinci bir istek yaratmak yerine
  ilk isteği döndürür.
- **At-least-once (en az bir kez) teslimat**: bir iş worker'a birden fazla kez teslim edilebilir ama sessizce düşmez. QueuePilot
  **uygulama düzeyinde korumalarla (idempotency, kira, deneme bütçesi, mutlak terminal durumlar) at-least-once** sunar;
  **exactly-once (tam bir kez) iddiası yoktur**.

## Teknolojiler

Node.js 24 · TypeScript (strict) · Fastify · Zod · Firestore (doğruluk kaynağı) · Firebase Authentication (Google ile
giriş) · Google Cloud Tasks veya Upstash QStash (seçilebilir kuyruk adaptörleri) · Redis (ioredis; yalnızca limit ve önbellek) ·
React + Vite + Tailwind · pnpm 10 workspace · Vitest · GitHub Actions.
Tasarımın hedef platformu (**çalıştırılmadı**): Cloud Run, Cloud Tasks, Cloud Scheduler, Firebase Hosting, bölge `europe-west1`.
Tek geçici canlı çalıştırma bunun yerine Render free (API ve worker iki ayrı servis), Firebase Spark (Auth, Firestore, Hosting) ve
Upstash (kuyruk ve saatlik zamanlayıcı olarak QStash, Redis) kullandı; bkz. [ADR-019](docs/DECISIONS.md).

Proje modüler bir monolittir: `packages/contracts` (Zod şemaları), `packages/domain` (saf durum makinesi ve karar
tabloları), `packages/core` (adaptörler), `apps/api`, `apps/worker`, `apps/web`. Bağımlılık yönü ESLint ile zorlanır.
Tam tasarım: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (İngilizce). Akış diyagramı için [README.md](README.md) dosyasına bakın.
Diyagram Google Cloud tasarımını gösterir. Ücretsiz katman çalıştırması Cloud Tasks ve Cloud Scheduler yerine Upstash QStash kullandı
(kuyruk ve dakikada bir yerine saatlik reconcile zamanlaması); akışın geri kalanı aynıdır.

## İstek yaşam döngüsü

1. API, Firebase ID token'ını doğrular; sonra kiracı üyeliğini, gövde doğrulamasını, dakikalık hız sınırını, gönderim
   kotasını ve kabul (admission) kontrolünü uygular.
2. Tek bir atomik Firestore yazımı idempotency kaydını, isteği (`ACCEPTED`) ve ilk olayı oluşturur. **Bu commit başarılı
   olduğunda istek kalıcı olarak kabul edilmiştir** ve API `202` döner. Commit başarısız olursa veya zaman aşımına uğrarsa
   `503` döner; istemci aynı anahtarla tekrar dener.
3. API ardından kuyrukta (tasarımda Cloud Tasks, ücretsiz katman çalıştırmasında QStash) en iyi çaba (best-effort) bir uyandırma görevi oluşturur. Başarısız olursa reconciler
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
**çalıştırılmadı** (yalnızca Redis kapalı ve Redis açık ama erişilemez varyantları ölçüldü); k6 çalıştırılmadı; Upstash QStash ve Redis tek bir canlı ücretsiz-katman çalıştırmasında (n=1) kullanıldı ancak Redis yük ölçümü yoktur; Cloud Run ve
Cloud Tasks hiç ölçülmedi. "10.000 RPS" gibi bir verim iddia edilmez ve gösterilmemiştir.

## Bilinen sınırlamalar

- **Production'a hazır değildir.** Google Cloud dağıtımı yok; tek bir geçici ücretsiz katman çalıştırması vardır (rakamlar birer çalıştırmadır). Güvenlik sertifikasyonu veya bağımsız denetim yok.
- Tasarımın varsaydığı Cloud Tasks semantiği (ADR-003/011/017), bakımcının bulut spike'ını (C1–C9 kontrolleri, **ÇALIŞTIRILMADI**)
  çalıştırmasına kadar **doğrulanmamıştır**. Varsayımlar yanlışsa tasarım yanlış duruma değil, fazladan görevlere dönüşür.
- Redis Lua betikleri ve adaptörleri gerçek Redis'e karşı yalnızca CI'da çalışır; geliştirici Windows makinesinde Redis yoktur.
- Google ile giriş gerçek Google'a karşı yalnızca bir kez, ücretsiz katman çalıştırmasında Firebase Hosting'den denenmiştir (n=1); diğer tüm testler Auth emülatörünü kullanır.
- Yük rakamları yereldir ve emülatör tabanlıdır (yukarıya bakın). Bulut ölçeklenebilirliği iddia edilmez.
- Başarısız isteklerin yönetici tarafından yeniden denenmesi bilerek etkinleştirilmemiştir.
- MIT lisansı altında yayımlanmıştır, bkz. [LICENSE](LICENSE).

## Barındırılan bir hizmet değildir

Ücretsiz katman dağıtımı herkese açık değildir, kayıt kapalıdır ve destek verilmez. `docs/DEMO.md` ve `docs/USE_CASES.md` Türkçe yazılmıştır.

## Bulut dağıtım durumu

**Google Cloud yolu: başlanmadı.** Google Cloud projesi, faturalandırma, Cloud Run servisi, kuyruk veya Scheduler işi yoktur (C1-C9 ÇALIŞTIRILMADI).
Ücretsiz katmanlarda (Render free, Firebase Spark, Upstash) ilk canlı dağıtım 2026-10-22/23'te bir kez çalıştırılmıştır ve geçicidir; rakamlar birer çalıştırmadır (bkz. [docs/TASKS.md](docs/TASKS.md), "B9-9 live results").
Altyapı betikleri, API ve worker Dockerfile'ları, korumalı deploy/shutdown sarmalayıcıları, yönetici yetkisi verme betiği ve demo tohum betiği
yazılmış ve yalnızca çevrimdışı veya emülatörde test edilmiştir ([infra/README.md](infra/README.md), [infra/CLOUD_VERIFICATION.md](infra/CLOUD_VERIFICATION.md));
durum değiştiren her adım bakımcının açık onayını gerektirir ve varsayılan olarak dry-run'dır. Yerel hazırlık kontrolü: `node scripts/preflight.mjs`
(bakımcı `--run` eklemedikçe Google Cloud'a bağlanmaz; `--run` yalnızca okur). Adım adım bakımcı rehberi: [docs/DEPLOYMENT_RUNBOOK.md](docs/DEPLOYMENT_RUNBOOK.md). Yerel emülatör demosu ile bulut
dağıtımı farklı şeylerdir: bugün gösterilen yalnızca ilkidir; bulut tarafı doğrulanmamıştır (C1-C9, Cloud Run/Tasks davranışı, gerçek Redis yükü ve k6 ÇALIŞTIRILMADI; gerçek Google ile giriş, Upstash QStash ve Redis yalnızca tek bir ücretsiz-katman çalıştırmasında kullanıldı).

## GitHub Actions doğrulaması

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) her push ve pull request'te Ubuntu üzerinde Node 24, Java 21 ve `redis:7.4-alpine`
servisiyle çalışır: dondurulmuş lockfile ile kurulum, lint, typecheck, birim testleri (node, web, altyapı), build, ardından entegrasyon
paketi (emülatörler, gerçek Redis, smoke testleri) ve Node ESM çıktı kontrolü. İkinci bir iş, API ve worker imajlarını depo kökünden derler
(`docker build -f apps/<app>/Dockerfile .`), yalnızca demo ayarlarıyla smoke testten geçirir; hiçbir registry'ye giriş yapmaz veya push etmez. Son sonuç
için deponun Actions sekmesine bakın; bu README sonucu sabit olarak yazmaz.
