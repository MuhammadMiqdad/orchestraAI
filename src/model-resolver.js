export function resolveModel(entry, engines) {
  const engine = engines.find((e) => e.id === entry.engineId);
  if (!engine) return null;

  if (engine.type === "http") {
    return {
      id: entry.id,
      label: entry.label,
      provider: engine.engineLabel,
      modelVariant: entry.modelVariant || engine.defaultModel || "",
      builtin: !!entry.builtin,
      type: "http",
      url: engine.url,
      method: engine.method || "POST",
      apiKeyEnv: engine.apiKeyEnv,
      authHeader: engine.authHeader || "Authorization",
      authPrefix: engine.authPrefix ?? "Bearer ",
      bodyBuilder: engine.bodyBuilder || "openai-chat",
      output: engine.output,
    };
  }

  const flagTokens = entry.modelVariant ? [engine.modelFlag, entry.modelVariant] : [];
  const args = engine.baseArgs.flatMap((tok) => (tok === "{MODELFLAGS}" ? flagTokens : [tok]));
  return {
    id: entry.id,
    label: entry.label,
    provider: engine.engineLabel,
    modelVariant: entry.modelVariant || "",
    builtin: !!entry.builtin,
    type: "cli",
    command: engine.command,
    args,
    output: engine.output,
  };
}

export function serializeEntry(entry, engines) {
  const engine = engines.find((e) => e.id === entry.engineId);
  return {
    id: entry.id,
    label: entry.label,
    engineId: entry.engineId,
    provider: engine ? engine.engineLabel : entry.engineId,
    modelVariant: entry.modelVariant || "",
    builtin: !!entry.builtin,
  };
}
