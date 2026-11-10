# Wrapstation Knowledge Orchestrator

Spesifikasi lengkap ada di [`PRD-Wrapstation-Knowledge-Orchestrator.md`](./PRD-Wrapstation-Knowledge-Orchestrator.md) — baca itu dulu kalau mau paham konteks/alasan desain.

Ringkasnya: 3 AI CLI (Gemini via `agy`, GPT via `codex`, Claude via `claude`) berdiskusi soal kondisi pasar otomotif publik Indonesia untuk periode target tertentu — **tidak pernah** menyentuh data internal Wrapstation apa pun. Hasilnya disimpan sebagai "knowledge bundle" terstruktur untuk dikonsumsi sistem lain (Qwen).

## Setup

```bash
npm install
cp .env.example .env   # isi PORT/API_KEY kalau perlu, PERPLEXITY_API_KEY tidak dipakai di v1
npm start
```

Buka `http://localhost:4174`, pilih tanggal, klik **Generate**.

Pastikan `claude`, `codex`, `agy` sudah ter-install & ter-login di mesin ini (sama seperti project `ai-answer-test`).

## Default peran v1

- Peserta: **Gemini** (`agy`) + **GPT** (`codex`)
- Juri: **Claude** (`claude`)

Perplexity (Sonar API) sengaja TIDAK dipakai di v1 karena API-nya tidak punya tier gratis (wajib setup billing). Lihat PRD bagian 2.2 kalau nanti mau mengaktifkannya sebagai juri ke-4 — arsitekturnya (`type: "http"` engine, `runHttpModel` di `src/runner.js`) sudah disiapkan, tinggal tambah entry di `config.json`, contoh:

```jsonc
{
  "id": "perplexity",
  "type": "http",
  "engineLabel": "Perplexity · Sonar API",
  "url": "https://api.perplexity.ai/chat/completions",
  "method": "POST",
  "apiKeyEnv": "PERPLEXITY_API_KEY",
  "bodyBuilder": "openai-chat",
  "output": { "type": "json", "textPath": "choices.0.message.content" }
}
```

lalu tambahkan entri di `models` yang menunjuk `engineId: "perplexity"`, dan ubah `defaultJudgeId` (atau kirim `judgeId` di body `/api/generate`).

## API

- `POST /api/generate` — body `{ "referenceDate": "YYYY-MM-DD" }`, balas `{ "sessionId": "..." }`
- `GET /api/sessions/:id/stream` — SSE progress (events: `session-start`, `round-start`, `participant-start`, `participant-done`, `similarity`, `stopped-early`, `judge-start`, `judge-done`, `session-done`, `session-error`)
- `GET /api/sessions/:id` — snapshot status sesi
- `GET /api/knowledge/latest` — knowledge bundle terakhir
- `GET /api/knowledge/:id` — knowledge bundle spesifik
- `GET /api/knowledge?from=YYYY-MM-DD&to=YYYY-MM-DD` — list berdasarkan `referenceDate`

Kalau `API_KEY` diisi di `.env`, keempat endpoint `/api/knowledge*` dan `/api/generate` wajib header `X-API-Key` yang cocok.

## Isolasi data (WAJIB dibaca sebelum ubah apa pun di sini)

Lihat PRD bagian 1.1. Singkatnya: jangan pernah tambahkan koneksi DB/MCP yang mengarah ke data internal Wrapstation ke project ini, dan `config.json` punya `--disallowedTools mcp__wrapstation-db` eksplisit di engine `claude` sebagai lapis pengaman kedua (karena tool itu terdaftar global di CLI `claude` yang sama, dipakai juga oleh project `ai-answer-test`).
