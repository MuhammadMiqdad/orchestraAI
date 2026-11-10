const dateInput = document.getElementById("referenceDate");
const generateBtn = document.getElementById("generateBtn");
const statusSection = document.getElementById("statusSection");
const logEl = document.getElementById("log");
const resultSection = document.getElementById("resultSection");
const resultMeta = document.getElementById("resultMeta");
const resultReadable = document.getElementById("resultReadable");
const resultJson = document.getElementById("resultJson");

const today = new Date();
dateInput.value = today.toISOString().slice(0, 10);

function logLine(text, cls = "") {
  const div = document.createElement("div");
  div.className = `line ${cls}`;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function logText(text) {
  const div = document.createElement("div");
  div.className = "line answer";
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const DIRECTION_LABEL = { positive: "Positif", negative: "Negatif", neutral: "Netral" };
const RELEVANCE_LABEL = { high: "Tinggi", medium: "Sedang", low: "Rendah" };
const CONFIDENCE_LABEL = { high: "Tinggi", medium: "Sedang", low: "Rendah", unknown: "Tidak diketahui" };

function renderBundle(bundle) {
  resultReadable.innerHTML = "";
  const container = resultReadable;

  const periodBlock = el("div", "card");
  const cur = bundle.targetPeriod.currentMonth;
  const next = bundle.targetPeriod.nextMonth;
  periodBlock.appendChild(el("h3", "", "Periode Target"));
  periodBlock.appendChild(
    el("p", "", `Berdasarkan tanggal ${bundle.targetPeriod.referenceDate} — mencakup akhir bulan ${cur.month}/${cur.year} dan bulan ${next.month}/${next.year}.`)
  );
  periodBlock.appendChild(el("p", "meta", `Tingkat keyakinan juri: ${CONFIDENCE_LABEL[bundle.confidence] ?? bundle.confidence}`));
  container.appendChild(periodBlock);

  if (bundle.summaryPerParticipant?.length) {
    const block = el("div", "card");
    block.appendChild(el("h3", "", "Ringkasan Posisi Tiap Peserta"));
    for (const s of bundle.summaryPerParticipant) {
      const p = el("p");
      const strong = el("strong", "", `${s.label}: `);
      p.appendChild(strong);
      p.appendChild(document.createTextNode(s.position));
      block.appendChild(p);
    }
    container.appendChild(block);
  }

  if (bundle.agreedPoints?.length) {
    const block = el("div", "card");
    block.appendChild(el("h3", "", "Poin yang Disepakati"));
    const ul = el("ul");
    for (const point of bundle.agreedPoints) ul.appendChild(el("li", "", point));
    block.appendChild(ul);
    container.appendChild(block);
  }

  if (bundle.disputedPoints?.length) {
    const block = el("div", "card");
    block.appendChild(el("h3", "", "Poin yang Masih Diperdebatkan"));
    const ul = el("ul");
    for (const d of bundle.disputedPoints) {
      const li = el("li");
      li.appendChild(el("strong", "", d.point));
      li.appendChild(document.createTextNode(` — ${d.reason}`));
      ul.appendChild(li);
    }
    block.appendChild(ul);
    container.appendChild(block);
  }

  if (bundle.marketSignals?.length) {
    const block = el("div", "card");
    block.appendChild(el("h3", "", "Sinyal Pasar"));
    const ul = el("ul", "signals");
    for (const sig of bundle.marketSignals) {
      const li = el("li", `signal ${sig.direction || ""}`);
      li.appendChild(el("span", "signalText", sig.signal));
      const tagLine = el(
        "div",
        "meta",
        `Arah: ${DIRECTION_LABEL[sig.direction] ?? sig.direction ?? "-"} · Relevansi: ${RELEVANCE_LABEL[sig.relevance] ?? sig.relevance ?? "-"}${sig.source ? ` · Sumber: ${sig.source}` : ""}`
      );
      li.appendChild(tagLine);
      ul.appendChild(li);
    }
    block.appendChild(ul);
    container.appendChild(block);
  }

  if (bundle.recommendationForQwen) {
    const block = el("div", "card");
    block.appendChild(el("h3", "", "Catatan untuk Model Prediksi (Qwen)"));
    block.appendChild(el("p", "", bundle.recommendationForQwen));
    container.appendChild(block);
  }

  if (bundle.sources?.length) {
    const block = el("div", "card");
    block.appendChild(el("h3", "", "Sumber"));
    const ul = el("ul");
    for (const src of bundle.sources) {
      const li = el("li");
      if (src.url) {
        const a = el("a", "", src.title || src.url);
        a.href = src.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        li.appendChild(a);
      } else {
        li.textContent = src.title || "(tanpa judul)";
      }
      ul.appendChild(li);
    }
    block.appendChild(ul);
    container.appendChild(block);
  }
}

function attachStream(sessionId) {
  const es = new EventSource(`/api/sessions/${sessionId}/stream`);

  es.addEventListener("session-start", (e) => {
    const data = JSON.parse(e.data);
    logLine(`Topik: ${data.topic}`);
    logLine(`Peserta: ${data.participants.map((p) => p.label).join(", ")} | Juri: ${data.judge.label}`);
  });
  es.addEventListener("round-start", (e) => {
    const data = JSON.parse(e.data);
    logLine(`\nRonde ${data.round} mulai...`);
  });
  es.addEventListener("participant-start", (e) => {
    const data = JSON.parse(e.data);
    logLine(`  -> ${data.label} mulai...`);
  });
  es.addEventListener("participant-done", (e) => {
    const data = JSON.parse(e.data);
    logLine(`  <- ${data.label} selesai (${data.ok ? "ok" : "gagal"}, ${Math.round(data.durationMs / 1000)}s)`, data.ok ? "ok" : "fail");
    if (data.text) logText(`     [${data.label}] ${data.text}`);
  });
  es.addEventListener("stopped-early", (e) => {
    const data = JSON.parse(e.data);
    logLine(`Berhenti lebih awal di ronde ${data.round}: ${data.reason}`);
  });
  es.addEventListener("judge-start", (e) => {
    const data = JSON.parse(e.data);
    logLine(`\nJuri (${data.label}) menyimpulkan jadi knowledge bundle...`);
  });
  es.addEventListener("judge-done", (e) => {
    const data = JSON.parse(e.data);
    logLine(`Juri selesai (${data.ok ? "ok" : "gagal"})`, data.ok ? "ok" : "fail");
  });
  es.addEventListener("session-done", (e) => {
    const data = JSON.parse(e.data);
    resultMeta.textContent = `Disimpan sebagai knowledge/${data.fileName}${data.stoppedEarly ? " (berhenti lebih awal)" : ""}`;
    renderBundle(data.bundle);
    resultJson.textContent = JSON.stringify(data.bundle, null, 2);
    resultSection.hidden = false;
    generateBtn.disabled = false;
  });
  es.addEventListener("session-error", (e) => {
    const data = JSON.parse(e.data);
    logLine(`ERROR: ${data.message}`, "fail");
    generateBtn.disabled = false;
  });
  es.addEventListener("stream-end", () => es.close());
  es.onerror = () => es.close();
}

generateBtn.addEventListener("click", async () => {
  const referenceDate = dateInput.value;
  if (!referenceDate) return;

  generateBtn.disabled = true;
  statusSection.hidden = false;
  resultSection.hidden = true;
  logEl.innerHTML = "";
  logLine(`Mulai generate untuk tanggal ${referenceDate}...`);

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referenceDate }),
    });
    const data = await res.json();
    if (!res.ok) {
      logLine(`ERROR: ${data.error || "gagal memulai sesi"}`, "fail");
      generateBtn.disabled = false;
      return;
    }
    attachStream(data.sessionId);
  } catch (err) {
    logLine(`ERROR: ${err.message}`, "fail");
    generateBtn.disabled = false;
  }
});
