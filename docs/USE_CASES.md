# Bu kalıp nerelerde işe yarar

QueuePilot bir **kalıp / referans uygulamadır, hazır bir ürün değildir.** Bugün gerçekten uygulanmış tek iş, servis taleplerinin
deterministik değerlendirmesidir (triage; [ARCHITECTURE §17](ARCHITECTURE.md)). Aşağıdaki beş alan, aynı kalıbın başka işlere
**nasıl uyarlanabileceğini** anlatan senaryolardır; hiçbiri uygulanmış, ölçülmüş veya canlıda denenmiş değildir. Her bölümün sonunda
QueuePilot'un o senaryoda **yapmadığı** şey açıkça yazılıdır.

Teslimat sözü her alanda aynıdır: **uygulama düzeyinde korumalarla at-least-once**. Exactly-once iddiası yoktur
([ARCHITECTURE §7](ARCHITECTURE.md), "Non-claims").

Terimler: **lease** = bir işin süreli sahipliği; **reconciler** = kaybolmuş işi bulan kontrolcü; **idempotency key** = aynı isteğin
tekrarını tanıyan anahtar; **fencing** = eski lease sahibinin sonucu yazmasını engelleme.

---

## 1. Destek talebi (support ticket) değerlendirme

QueuePilot'un mevcut hâline en yakın alan budur: istek türleri arasında zaten `support_ticket` vardır (`packages/contracts`, triage
kural tablosu `packages/domain/src/triage/rules-v1.ts`) ve uygulanmış iş zaten bir talep sınıflandırmasıdır. Bir kampanya sonrası yüzlerce talep birkaç dakikada gelir;
her talebin öncelik hattı (lane), hedef süresi ve ekibi kurallara göre belirlenir.

- **Kaybolmaması gereken:** kabul edilmiş (`202` alınmış) her talep.
- **İki kez olmaması gereken (veya tekrarında zararsız olması gereken):** aynı talebin çift kayıt olması (kullanıcı tekrar gönderdi ya da ağ
  yeniden denedi). Sınıflandırma zaten aynı girdi ve kural sürümü için aynı sonucu verir (I6), yani tekrar işlemek zararsızdır.
- **Hangi mekanizma karşılıyor:**
  - *Kabul-sonra-işle (outbox):* `202`, talebin Firestore'a yazıldığı anlamına gelir; işlem sonra yapılır (I1, ADR-004).
  - *Idempotency key:* aynı anahtar ve gövde ilk talebi döndürür, farklı gövde `409` verir.
  - *Lease ve fencing:* worker sonucu yalnızca geçerli kira ile yazabilir (I4).
  - *Retry budget:* en fazla 5 işleme denemesi, sonra `FAILED` (I5).
  - *Reconciler:* kaybolan uyandırma görevini yeniden gönderir.
  - *Kota ve hız sınırı:* kullanıcı başına dakikalık ve günlük, kiracı başına günlük sınır.
  - *Kiracı yalıtımı:* üye yalnızca kendi taleplerini görür, yönetici tüm kiracıyı görür (ARCHITECTURE §11).
- **QueuePilot'un bu senaryoda YAPMADIĞI şey:** talebi gerçek bir destek sistemine (e-posta, CRM, bilet aracı) iletmez; bir insana
  atama veya yanıt göndermez; talepler arasında sıra garantisi vermez; exactly-once iddia etmez.

## 2. E-ticaret sipariş / ödeme olayları

Bir ödeme sağlayıcısı veya mağaza, "sipariş oluşturuldu" ve "ödeme alındı" olaylarını bir uç noktaya gönderir; sağlayıcılar aynı olayı
yeniden denediği için aynı olay birden fazla gelebilir. Olayın hızla onaylanıp arka planda işlenmesi gerekir.

- **Kaybolmaması gereken:** onaylanmış her olay; bir ödeme olayının sessizce düşmesi.
- **İki kez olmaması gereken (veya tekrarında zararsız olması gereken):** aynı olayın iki kez uygulanması (çift stok düşümü, çift fatura).
- **Hangi mekanizma karşılıyor:**
  - *Idempotency key:* sağlayıcının olay kimliği anahtar olarak kullanılırsa tekrar gelen olay ikinci kayıt yaratmaz (kapsam: kiracı + kullanıcı, 24 saat penceresi).
  - *Kabul-sonra-işle:* olay önce kalıcı yazılır, sonra işlenir; sağlayıcıya hızlı onay verilir.
  - *Retry budget ve reconciler:* geçici hatalarda sınırlı yeniden deneme; kaybolan iş yeniden gönderilir, bütçe bitince iş `FAILED` olarak görünür kalır.
  - *Kota ve hız sınırı:* bir kiracının ani yükü diğerlerini aç bırakmaz.
- **QueuePilot'un bu senaryoda YAPMADIĞI şey:** ödeme almaz, stok düşmez, fatura kesmez; yani gerçek dış yan etkisi yoktur. Dış sistemi çağıran bir
  iş eklenirse, bir worker'ın çağrıyı yapıp sonucu yazmadan düşmesi o çağrının ikinci kez yapılmasına yol açabilir; bunu çağrılan
  tarafın idempotent olması karşılamalıdır (lease yalnızca Firestore yazımını korur, dış çağrıyı korumaz; ADR-020 karar 3, planlı).
  Aynı siparişe ait olaylar arasında sıra garantisi vermez. Exactly-once iddia etmez.

## 3. Bildirim / e-posta gönderimi

Bir uygulama toplu duyuru veya işlem bildirimi (şifre sıfırlama, kargo bilgisi) göndermek ister. Kullanıcıya "alındı" hızla söylenir,
gerçek gönderim kuyrukta bekler ve sağlayıcı geçici hata verirse tekrar denenir.

- **Kaybolmaması gereken:** kabul edilmiş her bildirim isteği.
- **İki kez olmaması gereken (veya tekrarında zararsız olması gereken):** aynı kişiye aynı bildirimin iki kez gitmesi.
- **Hangi mekanizma karşılıyor:**
  - *Kabul-sonra-işle:* istek kalıcı yazılır, gönderim sonra yapılır.
  - *Idempotency key:* istemci aynı anahtarı tekrar gönderirse ikinci istek oluşmaz.
  - *Retry budget:* geçici sağlayıcı hatasında sınırlı deneme, sonra `FAILED`.
  - *Lease ve fencing:* aynı isteği iki worker'ın aynı anda sürdürmesi engellenir (ikincisi `409` alır).
  - *Kota ve hız sınırı:* kullanıcı başına gönderim kotası kötüye kullanımı sınırlar; Redis yoksa kota kapalı-başarısız (fail closed) olur.
- **QueuePilot'un bu senaryoda YAPMADIĞI şey:** e-posta veya SMS göndermez (şu an hiçbir dış yan etki yoktur; tek planlı örnek webhook
  teslimatıdır ve yalnızca planlıdır, ADR-020). Teslim edildi / okundu takibi, şablon yönetimi ve gönderim sırası garantisi yoktur.
  Gönder-sonra-çök durumunda aynı bildirimin ikinci kez gitmesi tasarımda mümkündür; bunu alıcı tarafın idempotent olması karşılamalıdır.

## 4. Rapor / dosya işleme

Kullanıcı bir rapor üretilmesini veya yüklediği bir dosyanın işlenmesini ister. İstek hemen kabul edilir, sonuç hazır olunca durum
`COMPLETED` olur ve kullanıcı durumu sorgulayarak izler.

- **Kaybolmaması gereken:** kabul edilmiş iş isteği ve onun durumu.
- **İki kez olmaması gereken (veya tekrarında zararsız olması gereken):** aynı raporun iki kez üretilmesi (maliyet ve yinelenen çıktı).
  İşlem sonucu girdiden deterministik üretiliyorsa tekrar zararsızdır (I6 bu özelliği triage için sağlar).
- **Hangi mekanizma karşılıyor:**
  - *Kabul-sonra-işle ve durum takibi:* `ACCEPTED → PROCESSING → COMPLETED | FAILED`; kullanıcı durumu ve zaman çizelgesini görür.
  - *Lease ve fencing:* worker takılırsa kira süresi dolunca başka bir worker devralır; eski worker'ın geç sonucu reddedilir.
  - *Retry budget:* sonsuz yeniden deneme yok; bütçe bitince `FAILED` ve sebep görünür.
  - *Reconciler:* uyandırması kaybolan iş yeniden gönderilir.
  - *Idempotency key:* kullanıcı çift tıklasa da tek iş oluşur.
- **QueuePilot'un bu senaryoda YAPMADIĞI şey:** dosya depolamaz (Cloud Storage ücretsiz yolda kullanılamıyor, ADR-019) ve dosya
  yüklemeyi desteklemez. Tek bir işleme denemesi için tasarım zaman aşımı 20 s'dir (`PROC_TIMEOUT`, ARCHITECTURE §6) ve kira 60 s'dir,
  yani uzun süren işler (dakikalar) mevcut sabitlerle desteklenmez; ilerleme yüzdesi veya iptal yoktur. Exactly-once iddia etmez.

## 5. IoT / olay alımı (event ingestion)

Çok sayıda cihaz veya servis kısa aralıklarla küçük olaylar gönderir. Alım tarafı hızlı onay vermeli, yük dalgasında kendini korumalı
ve olayları arka planda işlemelidir.

- **Kaybolmaması gereken:** onaylanmış (kabul edilmiş) olaylar; yük altında reddedilen olayın reddedildiğinin açıkça bilinmesi.
- **İki kez olmaması gereken (veya tekrarında zararsız olması gereken):** cihazın ağ kesintisi sonrası aynı ölçümü tekrar göndermesi.
- **Hangi mekanizma karşılıyor:**
  - *Kabul kontrolü (admission control, ADR-012):* yazma hızı Redis'ten bağımsız olarak üst sınırlanır; aşırı yükte `503 OVERLOADED` + `Retry-After` döner, kabul edilmiş iş kaybolmaz.
  - *Idempotency key:* cihazın olay kimliği anahtar olursa tekrar gönderim ikinci kayıt yaratmaz.
  - *Kota ve hız sınırı:* bir cihaz / kiracı diğerlerini aç bırakamaz.
  - *Kabul-sonra-işle ve reconciler:* kabul edilen olay işlenene kadar kalıcıdır; kaybolan uyandırma yeniden gönderilir.
  - *Kiracı yalıtımı:* her kiracının olayları ayrı görünür.
- **QueuePilot'un bu senaryoda YAPMADIĞI şey:** yüksek hacim iddiası taşımaz. Kabul kontrolündeki sınırlar yapılandırılmış üst sınırlardır, ölçülmüş
  kapasite değildir (ARCHITECTURE §10); yerel yük denemesi bir dizüstü bilgisayarda emülatörlerle yapılmıştır ve üretim kıyaslaması değildir.
  Zaman serisi depolama, toplulaştırma, olaylar arası sıra garantisi veya akış işleme (stream processing) yoktur. Exactly-once iddia etmez.

---

## Özet tablo: mekanizma, anlamı, yeri ve kanıt durumu

Durum sütunu şu üç değerden birini kullanır: **canlı görüldü** (2026-10-22/23 ücretsiz katman çalıştırması, n=1), **test edildi**
(otomatik test veya yerel emülatör betiği; canlı gösterilmedi), **yalnızca tasarlandı**. Birden fazla durum varsa ayrı ayrı yazılmıştır.

| Mekanizma | Düz anlamı | Nerede yaşıyor | Durum |
|---|---|---|---|
| Kabul-sonra-işle (outbox) | `202` = talep kaydedildi; işlem sonra | [ARCHITECTURE §4](ARCHITECTURE.md), ADR-004; `packages/core` (`requests.ts`), `apps/api` | Canlı görüldü (bir talep `COMPLETED`'a ulaştı, n=1); test edildi |
| Idempotency key | Aynı anahtar + aynı gövde = aynı talep; farklı gövde = `409` | [ARCHITECTURE §9](ARCHITECTURE.md), ADR-005; `packages/domain` (`idempotency.ts`, `fingerprint.ts`) | Test edildi (domain testleri, yerel e2e betiği: replay ve 409). Canlıda API düzeyinde Postman ile görüldü, tek koşu; web arayüzü anahtarı göstermez |
| Lease ve fencing | Sonucu yalnızca geçerli kira sahibi yazar | ARCHITECTURE §6 (S2-S4), §7 (I4); `packages/domain` (`delivery.ts`, `lifecycle.ts`), `apps/worker` | Kira alma canlı görüldü (talep `PROCESSING_STARTED` ile işlendi, n=1). Devralma ve fencing yalnızca test edildi (T5, T8, T10) |
| Retry budget | En fazla 5 işleme denemesi, sonra `FAILED` | ARCHITECTURE §6 (S5-S8), I5; `packages/domain` | Test edildi (T7, T13). Canlıda yalnızca "deneme 1/5" görüldü |
| Reconciler | Kaybolmuş / takılmış işi bulur ve yeniden gönderir | ARCHITECTURE §6, ADR-017; `packages/domain` (`reconcile.ts`), `packages/core/src/reconciler` | Zamanlayıcı tick'leri canlı görüldü (15 saatlik tick teslim edildi). Kayıp işin kurtarılması test edildi (T1, T11, T12), canlıda gösterilmedi |
| Kota ve hız sınırları | Kullanıcı / kiracı başına sınır; Redis yoksa kota kapalı-başarısız | [ARCHITECTURE §10, §12](ARCHITECTURE.md), ADR-009, ADR-018; `packages/core` (`quota`, `ratelimit`) | Gerçek Redis testleri CI'da; canlıda yalnızca tamamlanan bir talepten çıkarım (yük testi yok, `429` canlıda görülmedi) |
| Kabul kontrolü (admission) | Yazma hızına üst sınır, aşırı yükte `503` | [ARCHITECTURE §10](ARCHITECTURE.md), ADR-012; `packages/core/src/admission.ts` | Yalnızca yerel emülatörde denendi (tek koşu, dizüstü); canlıda denenmedi |
| Kiracı yalıtımı ve üyelik | Kiracı ve rol Firestore'dan gelir, token claim'inden değil | [ARCHITECTURE §11](ARCHITECTURE.md), ADR-008; `packages/core/src/membership.ts` | Üyelik akışı canlı görüldü (katılım kapalıydı, yönetici betikle verildi); yalıtım yerel e2e betiğinde test edildi |
| Tekrar teslimat bastırma | İşlenmiş talebe ikinci teslimat işlem yapmadan `200` döner | [ARCHITECTURE §6](ARCHITECTURE.md) (`decideDelivery`); `packages/domain/src/delivery.ts` | Test edildi (T6, yerel e2e betiği). Canlıda denenmedi |
| Exactly-once | (İddia edilmiyor) | ARCHITECTURE §7 "Non-claims" | Yok: bilinçli olarak iddia edilmez |
| Webhook teslimatı, kaos / hata enjeksiyonu, herkese açık vitrin | Dış yan etkili iş ve hata gösterimi | [ADR-020](DECISIONS.md), [TASKS B10-B13](TASKS.md) | **Yalnızca tasarlandı**, hiçbiri uygulanmadı |
