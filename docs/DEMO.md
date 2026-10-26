# QueuePilot canlı sunum betiği (5-10 dakika)

Hedef kitle: teknik dinleyici (mühendisler, mülakatçılar). Dil: Türkçe. Süre: 5-10 dakika.
Bu betik, 2026-10-22/23'te çalıştırılan **geçici ücretsiz katman dağıtımını** (Render free, Firebase Spark, Upstash) gösterir. Dağıtım
geçicidir; ortam kapatıldıktan sonra bu betik geçersizdir ve yalnızca [Ek: yerel emülatör demosu](#ek-yerel-emülatör-demosu-yedek-plan) kalır.

Bu depo **özeldir** ve canlı sistem geçicidir; betikte gerçek URL, proje kimliği/numarası, uid, e-posta, IP veya gizli değer yoktur.
Yer tutucular: `<HOSTING_URL>` (Firebase Hosting adresi), `<API_URL>` ve `<WORKER_URL>` (Render servisleri). Gerçek değerleri sunum
makinesinde bir notta tutun, depoya yazmayın.

## Dürüstlük kuralı: ne gösterilir, ne gösterilmez

| Konu | Durum | Kaynak |
|---|---|---|
| Hosting'den Google ile giriş, CORS çağrısı, kabul → kuyruk → worker → Firestore'da `COMPLETED` | **Canlı görüldü, her biri bir koşu (n=1)** | [TASKS.md](TASKS.md) "B9-9 live results" madde 4, 5 |
| Worker'ın dahili uç noktasına imzasız çağrı `401` | Canlı görüldü (n=1) | B9-9 madde 5 |
| 15 ardışık saatlik scheduler tick'i teslim edildi | Canlı görüldü (n=1) | B9-9 madde 6 |
| Soğuk başlangıç: worker için ≈ 25-35 s, API için ≈ 25 s, ikisi de soğukken ≈ 1 dakika; işlem ≈ 1 s | Ölçüldü, n=1/2, yaklaşık | B9-9 madde 7, TASKS "Postman API checks" |
| Idempotent tekrar (`202` + `Idempotent-Replayed: true`) ve `409 IDEMPOTENCY_KEY_REUSED` | Canlıda API düzeyinde Postman ile görüldü, tek koşu (arayüz anahtarı göstermez) | TASKS "Postman API checks" |
| Lease, retry, reconciler | Var; **testlerle** ve yerel emülatör e2e ile kapsanıyor, **canlıda gösterilmedi** | Aşağıda (c) |
| Webhook teslimatı, kaos / hata enjeksiyonu, herkese açık vitrin | **Yapılmadı**, yalnızca planlı | [ADR-020](DECISIONS.md), TASKS B10-B13 |
| Exactly-once | **Hiç iddia edilmedi** | [ARCHITECTURE §7](ARCHITECTURE.md) "Non-claims" |
| Bulut ölçeklenebilirliği, production-hazırlık | **İddia edilmez** | README "Known limitations" |
| Google Cloud yolu (Cloud Run, Cloud Tasks, C1-C9) | **Çalıştırılmadı** | ARCHITECTURE §8, TASKS |

---

## (a) Sunumdan önce (T-15 dk)

Ücretsiz servisler 15 dakika trafiksiz kalınca uyur ([ADR-019](DECISIONS.md), yayımlanmış Render davranışı; spike'ta tek ölçüm). Bu yüzden
ısınma iki kez yapılır: T-15 ve T-3.

**T-15 dk:**

1. `<HOSTING_URL>` adresini açın. Arayüz "The service is waking up, this can take up to a minute." bildirimini gösterebilir; panel
   hazır olana kadar bekleyin (API için yaklaşık 25 s, n=1/2, yaklaşık).
2. **Sahip hesabıyla** Google ile giriş yapın. Kayıt kapalıdır (`openSignup=false`): başka bir hesap "Sign-up is closed for this workspace"
   ile reddedilir. Yönetici rolünü bu hesaba sahip betikle vermiştir; üyelik Firestore'dadır.
3. Bir talep gönderin (New request). Bu, hem API'yi hem de QStash üzerinden worker'ı uyandırır.
4. Talebin `COMPLETED` olduğunu doğrulayın. Detay sayfasında **yenileme düğmesi yoktur**: sayfa durum bitene kadar 30 s'de bir kendini
   yeniler (`POLL_INTERVAL_MS = 30_000`); beklemek istemezseniz tarayıcıda F5.
5. Kota notu: bu hesabın günlük gönderim limiti vardır. Kurulum betiğinin varsayılanları dakikada 10, kullanıcı başına günde 30, kiracı
   başına günde 300'dür (`scripts/seed-demo.mjs`, ADR-019); canlı belge bu hazırlık için yeniden okunmadı. **Prova ve ısınma
   gönderimleri de bu sayıya girer**, bu yüzden toplam gönderimi kısa tutun (aşağıdaki akış 2-3 talep kullanır).

**T-3 dk:** yalnızca **güvenli modda** worker'ı tekrar uyandırın: yeni bir talep gönderin, `COMPLETED` olmasını bekleyin. **Dramatik modda
bunu yapmayın** (aşağıya bakın).

**Önceden alınacak ekran görüntüleri (yedek plan; depoya koymayın, hesap/proje kimlikleri içerebilir):**

- Panel (talep listesi).
- Talep detayı: özet (deneme `1 / 5`, mükerrer teslimat `0`) ve zaman çizelgesi.
- Upstash konsolunda QStash günlüğü: saatlik tick'ler (bu çalıştırmada 15 ardışık tick, hepsi ilk denemede teslim edildi, her biri 24-29 s sürdü).
  Göstermeden önce URL ve kimlik alanlarını kırpın veya bulanıklaştırın.

---

## (b) Akış ve dakika işaretleri

Toplam yaklaşık 9 dakika. 5 dakikaya indirmek için: 5:45-6:30 (metrikler) ve 6:30-7:30 (idempotency) bölümlerini tek cümleye indirin.

| Dakika | Bölüm | Ne yapılır / ne söylenir |
|---|---|---|
| 0:00-0:45 | **Problem** | Ani yük dalgası: isteği hızlı kabul et, kabul edileni kaybetme, tekrarı zararsız kıl, bir kiracının payını koru. Tek cümle: "QueuePilot, kalıcı istek kabulü ve asenkron işleme için bir referans uygulama; at-least-once teslimat, uygulama düzeyinde korumalarla." Kargo benzetmesi: makbuz = `202`, teslimat sonra, gelmeyen kurye yerine yenisi, aynı koliyi iki kez kaydetmek tek koli. |
| 0:45-1:45 | **Giriş ve üyelik** | Google ile giriş (kayıt kapalı, sahip hesabı). Kiracı ve rol **Firestore'daki `memberships/{uid}` kaydından** gelir, token claim'inden değil ([ARCHITECTURE §11](ARCHITECTURE.md), ADR-008). Rol kullanıcı girdisi olamaz; yönetici yalnızca sahip betiğiyle verilir. Liste varsayılan olarak "My requests"tir; yönetici rolü olan hesapta ayrıca "All tenant requests" düğmesi görünür (üyeler yalnızca kendi taleplerini, yöneticiler tüm kiracıyı görür). |
| 1:45-3:00 | **Talep gönder** | New request: türü ve önceliği doldurup gönderin. Arayüz "Request accepted. It is stored and will be processed; it has not been processed yet." der. Söylenecek: `202` = **kaydedildi (commit), işlendi demek değil** (I1). Kabul tek atomik Firestore yazımıdır (idempotency kaydı + talep + ilk olay); ondan sonra kuyruğa uyandırma görevi atılır. |
| 3:00-5:45 | **Durumu izle, zaman çizelgesi, soğuk başlangıç** | "View request". Listede ilk durum "Queued" görünür (`ACCEPTED`, deneme 0; arayüzde türetilmiş görünüm), zaman çizelgesindeki olay "Accepted"dır. Ardından **Processing started** (aktör: Worker) ve **Completed**. Özet: deneme `1 / 5`, mükerrer teslimat `0` (n=1'de görülen değerler). Aşağıdaki soğuk başlangıç anlatısını buraya yerleştirin. Sayfa 30 s'de bir yenilenir; F5 ile hızlandırın. |
| 5:45-6:30 | **Metrikler** | Metrics sekmesi: saklanan durumlara göre sayılar (Accepted, Processing, Completed, Failed) ve "Stuck" (15 dakikadan fazla gecikmiş, terminal olmayan talepler). Üretim zamanı ve kaynak (`redis`, `memory` veya `firestore`) altta yazar; sunucuda birkaç saniye önbelleğe alınır. |
| 6:30-7:30 | **Idempotent tekrar** | Aşağıdaki kurala bakın: web arayüzü anahtarı **göstermez**, bu yüzden sözlü anlatılır. |
| 7:30-8:30 | **Hata yönetimi** | Bölüm (c): lease devralma ve reconciler **testlerle** kapsanıyor, canlı gösterilmiyor. |
| 8:30-9:15 | **Sınırlar slaytı ve sonraki adım** | Aşağıdaki sınırlar metnini yüksek sesle okuyun; ADR-020'yi "planlı" diye anın. |

### Soğuk başlangıç anı: tasarımın bir özelliği olarak

Anlatı: "Kuyruk yalnızca bir **uyandırma (wake-up)** sinyalidir; doğruluk kaynağı Firestore'dur (ADR-017). Zaman çizelgesindeki boşluk, uyuyan worker'ın
uyanmasıdır. Talep o sırada zaten güvendeydi: `202` aldığımızda kayıt Firestore'daydı." Bu, ücretsiz katmanın bir yan etkisidir ve tasarımın
neden kuyruğa doğruluk görevi yüklemediğini gösterir.

- **Dramatik mod (uyuyan worker):** T-3 ısınmasını yapmayın. Son gönderimden bu yana en az 15 dakika geçmiş olmalı. Worker saatlik
  scheduler tick'iyle de uyanır (bu çalıştırmada tick'ler saat başında görüldü); bu yüzden saat başından sonraki ilk 15 dakikada sunum yapmayın,
  worker uyanık olabilir (çıkarım). Beklenti: *Accepted* ile *Processing started* arası **yaklaşık 25-35 s** (n=1/2, yaklaşık). Çıplak uyuyan servis
  yanıtı daha önceki spike'ta 8-14 s ölçüldü; Render belgeleri 50 s'ye kadar diyor (ADR-019), bu yüzden süreyi garanti etmeyin.
- **Güvenli mod (ısınmış worker):** T-3 ısınmasını yapın. Aralık birkaç saniyeye iner; soğuk başlangıç anlatısını sözlü yapın ve
  ekran görüntüsünü (dramatik modda alınmış zaman çizelgesi) gösterin.

### Idempotent tekrar: web arayüzü ne yapıyor?

`apps/web` incelendi: `Idempotency-Key` **kullanıcıya gösterilen veya girilen bir alan değildir**. Anahtar `createKeyManager` ile otomatik üretilir
(`apps/web/src/lib/idempotency.ts`); yük (payload) değişmediği sürece aynı anahtar yeniden kullanılır, yani ağ hatasından sonraki "tekrar dene"
aynı anahtarı gönderir ve arayüz metni bunu söyler ("Retrying keeps the same idempotency key, so the request cannot be created twice."). Başarılı gönderimden sonra
anahtar sıfırlanır. **Bu nedenle sunumda canlı bir "aynı anahtarla ikinci gönderim" gösterilemez; sözlü anlatın ve testlere işaret edin:**

- Aynı anahtar + aynı gövde: `202`, aynı `requestId`, `Idempotent-Replayed: true`; aynı anahtar + farklı gövde: `409 IDEMPOTENCY_KEY_REUSED` ([ARCHITECTURE §9](ARCHITECTURE.md)).
- Kanıt: domain testleri (`packages/domain/test`), anahtar yöneticisi testi (`apps/web/src/lib/idempotency.test.ts`) ve yerel e2e betiği (`docs/verification/e2e-local.mjs`: replay ve `409` kontrolleri). Canlıda API düzeyinde Postman ile görüldü, tek koşu; arayüz anahtarı göstermez.

### Sınırlar slaytı (yüksek sesle söyleyin)

Google Cloud'a dağıtım yok; Google Cloud kontrolleri (C1-C9) çalıştırılmadı. Gösterilen, 2026-10-22/23'te bir kez çalıştırılan geçici bir ücretsiz
katman dağıtımıdır (Render free, Firebase Spark, Upstash); rakamlar birer koşudur (n=1). Exactly-once iddia edilmez. Bulut ölçeklenebilirliği
ve production-hazırlık iddia edilmez; harici güvenlik denetimi yoktur. Webhook teslimatı, kaos / hata enjeksiyonu ve herkese açık vitrin yapılmadı,
yalnızca planlıdır (ADR-020). Yük rakamları yerel, dizüstü bilgisayar + emülatör, üretim kıyaslaması değildir.

---

## (c) Hata yönetimi hakkında ne söylenir

Söylenecek ve **söylenmeyecek** olanlar:

- **Söylenir:** Worker bir işi aldıktan sonra çökerse, 60 s'lik lease dolunca bir sonraki teslimat işi devralır (`LEASE_TAKEOVER`); eski worker geç gelip sonucu yazmaya çalışırsa
  lease eşleşmediği için reddedilir (I4, fencing). Kaybolan uyandırma görevini reconciler yeniden gönderir; deneme bütçesi (5) bitince talep `FAILED` olur ve
  nedeni görünür kalır (I5). Dağıtım sorunu bir talebi asla `FAILED` yapmaz (ADR-017).
- **Kanıt:** domain ve worker testleri (T1-T13: ör. T5 çökme sonrası devralma, T8 eşzamanlı iki teslimat, T10 lease kaybı, T11 iki eşzamanlı reconciler, T12 reconciler kapalı),
  yarış ve fuzz testleri ([TASKS.md](TASKS.md) B4) ve yerel emülatör e2e betiği (replay, çakışma, mükerrer teslimat).
- **Söylenmez / vaat edilmez:** lease devralma ve reconciler **canlıda gösterilmedi**. **Canlı çökme demosu vaat etmeyin.** Canlı sistemde bunu zorlayacak hata enjeksiyonu yoktur
  (kaos aracı yalnızca planlıdır, ADR-020). Canlıda yalnızca reconciler uç noktasına tick'lerin teslim edildiği görüldü, kayıp bir işin kurtarıldığı görülmedi.
- Kurtarma süresi hakkında soru gelirse: ücretsiz profilde reconciler saatte bir tick'ler (tasarımda dakikada bir); ADR-020 karar 5'in koddan çıkardığı tahmin, kuyruk yeniden
  denemesi kaldığı sürece yaklaşık 1-2 dakika, yeniden denemeler bitince bir saate kadardır. **Bu, ölçülmemiş bir hesaptır.**

---

## (d) Bir şey yavaşsa veya bozuksa

1. **Bekleme kuralı: 60 s.** Soğuk başlangıç beklenen bir durumdur (arayüz bildirimi 1 dakikaya kadar der). 60 s boyunca sakin kalın, anlatıyı sürdürün
   ("kuyruk yalnızca uyandırma, talep güvende").
2. 60 s sonra **ekran görüntülerine** geçin (panel, talep detayı + zaman çizelgesi, QStash tick günlüğü) ve nedenini dürüstçe söyleyin: ücretsiz servis veya ağ.
3. Hâlâ gerekiyorsa **yerel yedek plana** geçin: Ek bölümü.
4. Talep `FAILED` veya takılı kalırsa, bunu saklamayın: bu da ürünün göstermek istediği şeydir (durum ve neden görünür); ama canlı teşhis yapmayın, ekran görüntüsüne dönün.
5. Giriş penceresi açılmazsa: tarayıcıda açılır pencere engelini kontrol edin; çalışmazsa ekran görüntülerine geçin.

---

## (e) Muhtemel sorular ve dürüst kısa cevaplar

- **Exactly-once mı?** Hayır. At-least-once teslimat, uygulama düzeyinde korumalarla (idempotency, lease, deneme bütçesi, mutlak terminal durumlar). Aynı iş birden fazla kez teslim
  edilebilir ve zararsız hale getirilir; exactly-once hiçbir yerde iddia edilmez ([ARCHITECTURE §7](ARCHITECTURE.md), ADR-017 sonuçları).
- **Neden kuyruğa güvenmiyorsunuz?** Bir görevin varlığı veya yokluğu kuyruğun dışından kanıtlanamaz. Bu yüzden görev yalnızca uyandırmadır; çalışıp çalışmayacağına yalnızca Firestore karar verir
  (lease, deneme bütçesi, terminal durum). Fazla görev 409/200 yanıtına mal olur, yanlış duruma değil ([ADR-017](DECISIONS.md)).
- **Worker ölürse?** Lease süresi dolar, sonraki teslimat devralır; teslimat da kaybolduysa reconciler yeniden gönderir. Bu **testlerle** kapsanır (T5, T10, T12), canlıda gösterilmedi.
- **Ölçeklenir mi?** İddia etmiyoruz. Ücretsiz katman sınırları ve kotalar bunu bilerek sınırlar: sandbox kiracısı için günde 300 talep (ADR-019; kullanıcı başına günde 30 kurulum betiği varsayılanıdır),
  günlük 1.000 QStash mesajı, Spark'ta günlük 50K okuma / 20K yazma (bunlar yayımlanmış platform sınırlarıdır, ölçülmedi; ADR-019). Yerel rakamlar bir dizüstü bilgisayardaki emülatör sonuçlarıdır, bulutta hiçbir yük ölçülmedi.
- **Güvenlik?** Üyelik ve rol Firestore'da (ADR-008); CORS izin listesi (canlıda Hosting origin'inden çağrı çalıştı; yabancı origin'den istek ayrıca doğrulanmadı); worker'da QStash imza doğrulaması
  (imzasız çağrı `401`; gerçek anahtarlarla başarılı iş çıkarımla doğrulandı, JWT alanları incelenmedi); Redis yokken kotalar kapalı-başarısız (`503 QUOTA_UNAVAILABLE`, ADR-009). Harici denetim yoktur.
- **Neden Render / ücretsiz katman?** Sahibin faturalandırma hesabı / kartı yok; Google Cloud yolu (Cloud Run, Cloud Tasks, Cloud Scheduler) faturalandırma gerektirir ([ADR-019](DECISIONS.md)).
  Cloud Tasks adaptörü yapılandırmayla seçilebilir kalır ama canlıda doğrulanmadı.
- **Sırada ne var?** ADR-020'de **planlı** iş: yerleşik alıcıya webhook teslimatı, zaman çizelgesi zenginleştirme, yönetici-yalnız kaos denemesi ve statik kayıtlı vitrin. **Hiçbiri başlamadı**;
  zaman çizelgesi zenginleştirme (B11) için önce Firestore okuma bütçesi işi (B9-5 kalanı) gerekir.
- **Üretime hazır mı?** Hayır. Tek bir geçici ücretsiz katman koşusu ve yerel testler vardır; README "Known limitations".
- **Neden panel yavaş güncelleniyor?** Panel 30 s'de bir sorgular (Spark okuma bütçesi, ADR-019).

---

## Ek: yerel emülatör demosu (yedek plan)

Canlı sistem kullanılamazsa yedek plan budur. **Bunu "yerel emülatör demosu" diye açıkça etiketleyin:** Firebase Auth *emülatörünün* Google sağlayıcısı, Firestore emülatörü, süreç içi
kuyruk modeli (saniyede 20 dağıtımla sınırlı); Google Cloud'da hiçbir şey çalışmaz.

**Hazırlık:** README "Local setup" ve [docs/verification/README.md](verification/README.md): derleme, emülatörler, worker, API; web uygulaması için `pnpm --filter @queuepilot/web dev`.
Betik tabanlı sürüm: `node docs/verification/e2e-local.mjs` (25 PASS/FAIL kontrolü; gerçek derlenmiş API + worker + emülatörler; Redis gerekmez) çıktısını anlatın.

**Doğrulanmış mı, prova edildi mi (dürüst durum):**

| Adım | Dayanak | Durum |
|---|---|---|
| Kabul → işle → tamamla, replay, `409`, mükerrer teslimat, kiracı/kullanıcı yalıtımı, Redis kapalıyken kapalı-başarısız kota | `docs/verification/e2e-local.mjs` (25 kontrol) | Betik depoda; 2026-10-20'de geçtiği bu dosyanın önceki sürümünde yazılıydı, ama depoda saklanmış bir çıktı kaydı yok. **Sunumdan önce yeniden çalıştırın.** |
| Kota, hız sınırı, kapalı-başarısız davranış, gerçek Redis | `tests/integration/redis*.test.ts`, `apps/api/test/integration/redis-quota.test.ts` | CI'da geçer (GitHub Actions sekmesine bakın) |
| Spike / toparlanma sayıları | `tests/load/results/2026-10-20T10-19-00-417Z/REPORT.md` | Yerel, 3 tekrar, emülatör; üretim kıyaslaması değil |
| React arayüzünde yerel API'ye karşı tıklama akışı | – | **Bakım ekibince prova edilmedi** (yerel emülatör karşısında); gösterilecekse önce deneme yapın |
| Canlı ücretsiz katman akışı (bu betiğin ana bölümü) | B9-9 sonuçları | Tek koşu (n=1); sunum öncesi yukarıdaki (a) provası şart |

Yerel akışta, canlıda gösterilemeyen şeyler de anlatılabilir: replay ve `409`; mükerrer teslimatın işlem yapmadan `200` dönmesi; Redis kapalıyken kapalı-başarısız kota
(`503 QUOTA_UNAVAILABLE`, replay çalışmaya devam eder). Yerel yük denemesi (taban, ani yük, toparlanma) bir dizüstü bilgisayarda emülatörlerle yapılmıştır; bunları bulut rakamı gibi sunmayın.
