import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

function buildArgs(template, prompt, outFile) {
  return template.map((token) => {
    if (token === "{PROMPT}") return prompt;
    if (token === "{OUTFILE}") return outFile;
    return token;
  });
}

function readPath(obj, dotted) {
  if (!dotted) return undefined;
  return dotted.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * Runs one model (CLI subprocess or HTTP API) on a prompt and normalizes the
 * result. Never throws - failures come back as { ok: false, text: "[no response] ..." }
 * so one dead provider never takes down a round.
 */
export async function runModel(model, prompt, opts = {}) {
  if (model.type === "http") return runHttpModel(model, prompt, opts);
  return runCliModel(model, prompt, opts);
}

async function runCliModel(model, prompt, { cwd, timeoutMs, signal } = {}) {
  const started = Date.now();
  let outFile = null;
  let workDir = cwd;
  let cleanupWorkDir = false;

  if (!workDir) {
    workDir = await mkdtemp(path.join(tmpdir(), "wko-"));
    cleanupWorkDir = true;
  }

  if (model.output.type === "last-message-file") {
    outFile = path.join(workDir, `last-${crypto.randomUUID()}.txt`);
  }

  const args = buildArgs(model.args, prompt, outFile);

  try {
    const { stdout, stderr, code, timedOut, errorMessage } = await execCapture(model.command, args, {
      cwd: workDir,
      timeoutMs: timeoutMs ?? 300000,
      signal,
      stdin: prompt,
    });

    if (errorMessage) {
      return {
        ok: false,
        text: `[no response] ${model.label} gagal dijalankan: ${errorMessage}`,
        raw: stdout,
        durationMs: Date.now() - started,
      };
    }

    if (timedOut) {
      return {
        ok: false,
        text: `[no response] ${model.label} timed out setelah ${Math.round((timeoutMs ?? 300000) / 1000)}s.`,
        raw: stdout,
        durationMs: Date.now() - started,
      };
    }

    if (code !== 0 && model.output.type !== "last-message-file") {
      return {
        ok: false,
        text: `[no response] ${model.label} keluar dengan kode ${code}. ${stderr.slice(0, 400)}`.trim(),
        raw: stdout,
        durationMs: Date.now() - started,
      };
    }

    if (model.output.type === "json") {
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        return {
          ok: false,
          text: `[no response] ${model.label} tidak mengembalikan JSON valid.`,
          raw: stdout,
          durationMs: Date.now() - started,
        };
      }
      const text = readPath(parsed, model.output.textPath);
      if (text && String(text).trim()) {
        return {
          ok: true,
          text: String(text).trim(),
          usage: parsed.usage ?? null,
          durationMs: Date.now() - started,
        };
      }
      if (model.output.statusPath && model.output.okStatus) {
        const status = readPath(parsed, model.output.statusPath);
        if (status !== model.output.okStatus) {
          return {
            ok: false,
            text: `[no response] ${model.label} status: ${status ?? "unknown"}.`,
            raw: stdout,
            durationMs: Date.now() - started,
          };
        }
      }
      if (model.output.errorFlagPath && readPath(parsed, model.output.errorFlagPath)) {
        return {
          ok: false,
          text: `[no response] ${model.label} melaporkan error.`,
          raw: stdout,
          durationMs: Date.now() - started,
        };
      }
      return {
        ok: false,
        text: `[no response] ${model.label} memberi jawaban kosong.`,
        raw: stdout,
        durationMs: Date.now() - started,
      };
    }

    if (model.output.type === "last-message-file") {
      let fileText = "";
      try {
        fileText = (await readFile(outFile, "utf8")).trim();
      } catch {
        fileText = "";
      }
      if (!fileText) {
        return {
          ok: false,
          text: `[no response] ${model.label} tidak menghasilkan output.`,
          raw: stdout,
          durationMs: Date.now() - started,
        };
      }
      return { ok: true, text: fileText, usage: null, durationMs: Date.now() - started };
    }

    return { ok: true, text: stdout.trim(), usage: null, durationMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      text: `[no response] ${model.label} gagal dijalankan: ${err.message}`,
      raw: "",
      durationMs: Date.now() - started,
    };
  } finally {
    if (outFile) {
      await rm(outFile, { force: true }).catch(() => {});
    }
    if (cleanupWorkDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// Not wired into config.json for v1 (no HTTP engine configured there yet) -
// kept ready so adding a Perplexity-style engine entry later (type: "http" in
// config.json, see README) doesn't require touching orchestrator.js at all.
async function runHttpModel(model, prompt, { timeoutMs, signal } = {}) {
  const started = Date.now();
  const apiKey = model.apiKeyEnv ? process.env[model.apiKeyEnv] : null;
  if (model.apiKeyEnv && !apiKey) {
    return {
      ok: false,
      text: `[no response] ${model.label} gagal: env var ${model.apiKeyEnv} belum diset.`,
      raw: "",
      durationMs: Date.now() - started,
    };
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers[model.authHeader] = `${model.authPrefix}${apiKey}`;

  let body;
  if (model.bodyBuilder === "openai-chat") {
    body = JSON.stringify({
      model: model.modelVariant || undefined,
      messages: [{ role: "user", content: prompt }],
    });
  } else {
    body = JSON.stringify({ prompt });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? 300000);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(model.url, { method: model.method || "POST", headers, body, signal: controller.signal });
    const raw = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        text: `[no response] ${model.label} HTTP ${res.status}: ${raw.slice(0, 400)}`,
        raw,
        durationMs: Date.now() - started,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, text: `[no response] ${model.label} tidak mengembalikan JSON valid.`, raw, durationMs: Date.now() - started };
    }
    const text = readPath(parsed, model.output?.textPath);
    if (!text || !String(text).trim()) {
      return { ok: false, text: `[no response] ${model.label} memberi jawaban kosong.`, raw, durationMs: Date.now() - started };
    }
    return { ok: true, text: String(text).trim(), usage: parsed.usage ?? null, durationMs: Date.now() - started };
  } catch (err) {
    const timedOut = err.name === "AbortError";
    return {
      ok: false,
      text: timedOut
        ? `[no response] ${model.label} timed out setelah ${Math.round((timeoutMs ?? 300000) / 1000)}s.`
        : `[no response] ${model.label} gagal dijalankan: ${err.message}`,
      raw: "",
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function killTree(child) {
  // Some CLIs (agy, in particular) spawn their own MCP-server subprocess. If we only
  // kill the direct child, that grandchild can be left holding our stdout/stderr
  // pipes open, and Node's 'close' event then never fires - the call hangs forever
  // even though the model process is long dead.
  if (process.platform === "win32") {
    // No POSIX process groups on Windows; taskkill's /T walks the whole tree instead.
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
    return;
  }
  // `detached: true` (posix only - see execCapture) puts the child in its own
  // process group, so a negative-pid kill reaches the whole tree.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// Some CLIs (claude, codex, ...) are installed on Windows as .cmd/.ps1 shims,
// not real .exe files - spawn() can't launch those directly without a shell,
// and fails with ENOENT before the prompt is even sent. Others (agy) are a
// real .exe and launch fine without one. Rather than hardcode which is which,
// try the direct, shell-less spawn first and only fall back to a shell on ENOENT.
//
// This matters because shell:true routes the whole command through cmd.exe,
// which treats embedded newlines in an argument as command separators and
// shreds a multi-line prompt into bogus extra arguments - so a shelled-out
// engine must receive its prompt over stdin, never inline in argv (see
// config.json: only agy, which never needs a shell, still gets `{PROMPT}`
// substituted directly into its args).
async function execCapture(command, args, { cwd, timeoutMs, signal, stdin }) {
  const direct = await spawnOnce(command, args, { cwd, timeoutMs, signal, stdin, shell: false });
  if (process.platform === "win32" && direct.errorMessage?.includes("ENOENT")) {
    return spawnOnce(command, args, { cwd, timeoutMs, signal, stdin, shell: true });
  }
  return direct;
}

function spawnOnce(command, args, { cwd, timeoutMs, signal, stdin, shell }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      // On Windows, `detached` + `shell` together silently swallow the child's
      // stdout, so process-group detaching (see killTree) only applies when
      // we're not shelling out.
      detached: !shell,
      shell,
      // Without a console of its own (e.g. server.js launched from a GUI, not
      // a terminal), spawning via cmd.exe (shell: true) pops up a new, empty
      // console window for every call unless explicitly told not to.
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    // Hard backstop: even if killing the process tree somehow fails to make the
    // 'close' event fire, never keep a round waiting past timeoutMs by more than
    // a few seconds.
    let forceTimer = null;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      forceTimer = setTimeout(() => finish({ stdout, stderr, code: null, timedOut: true }), 5000);
    }, timeoutMs);

    const onAbort = () => {
      killTree(child);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    // Not every engine reads its prompt from stdin (some take it inline via
    // {PROMPT} in args instead - see config.json), so the write end can close
    // without ever being read; swallow the resulting EPIPE instead of crashing.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "", "utf8");

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    child.on("error", (err) => {
      finish({ stdout, stderr, code: null, timedOut, errorMessage: err.message });
    });

    // Some CLIs (agy, notably) spawn their own MCP-server subprocess without
    // giving it fully independent stdio, so that grandchild can outlive the CLI
    // itself and keep holding our stdout/stderr pipes open. Node's 'close' event
    // waits for those pipes to fully drain, so it can hang forever even though
    // our direct child is long gone. 'exit' fires as soon as *our* child
    // terminates, regardless of what its own children are still doing - wait one
    // tick after that for any already-buffered output, then finalize on 'exit'
    // rather than risking 'close' never arriving. 'close' is still the resolve
    // path in the common case where it arrives first.
    child.on("exit", (code) => {
      killTree(child);
      setImmediate(() => finish({ stdout, stderr, code, timedOut }));
    });

    child.on("close", (code) => {
      finish({ stdout, stderr, code, timedOut });
    });
  });
}
