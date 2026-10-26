# QueuePilot Postman rehberi

Bu koleksiyon QueuePilot API'sini ve worker kapısını koddan çıkarılan beklentilerle test eder. Test betikleri `QueuePilot.postman_collection.json` içindedir. Bir test kırmızı çıkarsa bu bir bulgudur: ya kod ya da beklenti yanlıştır.

**Gözlenen sonuçlar** (tek koşu, n=1, 2026-10-26, ücretsiz katmanlar): klasör 0 30/30, klasör 3 9/9, klasör 1 21/21, klasör 2 adım 2.4 dışında tamamı yeşil. 2.4'teki eski `errors[]` varsayımı artık konsolda "KNOWN GAP" uyarısıdır (`VALIDATION_FAILED` yanıtları `errors[]` doldurmuyor; bkz. `docs/TASKS.md` "Postman API checks"). Ortam için `QueuePilot-live.postman_environment.template.json` şablonunu kullan, gerçek URL ve token'ı repoya koyma.

## 1. İçe aktarma (bir kez)

1. Postman ➜ **Import** ➜ iki dosyayı da seç: `QueuePilot.postman_collection.json` ve `QueuePilot-live.postman_environment.template.json` (kopyala, `<...>` alanlarını doldur).
2. Sağ üstte ortam olarak **QueuePilot live (free tier)** seç.
3. **Settings ➜ General ➜ Request timeout in ms = 90000.** Uyuyan Render servisi ilk istekte 30-60 saniye yanıt verebilir.
4. **View ➜ Show Postman Console** (Ctrl+Alt+C) penceresini aç. Hata ayıklama çıktısı orada.

## 2. Token olmadan çalışan testler (önce bunlar)

`0. Public, error format, CORS` ve `3. Worker gate` klasörlerini çalıştır (klasöre sağ tık ➜ Run). Token gerekmez. İlk istek soğuk başlangıç yüzünden yavaş olabilir.

## 3. Token alma (klasör 1 ve 2 için)

Kayıt kapalı olduğu için yalnızca senin hesabın çalışır. Token'ı tarayıcıdan **kendi makinende** al:

1. Tarayıcıda uygulamayı aç ve giriş yap.
2. `F12` ➜ **Network** ➜ sayfayı yenile ➜ adresi `/api/v1/...` ile biten bir isteğe tıkla.
3. **Headers ➜ Request Headers ➜ `authorization: Bearer eyJ...`** satırında `Bearer ` kelimesinden **sonraki** uzun metni kopyala.
4. Postman ortamında `idToken` değişkeninin **Current value** alanına yapıştır, kaydet.

Kurallar: token yaklaşık **1 saat** geçerlidir, süresi dolunca 401 alırsın ve 3. adımı tekrarlarsın. Token'ı **sohbete yapıştırma, dosyaya ya da repoya koyma**. Ortam dosyasında `secret` türünde ve boştur.

## 4. Çalıştırma sırası

- Klasör 1 serbest. Her istek hesabın kimliğini ve üyeliğini doğrular.
- **Klasör 2, 2.1 adımı günlük 30 gönderim hakkından 1 tanesini harcar.** Klasörü baştan sona 1-2 kez çalıştır, döngüye sokma.
- 2.6 numaralı istek durumu `COMPLETED` olana kadar kendini yaklaşık 3 sn arayla tekrar eder, en fazla 150 sn boyunca (soğuk worker 25-35 sn sürer). Yoklama süreye dayalıdır (3 sn aralık, en fazla 150 sn): ilk sürüm yoklama sayısına dayalıydı ve soğuk worker uyanmadan bitti. Bekleme betiğin içindedir, Runner'da ayrıca Delay gerekmez. Tek tek **Send** ile çalıştırırsan 2.6'yı elle tekrar gönder.
- Uyuyan worker: 2.1'den hemen sonra 2.6'yı çalıştırırsan konsolda "accepted -> processing started: ~25-35 s" satırını görürsün. Her `poll N (X s)` satırı, ilk yoklamadan beri geçen süreyi gösterir.

## 5. Hata ayıklama ipuçları

| İstediğin | Nereye bak |
|---|---|
| Her isteğin kodu, süresi ve izleme kimliği | Postman Console: `[istek adı] POST -> 202 in 312 ms, correlation=...` |
| Sunucunun döndürdüğü hata ayrıntısı | Konsolda `problem: code=... errors=[...]` satırı, ya da Body sekmesi (`application/problem+json`) |
| Yavaşlık | Konsolda `slow answer: probably a Render cold start` uyarısı |
| Bir isteğin sunucu tarafı izi | Yanıttaki `x-correlation-id` değerini kopyala. Render ➜ `queuepilot-api` ➜ **Logs** arama kutusuna yapıştır |
| İsteğin Firestore'daki yaşamı | 2.6'nın konsol çıktısı: `status`, `attempts`, `events` zinciri (`ACCEPTED@api > PROCESSING_STARTED@worker > COMPLETED@worker`) |
| Bir testin neden kırıldığı | İsteğin **Test Results** sekmesi ve **Tests** betiği (beklentiler orada, kodla karşılaştır) |

Yerel ortamda adım adım kod hata ayıklaması (breakpoint) yapmak istersen `docs/verification/README.md` yerel kurulumu anlatır. API'yi `node --inspect` ile başlatıp VS Code'dan bağlanırsın. Bu canlı sistemde yapılmaz.

## 6. Beklenen sonuçlar ve neyi kanıtlıyor

| Klasör / istek | Beklenen | Neyi gösterir |
|---|---|---|
| 0: `/health`, `/ready` | 200, `{"status":"ok"}` | Servis ve Firestore bağlantısı |
| 0: tokensız `/me` | 401, `UNAUTHENTICATED`, `problem+json` | Kimlik doğrulama her korumalı uçta zorunlu |
| 0: bilinmeyen yol, tokensız | 401 ya da 404 (konsolda hangisi olduğu yazar) | Yolların dışarıdan sızıp sızmadığı |
| 0: preflight, Hosting origin'i | 204, aynı origin geri döner, credentials yok | CORS izin listesi |
| 0: preflight, yabancı origin | `Access-Control-Allow-Origin` yok | TASKS'taki "yabancı origin" canlı kontrolü |
| 1: `/me`, bootstrap | 200, üyelik var, `created:false` | Rol Firestore'dan gelir |
| 1: bootstrap `{role:admin}` | 400 `VALIDATION_FAILED` | Rolü istemci seçemez (ADR-008) |
| 2.1 | 202, `Location` başlığı | 202 = Firestore'a yazıldı, işlenmedi |
| 2.2 | 202 + `Idempotent-Replayed: true`, aynı `requestId` | Idempotency |
| 2.3 | 409 `IDEMPOTENCY_KEY_REUSED` | Aynı anahtar, farklı gövde |
| 2.4, 2.5 | 400 `VALIDATION_FAILED` | Başlık zorunlu, gövde katı (`tenantId` gönderilemez) |
| 2.6 | `COMPLETED`, triage sonucu, zaman çizelgesi | Uçtan uca zincir |
| 2.9, 2.10 | 404, 400 | Hata sözleşmesi |
| 3: worker | `/internal/*` imzasız 401, gövde sabit `{"code":"UNAUTHENTICATED"}` | Yalnızca QStash çağırabilir |

## 7. Bilmen gerekenler

- Worker'ın `/internal/tasks` ve `/internal/reconcile` uçlarını Postman'den **başarılı** çağıramazsın. İmzayı yalnızca QStash üretir, bu bilerek böyle. Bu testler sadece reddedildiğini kanıtlar.
- Yük testi yapma. Kayıt kapalı, günlük sınırlar düşük (kullanıcı başına 30 gönderim) ve ücretsiz kotalar paylaşımlı.
- Ortam dosyası repoda yalnızca şablon olarak durur (`*.template.json`, gerçek URL ve token yok). Kendi kopyanı repo dışında tut.
