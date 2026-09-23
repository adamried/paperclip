import { useEffect, useRef, useState } from "react";
import type { AiConnectionLoginIntent, LocalAiLoginAssisted, LocalAiLoginAttempt, LocalAiLoginStatus } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";

/** Every authentication host uses the same local credential check and login lifecycle. */
export function useLocalAiLogin(companyId: string | null, intent: AiConnectionLoginIntent, enabled: boolean, options: { allowHostClaude?: boolean } = {}) {
  // Anthropic on a local-trusted instance may reuse the machine's existing
  // Claude login. That shortcut stores only a short-lived access token that
  // nothing can refresh, so the separate sign-in is the default and the
  // shortcut is an explicit opt-in the card explains.
  const hostAllowed = intent.provider === "anthropic" && Boolean(options.allowHostClaude);
  const [useHost, setUseHost] = useState(false);
  const isolated = intent.provider !== "anthropic" || !(hostAllowed && useHost);
  const active = Boolean(companyId && enabled);
  const [attempt, setAttempt] = useState<LocalAiLoginAttempt | null>(null);
  const [status, setStatus] = useState<LocalAiLoginStatus["status"] | null>(null);
  const [assisted, setAssisted] = useState<LocalAiLoginAssisted | null>(null);
  const [submittingCode, setSubmittingCode] = useState(false);
  const recheck = useRef<() => void>(() => {});
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const latestIntent = useRef(intent);
  const restartRequested = useRef(false);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const current = useRef<{ key: string; companyId: string; request: Promise<LocalAiLoginAttempt> } | null>(null);
  function cancelCurrent() {
    const previous = current.current;
    current.current = null;
    if (previous) pending.current = previous.request
      .then((result) => aiConnectionsApi.cancelLocalLogin(previous.companyId, result.sessionId)).catch(() => {});
  }
  latestIntent.current = intent;
  // Renaming the account does not restart sign-in; access/target changes do.
  const target = JSON.stringify({ ...intent, name: undefined });
  useEffect(() => {
    setAttempt(null);
    setError(null);
    setStatus(null);
    setAssisted(null);
    if (!active || !companyId) return;
    let cancelled = false;
    let checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = JSON.stringify([companyId, target, generation, isolated]);
    if (isolated && current.current?.key !== key) {
      cancelCurrent();
      const input = { ...latestIntent.current, ...(restartRequested.current ? { restart: true } : {}) };
      restartRequested.current = false;
      const request = pending.current.then(() => aiConnectionsApi.startLocalLogin(companyId, input));
      current.current = { key, companyId, request };
      pending.current = request.catch(() => {});
    }
    const request = isolated ? current.current!.request : Promise.resolve(null);
    async function check() {
      if (checking || cancelled) return;
      checking = true;
      clearTimeout(timer);
      try {
        const result = await request;
        if (cancelled) return;
        setAttempt(result);
        const next = await aiConnectionsApi.checkLocalLogin(companyId!, {
          ...latestIntent.current, ...(result ? { localSessionId: result.sessionId } : {}),
        });
        if (cancelled) return;
        setStatus(next.status);
        setAssisted(next.assisted ?? null);
        setError(next.status === "expired" ? "This sign-in attempt expired. Start sign-in again." : null);
        // Stop polling a verified account. Focus still rechecks after a terminal
        // visit; awaiting terminal login never requires repeated Connect clicks.
        // An assisted sign-in polls faster while the CLI is completing the code.
        if (next.status === "sign_in_required") timer = setTimeout(() => void check(), next.assisted?.state === "completing" ? 1500 : 5000);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not check local sign-in.");
      } finally { checking = false; }
    }
    const onFocus = () => { if (!document.hidden) void check(); };
    recheck.current = () => void check();
    void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      recheck.current = () => {};
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      // Navigation is not cancellation. The server resumes this bounded attempt
      // when the user returns and reaps abandoned attempts after expiry. Deleting
      // here made copied CODEX_HOME commands point at nonexistent directories.
    };
  }, [companyId, active, isolated, target, generation]);
  return {
    isolated,
    assisted: isolated ? assisted : null,
    loginUrl: isolated ? assisted?.loginUrl ?? null : null,
    submittingCode,
    submitCode: async (code: string) => {
      if (!companyId || !attempt) throw new Error("Prepare local sign-in before submitting a code.");
      setSubmittingCode(true);
      setError(null);
      try {
        const next = await aiConnectionsApi.submitLocalLoginCode(companyId, attempt.sessionId, code);
        setAssisted(next ?? null);
        recheck.current();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not submit the sign-in code.");
      } finally {
        setSubmittingCode(false);
      }
    },
    hostAllowed,
    usingHost: hostAllowed && useHost,
    setUseHost: (value: boolean) => {
      if (value === useHost) return;
      // Leaving the separate flow abandons its attempt; entering it starts a new one.
      if (!value || isolated) cancelCurrent();
      setAttempt(null);
      setStatus(null);
      setError(null);
      setUseHost(value);
    },
    command: attempt?.command,
    status,
    preparing: active && !status && !error,
    error,
    retry: () => { restartRequested.current = true; cancelCurrent(); setGeneration((value) => value + 1); },
    connect: (input = intent) => {
      if (!companyId) throw new Error("Choose a company before connecting.");
      if (isolated && !attempt) throw new Error("Prepare local sign-in before connecting.");
      // Only the separate flow owns a session; never attach one to a host-login connect.
      return aiConnectionsApi.connectLocal(companyId, { ...input, ...(isolated && attempt ? { localSessionId: attempt.sessionId } : {}) });
    },
  };
}
