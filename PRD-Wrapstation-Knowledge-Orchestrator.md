# PRD: Wrapstation Knowledge Orchestrator

**Versi:** 0.1 (Draft)
**Status:** Siap dibangun (build from scratch)
**Referensi arsitektur:** Proyek `ai-answer-test` (Multi-AI CLI Orchestrator) di `C:\codes\ai answer\ai-answer-test` — reuse pola engine/orchestrator/SSE dari situ, TAPI ini project baru & terpisah, bukan modifikasi project itu.

---

## 1. Latar Belakang & Tujuan

Wrapstation adalah PT yang menjual **PPF (Paint Protection Film)** untuk mobil. Wrapstation sedang membangun sebuah **ERP internal** yang akan berisi:
- Data penjualan (sales) internal
- Data iklan Meta Ads
- Data iklan Google Ads
- Data Google Analytics

ERP tersebut nantinya akan memakai sebuah model (**Qwen**, self-hosted/akses terpisah) yang membaca seluruh data internal di atas untuk membuat **prediksi penjualan** (akhir bulan ini & bulan depan).

Masalahnya: data internal ERP saja tidak cukup — prediksi penjualan mobil/PPF juga dipengaruhi oleh kondisi pasar otomotif eksternal (tren penjualan mobil nasional, event otomotif, kebijakan pemerintah, dll) yang TIDAK ada di data internal Wrapstation. Qwen butuh **"knowledge tambahan"** dari luar untuk melengkapi analisisnya.

**Proyek ini (Wrapstation Knowledge Orchestrator)** adalah sistem terpisah yang tugasnya HANYA:
1. Menjalankan diskusi/debat multi-AI soal kondisi pasar otomotif eksternal yang relevan dengan periode prediksi tertentu (bulan/tahun target).
2. Satu AI (juri) menyimpulkan hasil diskusi itu jadi satu paket "knowledge" terstruktur.
3. Knowledge itu disimpan & diekspos lewat API supaya nanti **dikonsumsi oleh sistem Qwen** (di luar scope proyek ini) sebagai salah satu input tambahan — BUKAN sebagai prediksi final itu sendiri.

### 1.1 Batasan paling penting (HARD CONSTRAINT — baca berkali-kali sebelum implementasi)

> **Seluruh AI di orchestrator ini (peserta debat + juri, baik di v1 yang 3 CLI maupun v2 kalau Perplexity ditambahkan) TIDAK PERNAH boleh mengakses, membaca, atau mengetahui data ERP Wrapstation (sales, Meta Ads, Google Ads, Google Analytics) dalam bentuk apa pun.**

Ini bukan sekadar "jangan dikasih akses" secara pasif — harus ditegakkan aktif di beberapa lapis:

- **Arsitektur:** proyek ini **TIDAK PERNAH** terhubung ke database/API ERP Wrapstation. Tidak ada koneksi DB, tidak ada file data internal, tidak ada MCP tool apa pun yang mengarah ke ERP di proyek ini. Titik.
- **Tooling CLI:** project `ai-answer-test` yang jadi referensi arsitektur ini **punya** MCP tool `wrapstation-db` yang terdaftar di `claude`/`codex`/`agy` secara **user/global scope** di mesin yang sama (lihat README project itu: `claude mcp add` dsb di scope user supaya kepakai lintas direktori). Ini artinya kalau tidak hati-hati, CLI yang sama di proyek BARU ini **bisa saja tetap "melihat" tool itu terdaftar** karena scope-nya global, walau project-nya beda folder.
  - **WAJIB**: saat memanggil `claude`, secara eksplisit JANGAN sertakan `mcp__wrapstation-db` di `--allowedTools`, DAN tambahkan `--disallowedTools mcp__wrapstation-db` sebagai lapis kedua, DAN pertimbangkan `--strict-mcp-config` kalau tersedia di versi CLI yang dipakai (reload server config) supaya betul-betul tidak ke-load.
  - **WAJIB**: saat memanggil `codex`/`agy`, jangan set konfigurasi apa pun yang mengarah ke MCP `wrapstation-db` di config/profile yang dipakai proyek ini (pakai config/profile terpisah dari project `ai-answer-test`, jangan reuse).
  - Ini harus ditulis eksplisit di konfigurasi engine (`config.json` project baru) dengan komentar/dokumentasi kenapa, supaya tidak hilang saat ada yang nambah fitur nanti.
- **Prompt-level:** system prompt ke tiap AI peserta & juri harus eksplisit bilang: "Kamu TIDAK punya dan TIDAK AKAN pernah diberi akses ke data internal perusahaan mana pun (penjualan, iklan, analytics, dll). Diskusimu HANYA soal kondisi pasar/industri otomotif publik secara umum. Kalau kamu merasa butuh data spesifik satu perusahaan, JANGAN menebak/berasumsi — cukup bilang itu di luar scope-mu."
- **Scope topik**: topik yang didiskusikan dibatasi ke hal-hal publik seperti:
  - Tren penjualan mobil nasional/regional (wholesale/retail), data GAIKINDO atau sumber resmi lain
  - Produksi mobil dari pabrikan (ramp-up/slow-down produksi, model baru rilis)
  - Event otomotif (pameran/motor show, peluncuran model, promo nasional pabrikan/dealer)
  - Kebijakan pemerintah yang mempengaruhi pasar otomotif (pajak kendaraan, insentif EV, dll)
  - Tren industri perawatan mobil/PPF/detailing secara umum (bukan data satu perusahaan tertentu)
  - Faktor makroekonomi yang relevan ke daya beli otomotif (suku bunga kredit, harga BBM, dll)
  - Musiman (misal libur panjang, akhir tahun, Lebaran, dll yang mempengaruhi pembelian mobil)

Kalau ragu, defaultnya: **lebih baik AI menolak/bilang "di luar scope" daripada mengarang/berasumsi soal data internal perusahaan tertentu.**

---

## 2. Siapa yang Terlibat (v1: 3 AI, semua lewat CLI yang sudah ada — tanpa biaya API tambahan)

> **Perubahan dari draft awal:** juri awalnya direncanakan Perplexity (Sonar API), tapi API Perplexity **tidak punya tier gratis** (wajib setup billing dulu). Supaya v1 bisa langsung jalan tanpa biaya tambahan, juri untuk v1 dipindah ke salah satu CLI yang sudah ada aksesnya. Perplexity tetap didokumentasikan sebagai opsi v2 (lihat 2.2) kalau nanti user sudah siap bayar.

### 2.1 Default v1

| Peran | Mesin | Cara akses |
|---|---|---|
| Peserta 1 | Gemini (Google Antigravity CLI, `agy`) | Subprocess CLI |
| Peserta 2 | GPT (OpenAI Codex CLI, `codex`) | Subprocess CLI |
| **Juri** | **Claude (Claude Code CLI, `claude`)** | Subprocess CLI |

Pola ini **persis sama** dengan default yang sudah terbukti jalan di project referensi (`defaultParticipantIds: ["gemini", "codex"]`, `defaultJudgeId: "claude"`) — dipilih supaya tidak ada CLI yang double-duty (ikut berdebat SEKALIGUS menjadi juri di sesi yang sama), jadi anonimisasi (3.2) tetap rapi: juri benar-benar AI yang berbeda dari kedua peserta.

Karena hanya 3 CLI yang tersedia (claude/codex/agy) dan tiap sesi butuh peran peserta+juri berbeda-beda, config harus tetap fleksibel seperti project referensi: user bisa menukar siapa jadi peserta vs juri lewat `config.json`/UI (bukan di-hardcode), bukan berarti wajib selalu kombinasi di atas.

### 2.2 Opsional v2 (nanti, kalau sudah siap bayar API): Perplexity sebagai juri ke-4

Kalau nanti user sudah bikin billing & API key Perplexity (Sonar API, `https://api.perplexity.ai/chat/completions`, model `sonar-pro`/`sonar-reasoning-pro`), Perplexity bisa ditambahkan sebagai **juri terpisah** supaya 3 CLI (Gemini/GPT/Claude) semua jadi peserta aktif berdebat dan juri benar-benar independen + punya web-search native untuk verifikasi klaim. Ini butuh engine bertipe HTTP (lihat bagian 3, arsitekturnya sudah disiapkan dari awal supaya tinggal "colok" nanti tanpa refactor). API key disimpan di `.env` (gitignored), **jangan pernah dikirim sebagai argumen CLI/command-line**, selalu lewat header HTTP (`Authorization: Bearer <API_KEY>`) dari kode.

---

## 3. Arsitektur Engine: CLI (v1) + HTTP (disiapkan, dipakai mulai v2)

Project referensi (`ai-answer-test/src/runner.js`) cuma punya satu bentuk engine: subprocess CLI (`command` + `args` + parse stdout). Untuk v1, project baru ini **hanya butuh bentuk CLI itu** (dipakai bertiga: claude/codex/agy, lihat 2.1) — TIDAK perlu implementasi HTTP dulu.

Tapi desain `runModel()`/`config.json` tetap disiapkan dari awal supaya mendukung DUA bentuk engine, supaya saat Perplexity ditambahkan di v2 (2.2) tidak perlu refactor orchestrator:

```js
// config.json - engine bertipe CLI (sama seperti referensi)
{
  "id": "codex",
  "type": "cli",
  "command": "codex",
  "baseArgs": ["exec", "--skip-git-repo-check", "--approve-for-me", "-c", "tools.web_search=true", "-o", "{OUTFILE}", "-"],
  "output": { "type": "last-message-file" }
}

// config.json - engine bertipe HTTP (baru, untuk Perplexity)
{
  "id": "perplexity",
  "type": "http",
  "url": "https://api.perplexity.ai/chat/completions",
  "method": "POST",
  "apiKeyEnv": "PERPLEXITY_API_KEY",
  "model": "sonar-pro",
  "output": { "type": "openai-chat-json", "textPath": "choices.0.message.content" }
}
```

`src/runner.js` di project baru ini sebaiknya tetap distrukturkan jadi dua eksekutor sejak awal (walau yang kedua baru dipakai di v2):
- `runCliModel(model, prompt, opts)` — **WAJIB untuk v1**, sebagian besar logicnya copy + adaptasi dari `ai-answer-test/src/runner.js`, termasuk semua fix yang sudah ditemukan di project referensi (baca bagian 3.1 di bawah, WAJIB, karena ini bug nyata yang kalau diulangi bakal bikin project baru ini punya masalah yang sama persis).
- `runHttpModel(model, prompt, opts)` — **boleh ditunda sampai v2** (saat Perplexity ditambahkan): panggil `fetch()` (Node 18+ punya native fetch) ke `model.url` dengan body sesuai `model.method`/skema API, timeout pakai `AbortController`, dan extract teks jawaban dari response JSON sesuai `output.textPath`. Boleh dibuat sebagai stub/TODO di v1 asal `runModel()` sudah dispatch ke `model.type` (lihat di bawah), supaya v2 tinggal isi fungsinya tanpa ubah orchestrator.

`runModel(model, prompt, opts)` di level atas tinggal dispatch berdasarkan `model.type` (`"cli"` atau `"http"`) ke salah satu dari dua fungsi di atas. Dengan begini, orchestrator logic (rounds, judge, dsb) tidak perlu tahu/peduli apakah suatu peserta itu CLI atau HTTP.

### 3.1 Bug-bug yang SUDAH ditemukan & diperbaiki di project referensi — WAJIB diterapkan juga di sini

Project referensi (`ai-answer-test`) sempat mengalami beberapa bug nyata di Windows yang makan waktu panjang untuk di-debug. Supaya tidak mengulang kerja yang sama, terapkan langsung fix-fix berikut di `runCliModel` project baru ini sejak awal:

1. **`spawn()` tanpa shell gagal ENOENT di Windows untuk CLI npm (`claude`, `codex`)** karena mereka sebenarnya shim `.cmd`/`.ps1`, bukan `.exe` asli. **Fix**: coba `spawn(command, args, { shell: false })` dulu; kalau hasilnya error `ENOENT` DAN `process.platform === "win32"`, retry dengan `shell: true`. Jangan langsung pasang `shell: true` terus-terusan (itu yang menyebabkan bug #2 di bawah).
2. **`shell: true` membuat `cmd.exe` jadi perantara, dan `cmd.exe` TIDAK BISA menerima argumen yang mengandung newline** (prompt diskusi yang multi-baris akan hancur jadi argumen-argumen palsu). **Fix**: begitu suatu CLI butuh `shell: true` (hasil retry di atas), jangan kirim prompt lewat argumen — kirim lewat **stdin** (`child.stdin.write(prompt); child.stdin.end();`). CLI yang perlu `shell:true` di referensi (claude, codex) semuanya terbukti mendukung baca prompt dari stdin kalau argumen `{PROMPT}` dihilangkan dari template (claude: otomatis baca stdin kalau tidak ada positional prompt; codex: pakai `-` sebagai positional prompt untuk bilang "baca dari stdin").
3. **`detached: true` + `shell: true` bersamaan di Windows diam-diam membuat stdout anak proses hilang total** (child.stdout tidak pernah menerima data). **Fix**: `detached` harus `!shell` (hanya detach proses kalau TIDAK pakai shell).
4. **Membunuh proses macet/timeout**: di Windows, `process.kill(-pid)` (kill process group ala POSIX) **tidak bekerja sama sekali** — tidak ada process group POSIX di Windows. **Fix**: di Windows pakai `taskkill /PID <pid> /T /F` (kill whole tree by PID), bukan `process.kill(-pid)`. Di POSIX tetap pakai `process.kill(-pid, "SIGKILL")` seperti biasa (butuh `detached:true` di sana).
5. **Jendela `cmd.exe` kosong muncul-hilang berkedip** tiap kali `shell:true` dipakai & proses parent (misal dijalankan dari GUI/launcher, bukan dari terminal) tidak punya console sendiri. **Fix**: selalu set `windowsHide: true` di opsi `spawn()` (aman di-set selalu, tidak berefek di platform lain).
6. **Tidak semua CLI mendukung baca prompt dari stdin** (contoh: `agy`/Antigravity CLI — sudah diverifikasi lewat testing bahwa dia TIDAK baca stdin untuk prompt, argumen `-p` SELALU butuh isi literal). Untuk CLI semacam ini: JANGAN paksa lewat stdin, substitusikan prompt langsung ke argumen `{PROMPT}` seperti biasa — dan karena CLI ini (`agy`) kebetulan native `.exe` (bukan shim), dia tidak butuh `shell:true` sama sekali (attempt pertama tanpa shell akan langsung berhasil, lihat poin 1), jadi masalah newline di poin 2 otomatis tidak terjadi untuknya.
7. Tulis `child.stdin.on("error", () => {})` sebelum `.end()` — CLI yang tidak membaca stdin bisa menutup pipe-nya duluan, dan tanpa guard ini Node bisa crash dengan EPIPE tak tertangani.

> Ringkasnya: **coba shell:false dulu → retry shell:true+stdin kalau ENOENT → detached selalu `!shell` → windowsHide selalu true → kill pakai taskkill di Windows.** Ini satu paket solusi yang sudah terbukti jalan di project referensi untuk kombinasi `claude`+`codex`+`agy` persis — dan ini tiga-tiganya yang dipakai di v1 (lihat 2.1), jadi semua fix di atas WAJIB ada sejak awal. Perplexity (HTTP, v2) tidak kena masalah ini sama sekali karena bukan subprocess.

### 3.2 Anonimisasi peserta ke juri (fitur yang juga di-reuse dari referensi)

Project referensi baru saja menambahkan fitur ini dan terbukti jalan baik — terapkan juga di sini:
- Tiap sesi, peserta debat diberi label acak ("Peserta A/B/...") yang berbeda tiap sesi, dipakai di seluruh riwayat diskusi yang dibaca sesama peserta MAUPUN juri.
- Instruksikan tiap peserta eksplisit: jangan sebut nama model sendiri (GPT/Claude/Gemini), jawab pakai sudut pandang "menurut saya".
- Juri hanya melihat label anonim, menilai murni dari isi argumen.
- Setelah juri selesai, label anonim di-translate balik ke nama asli SEBELUM disimpan ke knowledge bundle (lihat bagian 5) — supaya audit trail tetap jelas siapa bilang apa, meski proses penilaiannya sendiri netral.

---

## 4. Alur Kerja Fungsional

### 4.1 Pemicu diskusi: berbasis TANGGAL, bukan topik bebas

Beda dari project referensi (yang user ketik topik bebas), di sini triggernya:
1. User (untuk testing) memilih **tanggal target prediksi** lewat date picker (hari/bulan/tahun) — merepresentasikan "prediksi untuk periode sekitar tanggal ini" (akhir bulan berjalan & bulan depan dari tanggal itu).
2. User klik tombol **"Generate"**.
3. Sistem otomatis membangun topik diskusi dari tanggal itu, contoh template:
   > "Analisis kondisi pasar otomotif Indonesia (penjualan mobil, produksi, event industri, kebijakan terkait) yang relevan untuk memprediksi penjualan di sekitar akhir bulan {bulanBerjalan} {tahun} dan bulan {bulanDepan} {tahun}. Fokus ke informasi publik/eksternal, BUKAN data internal perusahaan mana pun."
4. 3 peserta berdiskusi beberapa ronde (reuse mekanisme ronde/agreement-loop-stop dari referensi), lalu Perplexity menyimpulkan.
5. Hasil disimpan sebagai **knowledge bundle** (lihat bagian 5) dan tersedia lewat API untuk Qwen.

### 4.2 UI Testing (minimal, bukan prioritas visual)

Berbeda dari project referensi yang punya UI kaya (pixel-art office, dsb) — untuk v1 project ini **UI cukup fungsional saja**, prioritasnya kemudahan testing:
- Input tanggal (native `<input type="date">` sudah cukup).
- Tombol "Generate".
- Area live progress (reuse pola SSE dari referensi: `round-start`, `participant-start`, `participant-done`, `judge-start`, `judge-done`) — tampilkan log teks sederhana per event, tidak perlu animasi/karakter.
- Setelah selesai: tampilkan knowledge bundle hasil akhir (JSON terstruktur, ditampilkan rapi) + link/tombol lihat transkrip mentah.
- (Opsional, nice-to-have v1.5): riwayat generate sebelumnya (list knowledge bundle yang sudah pernah dibuat, bisa dilihat lagi).

---

## 5. Kontrak Output: Knowledge Bundle (untuk dikonsumsi Qwen)

### 5.1 Skema JSON

```jsonc
{
  "id": "uuid",
  "generatedAt": "2026-11-09T23:00:00.000Z",
  "targetPeriod": {
    "referenceDate": "2026-11-09",   // tanggal yang dipilih user
    "currentMonth": { "month": 11, "year": 2026 },
    "nextMonth": { "month": 12, "year": 2026 }
  },
  "scope": "external-automotive-market-only",  // penanda eksplisit ini BUKAN data internal
  "topics": [
    "tren penjualan mobil nasional", "event otomotif", "..."
  ],
  "summaryPerParticipant": [
    { "label": "GPT", "position": "..." },
    { "label": "Claude", "position": "..." },
    { "label": "Gemini", "position": "..." }
  ],
  "agreedPoints": ["..."],
  "disputedPoints": [ { "point": "...", "reason": "..." } ],
  "marketSignals": [
    // ekstraksi terstruktur tambahan khusus untuk dikonsumsi model lain,
    // bukan cuma teks naratif - ini bagian yang paling penting buat Qwen
    { "signal": "Penjualan wholesale nasional naik ~20% YoY per Oktober 2026", "direction": "positive", "relevance": "high", "source": "..." },
    { "signal": "Event GIIAS berikutnya jatuh di luar window prediksi", "direction": "neutral", "relevance": "low", "source": "..." }
  ],
  "recommendationForQwen": "Catatan kualitatif ringkas: faktor eksternal apa yang sebaiknya jadi pertimbangan tambahan saat Qwen membaca data ERP internal.",
  "sources": [ { "title": "...", "url": "..." } ],
  "confidence": "medium",  // subjektif dari juri: seberapa yakin/lengkap info yang didapat
  "raw": {
    "rounds": [ /* transkrip lengkap per ronde, label SUDAH di-deanonim */ ],
    "judgeRawResponse": "..."
  }
}
```

`marketSignals` adalah bagian paling penting secara fungsional — ini representasi "sinyal" yang bisa langsung dipakai programatik oleh Qwen (bukan cuma paragraf naratif yang perlu di-parse ulang). Minta juri (Perplexity) eksplisit menghasilkan field ini via structured output / JSON schema di prompt-nya.

### 5.2 Penyimpanan

- Simpan tiap knowledge bundle sebagai file JSON di `knowledge/<timestamp>-<referenceDate>.json` (mirip pola `transcripts/` di project referensi).
- Simpan juga `knowledge/latest.json` (symlink-like — selalu overwrite dengan hasil generate paling baru) supaya gampang diambil tanpa tahu nama file spesifik.
- (Opsional v1.5) kalau butuh query/riwayat lebih kaya, pertimbangkan SQLite daripada cuma file JSON.

### 5.3 API untuk dikonsumsi Qwen

```
POST /api/generate
  body: { "referenceDate": "2026-11-09" }
  → mulai sesi orchestrator baru (async), balas { "sessionId": "..." }
  → progress bisa dipantau lewat SSE: GET /api/sessions/:id/events (pola sama seperti referensi)

GET /api/knowledge/latest
  → balas knowledge bundle (skema 5.1) paling baru yang sudah selesai digenerate

GET /api/knowledge/:id
  → balas satu knowledge bundle spesifik by id

GET /api/knowledge?from=2026-11-01&to=2026-11-30
  → list knowledge bundle dalam rentang referenceDate tertentu
```

Autentikasi endpoint ini (minimal) — karena akan dipanggil sistem lain (Qwen), bukan cuma browser: tambahkan API key sederhana via header (`X-API-Key`), dicek di middleware, key disimpan di `.env`. Detail lebih lanjut (network boundary, apakah perlu reverse proxy, dsb) tergantung topologi deployment Wrapstation — kalau belum jelas saat implementasi, catat sebagai open question (lihat bagian 9), jangan menebak.

---

## 6. Non-Functional Requirements

- **Isolasi data**: lihat bagian 1.1 — ini requirement paling kritis di seluruh dokumen ini, prioritaskan di atas semua requirement lain.
- **Reliabilitas**: satu peserta gagal/timeout tidak boleh menggagalkan seluruh sesi — tetap lanjut dengan "no response" untuk peserta itu (pola sama seperti referensi).
- **Observability**: log progress ke terminal server (pola `logEvent` di referensi) — penting karena ini bakal dipanggil otomatis/terjadwal (lihat 4.1), bukan selalu diawasi manual lewat UI.
- **Idempotensi longgar**: generate untuk `referenceDate` yang sama boleh dipanggil ulang (hasil baru menimpa/menambah, tidak perlu dedup ketat di v1).
- **Portabilitas**: target utama Windows (lingkungan dev yang ada sekarang), tapi tulis kode platform-aware (lihat 3.1) supaya tetap jalan di Linux kalau nanti di-deploy ke server Linux.
- **Keamanan kredensial**: API key endpoint `/api/*` (dan `PERPLEXITY_API_KEY` kalau/saat v2 diaktifkan) di `.env`, gitignored, tidak pernah di-log ke console/transkrip.

## 7. Roadmap Bertahap

- **v1 (MVP, tanpa biaya API tambahan)**: 3 CLI yang sudah ada (claude/codex/agy) — 2 jadi peserta, 1 jadi juri (default: lihat 2.1), trigger by tanggal, UI testing minimal, knowledge bundle tersimpan ke file JSON, endpoint `/api/generate` + `/api/knowledge/latest`.
- **v1.5**: endpoint list/riwayat, auth API key.
- **v2 (opsional, butuh billing Perplexity)**: aktifkan `runHttpModel`, tambahkan Perplexity sebagai juri independen supaya ketiga CLI (Gemini/GPT/Claude) semua jadi peserta aktif; retry/backoff kalau Perplexity rate-limit; penjadwalan otomatis (cron, misal generate otomatis tiap awal bulan); riwayat dashboard; kemungkinan ganti file storage ke SQLite.

## 8. Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| Salah satu AI "bocor" mengasumsikan data internal Wrapstation karena nama perusahaan disebut di topik | Jangan sebut nama "Wrapstation" sama sekali di prompt ke 4 AI ini — cukup "analisis pasar otomotif publik", nama perusahaan tidak relevan buat mereka dan malah berisiko memancing asumsi yang salah |
| MCP `wrapstation-db` ke-load tanpa sengaja karena scope global di CLI yang sama | Lihat mitigasi eksplisit di bagian 1.1 — `--disallowedTools`, profile/config terpisah |
| Juri & salah satu peserta kebetulan AI yang sama di satu sesi (karena cuma 3 CLI tersedia) | Default v1 (2.1) selalu pakai 3 CLI berbeda untuk peserta vs juri dalam satu sesi — jangan jadwalkan AI yang sama dobel peran di config default |
| (v2) Perplexity API berubah skema/model deprecated | Isolasi pemanggilan API di satu modul (`runHttpModel`), gampang diupdate tanpa ubah orchestrator logic |
| (v2) Rate limit Perplexity/CLI lain saat dipanggil terjadwal otomatis | Retry dengan backoff, alert kalau gagal berturut-turut |
| Knowledge bundle terlalu naratif, Qwen susah ekstrak sinyal konkret | `marketSignals` terstruktur (lihat 5.1) sebagai requirement wajib, bukan opsional |

## 9. Open Questions (perlu dikonfirmasi ke user sebelum/selama implementasi, jangan ditebak)

1. ~~Perplexity API key~~ — **sudah diputuskan**: v1 TIDAK pakai Perplexity (butuh billing berbayar, tidak ada tier gratis). Judge v1 = Claude (lihat 2.1). Perplexity jadi opsi v2 kalau user sudah siap bikin billing-nya nanti.
2. Deployment akhir nanti: jalan di mesin yang sama dengan ERP Wrapstation, atau server terpisah yang dipanggil via network oleh sistem Qwen? (Mempengaruhi desain auth endpoint di 5.3.)
3. Apakah generate ini nantinya perlu dijadwalkan otomatis (cron, misal tiap tanggal 1), atau cukup manual-trigger terus untuk v1?
4. Format tanggal/timezone yang dipakai Wrapstation ERP — WIB saja atau perlu eksplisit timezone-aware?

---

## 10. Instruksi untuk Claude yang membangun ini

- Mulai dari `npm init`, struktur mirip `ai-answer-test` (server.js + src/ + client/ React+Vite kalau mau UI, atau cukup HTML+vanilla JS sederhana karena UI-nya memang minimal — pilih vanilla kalau ingin lebih cepat selesai, karena UI v1 ini bukan prioritas).
- **Copy pola, jangan copy-paste file mentah-mentah** dari `ai-answer-test` — banyak bagian (MCP wrapstation-db, UI pixel-art, dsb) memang tidak relevan/tidak boleh ikut ke project baru ini.
- Terapkan semua fix di bagian 3.1 sejak commit pertama — jangan "nanti aja diperbaiki kalau ketemu bug", karena bug-bug itu sudah pasti akan muncul lagi persis sama di Windows kalau tidak diantisipasi dari awal.
- Setelah selesai v1, jalankan end-to-end test manual: pilih satu tanggal, klik generate, pastikan knowledge bundle yang dihasilkan masuk akal DAN tidak ada satu pun bagian yang menyebut/mengasumsikan data internal Wrapstation.
- Kalau ada bagian requirement yang ambigu saat implementasi, cek dulu bagian 9 (Open Questions) — kalau memang belum terjawab di situ, TANYA ke user, jangan menebak sendiri terutama untuk hal yang menyentuh bagian 1.1 (isolasi data).
