import type { AiProvider } from "@paperclipai/shared";

// Shape checks for a credential file a user pastes into the sign-in card in
// place of running the provider's login. They only decide which file name the
// content belongs under and whether it is plausibly complete, so an obviously
// wrong paste gets a clear message before the provider round-trip. The real
// verification is the same one a terminal login gets. Nothing here logs or
// returns token material.

export type ImportedCredentialTarget = { filename: string };

export function describeImportedCredential(provider: AiProvider, content: string): ImportedCredentialTarget {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The pasted text is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The pasted text is not a credential document.");
  }
  const doc = parsed as Record<string, unknown>;
  if (provider === "openai") {
    const tokens = doc.tokens as Record<string, unknown> | undefined;
    const has = (key: string) => typeof tokens?.[key] === "string" && (tokens[key] as string).length > 0;
    if (!has("access_token") || !has("refresh_token") || !has("id_token")) {
      throw new Error("This does not look like a complete Codex auth.json: it needs tokens.access_token, tokens.refresh_token and tokens.id_token.");
    }
    return { filename: "auth.json" };
  }
  if (provider === "anthropic") {
    const oauth = doc.claudeAiOauth as Record<string, unknown> | undefined;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken.length) {
      throw new Error("This does not look like a Claude credentials file: it needs claudeAiOauth.accessToken.");
    }
    return { filename: ".credentials.json" };
  }
  if (provider === "xai") {
    return { filename: "auth.json" };
  }
  throw new Error("This provider does not use a credential file.");
}
