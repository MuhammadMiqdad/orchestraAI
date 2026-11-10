import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}

async function readJsonOrDefault(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function loadIndex(knowledgeDir) {
  return readJsonOrDefault(path.join(knowledgeDir, "index.json"), []);
}

async function saveIndex(knowledgeDir, index) {
  await writeFile(path.join(knowledgeDir, "index.json"), JSON.stringify(index, null, 2), "utf8");
}

/**
 * Persists a finished knowledge bundle: one timestamped file for history,
 * `latest.json` always overwritten with the newest bundle, and a lightweight
 * `index.json` (id -> filename + referenceDate) so lookups/filters don't need
 * to read every bundle file back from disk.
 */
export async function saveKnowledgeBundle(bundle, knowledgeDir) {
  await mkdir(knowledgeDir, { recursive: true });
  const fileName = `${timestamp()}-${bundle.targetPeriod.referenceDate}.json`;
  const filePath = path.join(knowledgeDir, fileName);
  const body = JSON.stringify(bundle, null, 2);

  await writeFile(filePath, body, "utf8");
  await writeFile(path.join(knowledgeDir, "latest.json"), body, "utf8");

  const index = await loadIndex(knowledgeDir);
  index.push({
    id: bundle.id,
    file: fileName,
    referenceDate: bundle.targetPeriod.referenceDate,
    generatedAt: bundle.generatedAt,
  });
  await saveIndex(knowledgeDir, index);

  return { filePath, fileName };
}

export async function getLatestKnowledge(knowledgeDir) {
  return readJsonOrDefault(path.join(knowledgeDir, "latest.json"), null);
}

export async function getKnowledgeById(id, knowledgeDir) {
  const index = await loadIndex(knowledgeDir);
  const entry = index.find((e) => e.id === id);
  if (!entry) return null;
  return readJsonOrDefault(path.join(knowledgeDir, entry.file), null);
}

export async function listKnowledge({ from, to }, knowledgeDir) {
  const index = await loadIndex(knowledgeDir);
  const filtered = index
    .filter((e) => (!from || e.referenceDate >= from) && (!to || e.referenceDate <= to))
    .sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));

  const bundles = await Promise.all(
    filtered.map((e) => readJsonOrDefault(path.join(knowledgeDir, e.file), null))
  );
  return bundles.filter(Boolean);
}
