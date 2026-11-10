import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { runModel } from "./runner.js";
import { roundSimilarity } from "./similarity.js";
import { saveKnowledgeBundle } from "./knowledge-store.js";

export const sessions = new Map();

const MONTH_NAMES_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

// Fixed, public-only scope - never company-specific. Reused both in the
// prompts sent to the AIs and in the knowledge bundle's `topics` field.
const SCOPE_TOPICS = [
  "tren penjualan mobil nasional/regional (wholesale/retail)",
  "produksi mobil dari pabrikan (ramp-up/slow-down, model baru rilis)",
  "event otomotif (pameran/motor show, peluncuran model, promo nasional pabrikan/dealer)",
  "kebijakan pemerintah yang mempengaruhi pasar otomotif (pajak kendaraan, insentif EV, dll)",
  "tren industri perawatan mobil/PPF/detailing secara umum",
  "faktor makroekonomi yang relevan ke daya beli otomotif (suku bunga kredit, harga BBM, dll)",
  "musiman (libur panjang, akhir tahun, Lebaran, dll yang mempengaruhi pembelian mobil)",
];

export function buildTargetPeriod(referenceDate) {
  const [y, m] = referenceDate.split("-").map(Number);
  let nextMonth = m + 1;
  let nextYear = y;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  return {
    referenceDate,
    currentMonth: { month: m, year: y },
    nextMonth: { month: nextMonth, year: nextYear },
  };
}

export function buildTopic(targetPeriod) {
  const cur = MONTH_NAMES_ID[targetPeriod.currentMonth.month - 1];
  const next = MONTH_NAMES_ID[targetPeriod.nextMonth.month - 1];
  return [
    `Analisis kondisi pasar otomotif Indonesia (tren penjualan mobil, produksi, event industri, kebijakan pemerintah terkait, faktor makroekonomi, dan musiman)`,
    `yang relevan untuk memperkirakan kondisi pasar di sekitar akhir ${cur} ${targetPeriod.currentMonth.year} dan ${next} ${targetPeriod.nextMonth.year}.`,
    `Fokus HANYA ke informasi publik/eksternal tentang industri otomotif secara umum.`,
  ].join(" ");
}

// Participants/judge only ever see each other as "Peserta A/B/C/..." - never by
// real model/engine name - so nobody (least of all the judge) can let a brand's
// reputation bias an argument or a score instead of judging the text itself.
const ANON_TAGS = ["Peserta A", "Peserta B", "Peserta C", "Peserta D", "Peserta E", "Peserta F"];

function buildAnonMap(participants) {
  const shuffled = [...participants].sort(() => Math.random() - 0.5);
  const map = new Map();
  shuffled.forEach((p, i) => map.set(p.id, ANON_TAGS[i] ?? `Peserta ${i + 1}`));
  return map;
}

function formatHistory(rounds, anonMap) {
  const lines = [];
  rounds.forEach((round, i) => {
    lines.push(`--- Ronde ${i + 1} ---`);
    for (const entry of round.entries) {
      lines.push(`[${anonMap.get(entry.id) ?? entry.label}]: ${entry.text}`);
    }
  });
  return lines.join("\n\n");
}

// This is the hard constraint from the PRD (section 1.1): these AIs must
// never access, assume, or pretend to know any internal company data. Never
// name "Wrapstation" anywhere in a prompt either - it's not relevant to a
// public-market analysis and only risks the AI leaking an assumption about
// one specific company's numbers.
function scopeRules() {
  return [
    "Kamu TIDAK punya dan TIDAK AKAN pernah diberi akses ke data internal perusahaan mana pun (data penjualan, iklan, analytics, dll milik perusahaan tertentu).",
    "Diskusi ini HANYA soal kondisi pasar/industri otomotif PUBLIK secara umum di Indonesia - bukan soal satu perusahaan tertentu.",
    "Kalau kamu merasa butuh data spesifik satu perusahaan, JANGAN menebak/berasumsi - cukup bilang itu di luar scope diskusi ini.",
    "Kalau tersedia, gunakan pencarian web untuk data/tren terkini yang relevan dan sebutkan sumbernya.",
    "",
  ];
}

function anonymityRules(selfTag) {
  return [
    `Dalam diskusi ini kamu dipanggil "${selfTag}" - peserta lain dan juri TIDAK tahu kamu AI/model apa, begitu juga sebaliknya buat kamu ke mereka.`,
    "Jangan pernah menyebut nama model/AI-mu sendiri (misalnya Gemini, GPT, Claude, ChatGPT, dll) atau menebak nama model lawan bicara di jawabanmu.",
    "Bicara dengan sudut pandang orang pertama (\"menurut saya\", \"saya pikir\"), bukan menyebut diri sendiri dengan label pihak ketiga.",
    "",
  ];
}

function buildParticipantPrompt(topic, rounds, participant, anonMap) {
  const selfTag = anonMap.get(participant.id);
  if (rounds.length === 0) {
    return [
      `Topik diskusi: "${topic}"`,
      "",
      ...scopeRules(),
      ...anonymityRules(selfTag),
      "Kamu salah satu peserta diskusi multi-AI.",
      "Berikan posisi awalmu terhadap topik ini secara jelas dan ringkas (maksimal beberapa paragraf), sertakan sinyal/data konkret yang kamu tahu (sumber kalau ada).",
      "Jangan cuma menyimpulkan, ambil sikap yang konkret dan berikan alasannya.",
    ].join("\n");
  }
  return [
    `Topik diskusi: "${topic}"`,
    "",
    "Berikut transkrip diskusi sejauh ini antar beberapa AI:",
    "",
    formatHistory(rounds, anonMap),
    "",
    ...scopeRules(),
    ...anonymityRules(selfTag),
    "Baca seluruh histori di atas, lalu berikan tanggapan ronde barumu.",
    "Instruksi penting:",
    "- JANGAN cuma bilang \"setuju\" atau mengulang poin yang sudah ada.",
    "- Kritik, koreksi, atau tambahkan perspektif/data baru yang belum dibahas.",
    "- Kalau kamu memang setuju pada satu poin, jelaskan kenapa dengan argumen tambahan, atau persempit ke sub-poin yang masih bisa diperdebatkan.",
    "- Tetap ringkas dan langsung ke inti.",
  ].join("\n");
}

function buildJudgePrompt(topic, targetPeriod, rounds, participants, anonMap) {
  const tags = participants.map((p) => anonMap.get(p.id));
  const schema = `{
  "summaryPerParticipant": [ { "label": "Peserta A", "position": "ringkasan posisi utamanya" } ],
  "agreedPoints": ["poin yang disepakati semua peserta"],
  "disputedPoints": [ { "point": "poin yang diperdebatkan", "reason": "kenapa mereka beda pendapat" } ],
  "marketSignals": [ { "signal": "satu sinyal pasar konkret, ringkas", "direction": "positive|negative|neutral", "relevance": "high|medium|low", "source": "sumber kalau disebutkan, boleh kosong" } ],
  "recommendationForQwen": "catatan kualitatif ringkas: faktor eksternal apa yang sebaiknya jadi pertimbangan tambahan saat model lain membaca data penjualan internal",
  "sources": [ { "title": "judul sumber", "url": "url kalau ada" } ],
  "confidence": "low|medium|high"
}`;
  return [
    "PERAN: Kamu BUKAN peserta diskusi. Tugasmu murni menganalisis dan menyimpulkan diskusi berikut secara netral dan objektif jadi satu paket \"knowledge\" terstruktur.",
    "Kamu TIDAK diberi tahu AI/model apa di balik tiap peserta (cuma label anonim \"Peserta A/B/...\") - ini sengaja, supaya kamu menilai murni dari isi argumen, bukan reputasi nama model. Jangan coba menebak model aslinya.",
    ...scopeRules(),
    `Topik: "${topic}"`,
    `Periode target prediksi: sekitar akhir ${MONTH_NAMES_ID[targetPeriod.currentMonth.month - 1]} ${targetPeriod.currentMonth.year} dan ${MONTH_NAMES_ID[targetPeriod.nextMonth.month - 1]} ${targetPeriod.nextMonth.year}.`,
    `Peserta diskusi: ${tags.join(", ")}.`,
    "",
    "Transkrip lengkap diskusi:",
    "",
    formatHistory(rounds, anonMap),
    "",
    "Analisis transkrip di atas lalu keluarkan HANYA satu objek JSON valid (tanpa markdown fence, tanpa teks lain sebelum/sesudahnya) dengan skema persis berikut (field \"label\" di summaryPerParticipant diisi label anonim peserta seperti di transkrip, contoh \"Peserta A\"):",
    schema,
    "",
    "Ketentuan:",
    "- marketSignals adalah bagian PALING PENTING: ekstrak sinyal-sinyal pasar konkret yang disebut di diskusi (jangan cuma rangkum naratif), ini akan dipakai programatik oleh sistem lain.",
    "- Nilai/simpulkan murni dari isi argumen & data yang disebutkan, bukan dari identitas peserta.",
    "- Kalau suatu field memang tidak ada datanya dari diskusi (misal tidak ada sumber yang disebut), isi array kosong, jangan mengarang.",
    "- confidence WAJIB dinilai pakai rubrik ini, jangan asal tebak:",
    "    * \"high\": mayoritas marketSignals punya sumber konkret yang disebutkan, dan peserta banyak sepakat berdasarkan data/fakta, bukan spekulasi.",
    "    * \"medium\": ada beberapa data/sinyal konkret, tapi juga beberapa bagian cuma perkiraan/asumsi tanpa sumber jelas.",
    "    * \"low\": mayoritas peserta bilang \"di luar scope\"/tidak ada data konkret, atau isinya didominasi spekulasi tanpa sumber sama sekali.",
  ].join("\n");
}

// The judge only ever sees "Peserta A/B/..." (see buildJudgePrompt) - translate
// those back to the real participant labels before this reaches storage/UI.
function deAnonymize(value, participants, anonMap) {
  const realLabel = new Map();
  for (const p of participants) realLabel.set(anonMap.get(p.id), p.label);

  const replaceInString = (s) => {
    let out = s;
    for (const [tag, label] of realLabel) out = out.split(tag).join(label);
    return out;
  };
  const walk = (v) => {
    if (typeof v === "string") return replaceInString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
}

function parseJudgeOutput(rawText) {
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let parsed = tryParse(rawText.trim());
  if (!parsed) {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) parsed = tryParse(match[0]);
  }
  return parsed;
}

function emit(session, type, data) {
  const event = { type, data, ts: Date.now() };
  session.log.push(event);
  session.bus.emit("event", event);
  logEvent(session, type, data);
}

// Minimal progress/diagnostic logging to the server's own terminal, same
// pattern as the reference project - without it a stuck/slow CLI call (rate
// limiting, a hung subprocess, ...) is completely silent.
function logEvent(session, type, data) {
  const stamp = new Date().toLocaleTimeString("id-ID");
  const tag = `[${stamp}] [${session.id.slice(0, 8)}]`;
  switch (type) {
    case "round-start":
      console.log(`${tag} Ronde ${data.round} mulai`);
      break;
    case "participant-start":
      console.log(`${tag}   -> ${data.label} mulai...`);
      break;
    case "participant-done":
      console.log(
        `${tag}   <- ${data.label} selesai (${data.ok ? "ok" : "GAGAL"}, ${Math.round(data.durationMs / 1000)}s)${data.ok ? "" : `: ${data.text}`}`
      );
      break;
    case "judge-start":
      console.log(`${tag} Juri (${data.label}) mulai menyimpulkan jadi knowledge bundle...`);
      break;
    case "judge-done":
      console.log(`${tag} Juri selesai (${data.ok ? "ok" : "GAGAL"})`);
      break;
    case "stopped-early":
      console.log(`${tag} Berhenti lebih awal di ronde ${data.round}: ${data.reason}`);
      break;
  }
}

export function createKnowledgeSession({ referenceDate, rounds, participants, judge, settings }) {
  const id = crypto.randomUUID();
  const targetPeriod = buildTargetPeriod(referenceDate);
  const topic = buildTopic(targetPeriod);
  const session = {
    id,
    topic,
    targetPeriod,
    createdAt: Date.now(),
    maxRounds: rounds,
    participants,
    judge,
    rounds: [],
    bundle: null,
    stoppedEarly: false,
    status: "pending",
    log: [],
    bus: new EventEmitter(),
    settings,
  };
  session.bus.setMaxListeners(50);
  sessions.set(id, session);
  return session;
}

export async function runKnowledgeSession(session) {
  session.status = "running";
  const brief = (p) => ({ id: p.id, label: p.label, provider: p.provider, modelVariant: p.modelVariant });
  emit(session, "session-start", {
    topic: session.topic,
    targetPeriod: session.targetPeriod,
    participants: session.participants.map(brief),
    judge: brief(session.judge),
    maxRounds: session.maxRounds,
  });

  const { agreementThreshold, agreementStreakToStop, timeoutMs } = session.settings;
  let similarStreak = 0;
  const anonMap = buildAnonMap(session.participants);

  try {
    for (let r = 0; r < session.maxRounds; r++) {
      emit(session, "round-start", { round: r + 1 });
      const round = { entries: [] };

      const results = await Promise.all(
        session.participants.map(async (participant) => {
          emit(session, "participant-start", { round: r + 1, id: participant.id, label: participant.label });
          const prompt = buildParticipantPrompt(session.topic, session.rounds, participant, anonMap);
          const result = await runModel(participant, prompt, { timeoutMs });
          const entry = {
            id: participant.id,
            label: participant.label,
            ok: result.ok,
            text: result.text,
            durationMs: result.durationMs,
          };
          emit(session, "participant-done", { round: r + 1, ...entry });
          return entry;
        })
      );

      round.entries = results;
      session.rounds.push(round);
      emit(session, "round-end", { round: r + 1, entries: results });

      if (session.rounds.length >= 2) {
        const prev = {};
        const curr = {};
        for (const e of session.rounds[session.rounds.length - 2].entries) prev[e.id] = e;
        for (const e of round.entries) curr[e.id] = e;
        const sim = roundSimilarity(prev, curr);
        similarStreak = sim >= agreementThreshold ? similarStreak + 1 : 0;
        emit(session, "similarity", { round: r + 1, score: sim, streak: similarStreak });
        if (similarStreak >= agreementStreakToStop) {
          session.stoppedEarly = true;
          emit(session, "stopped-early", {
            round: r + 1,
            reason: "Jawaban antar model terlalu mirip beberapa ronde berturut-turut (agreement loop).",
          });
          break;
        }
      }
    }

    emit(session, "judge-start", { label: session.judge.label });
    const judgePrompt = buildJudgePrompt(session.topic, session.targetPeriod, session.rounds, session.participants, anonMap);
    const judgeResult = await runModel(session.judge, judgePrompt, { timeoutMs });

    const parsed = judgeResult.ok ? parseJudgeOutput(judgeResult.text) : null;
    const judgeOutput = parsed ? deAnonymize(parsed, session.participants, anonMap) : null;

    const bundle = {
      id: crypto.randomUUID(),
      generatedAt: new Date().toISOString(),
      targetPeriod: session.targetPeriod,
      scope: "external-automotive-market-only",
      topics: SCOPE_TOPICS,
      summaryPerParticipant: judgeOutput?.summaryPerParticipant ?? [],
      agreedPoints: judgeOutput?.agreedPoints ?? [],
      disputedPoints: judgeOutput?.disputedPoints ?? [],
      marketSignals: judgeOutput?.marketSignals ?? [],
      recommendationForQwen: judgeOutput?.recommendationForQwen ?? "",
      sources: judgeOutput?.sources ?? [],
      confidence: judgeOutput?.confidence ?? "unknown",
      raw: {
        rounds: session.rounds,
        judgeOk: judgeResult.ok,
        judgeRawResponse: judgeResult.text,
      },
    };

    session.bundle = bundle;
    emit(session, "judge-done", { ok: judgeResult.ok, bundle });

    const { filePath, fileName } = await saveKnowledgeBundle(bundle, session.settings.knowledgeDir);
    session.savedTo = { filePath, fileName };
    session.status = "done";
    emit(session, "session-done", { bundle, fileName, stoppedEarly: session.stoppedEarly });
  } catch (err) {
    session.status = "error";
    emit(session, "session-error", { message: err.message });
  }
}
