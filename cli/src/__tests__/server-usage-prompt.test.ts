/**
 * Identity-first onboarding (doc/DEPLOYMENT-MODES.md section 4): the first
 * server question asks how Paperclip will be used, and login is decided
 * separately from where the server listens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prompts from "@clack/prompts";
import {
  inferUsageChoice,
  LOCAL_ONLY_LOGIN_LATER_COPY,
  promptServer,
  SERVER_USAGE_OPTIONS,
  SERVER_USAGE_PROMPT_MESSAGE,
  serverPresetForUsage,
  SHARED_BIND_OPTIONS,
  SHARED_BIND_PROMPT_MESSAGE,
} from "../prompts/server.js";

vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    message: vi.fn(),
    warn: vi.fn(),
  },
}));

const ORIGINAL_PATH = process.env.PATH;

type SelectCall = { message: string; options: unknown[]; initialValue?: string };

function selectCall(index: number): SelectCall {
  return vi.mocked(prompts.select).mock.calls[index]?.[0] as SelectCall;
}

describe("server usage prompt copy", () => {
  it("asks how Paperclip will be used, with the four documented choices", () => {
    expect(SERVER_USAGE_PROMPT_MESSAGE).toBe("How will you use Paperclip?");
    expect(LOCAL_ONLY_LOGIN_LATER_COPY).toBe(
      "You can enable login later. Your work stays with your account when you do.",
    );
    expect(SERVER_USAGE_OPTIONS).toEqual([
      {
        value: "local",
        label: "Only on this computer",
        hint: "No login, localhost only. You can enable login later. Your work stays with your account when you do.",
      },
      {
        value: "shared",
        label: "Other devices, teammates, or a remote assistant",
        hint: "Login required. You choose how it is reached next (private network or Tailscale).",
      },
      {
        value: "unsure",
        label: "Not sure yet",
        hint: "Login required, localhost only. Open it up to other devices later without losing anything.",
      },
      {
        value: "advanced",
        label: "Advanced",
        hint: "Choose exact auth mode, exposure, and host manually",
      },
    ]);
    expect(SHARED_BIND_PROMPT_MESSAGE).toBe("How will other devices reach it?");
    expect(SHARED_BIND_OPTIONS.map((option) => option.value)).toEqual(["lan", "tailnet"]);
  });

  it("maps each choice to a preset", () => {
    expect(serverPresetForUsage("local")).toEqual({ bind: "loopback", requireLogin: false });
    expect(serverPresetForUsage("unsure")).toEqual({ bind: "loopback", requireLogin: true });
    expect(serverPresetForUsage("shared", "lan")).toEqual({ bind: "lan", requireLogin: true });
    expect(serverPresetForUsage("shared", "tailnet")).toEqual({ bind: "tailnet", requireLogin: true });
    expect(serverPresetForUsage("advanced")).toBeNull();
  });

  it("preselects the choice that describes an existing config", () => {
    expect(inferUsageChoice(undefined)).toBe("local");
    expect(inferUsageChoice({ deploymentMode: "local_trusted", bind: "loopback", exposure: "private" })).toBe("local");
    expect(inferUsageChoice({ deploymentMode: "authenticated", bind: "loopback", exposure: "private" })).toBe("unsure");
    expect(inferUsageChoice({ deploymentMode: "authenticated", bind: "lan", exposure: "private" })).toBe("shared");
    expect(inferUsageChoice({ deploymentMode: "authenticated", bind: "tailnet", exposure: "private" })).toBe("shared");
    expect(inferUsageChoice({ deploymentMode: "authenticated", host: "10.0.0.5", exposure: "private" })).toBe("advanced");
    expect(inferUsageChoice({ deploymentMode: "authenticated", bind: "loopback", exposure: "public" })).toBe("advanced");
  });
});

describe("promptServer", () => {
  beforeEach(() => {
    vi.mocked(prompts.select).mockReset();
    vi.mocked(prompts.text).mockReset();
    vi.mocked(prompts.log.message).mockReset();
    vi.mocked(prompts.log.warn).mockReset();
    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
  });

  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH;
    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
  });

  it("Only on this computer -> local_trusted on loopback, and says login can come later", async () => {
    vi.mocked(prompts.select).mockResolvedValueOnce("local");
    vi.mocked(prompts.text).mockResolvedValueOnce("3100");

    const { server, auth } = await promptServer();

    expect(selectCall(0).message).toBe("How will you use Paperclip?");
    expect(selectCall(0).options).toEqual(SERVER_USAGE_OPTIONS);
    expect(selectCall(0).initialValue).toBe("local");
    expect(server).toMatchObject({
      deploymentMode: "local_trusted",
      exposure: "private",
      bind: "loopback",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
    });
    expect(auth).toEqual({ baseUrlMode: "auto", disableSignUp: false });
    const messages = vi.mocked(prompts.log.message).mock.calls.map(([line]) => String(line));
    expect(messages.some((line) => line.includes(LOCAL_ONLY_LOGIN_LATER_COPY))).toBe(true);
    // No bind or hostname question for a local-only install.
    expect(prompts.select).toHaveBeenCalledTimes(1);
    expect(prompts.text).toHaveBeenCalledTimes(1);
  });

  it("Not sure yet -> authenticated/private on loopback: login without widening the bind", async () => {
    vi.mocked(prompts.select).mockResolvedValueOnce("unsure");
    vi.mocked(prompts.text).mockResolvedValueOnce("3100");

    const { server } = await promptServer();

    expect(server).toMatchObject({
      deploymentMode: "authenticated",
      exposure: "private",
      bind: "loopback",
      host: "127.0.0.1",
      allowedHostnames: [],
    });
    expect(prompts.select).toHaveBeenCalledTimes(1);
    expect(prompts.text).toHaveBeenCalledTimes(1);
  });

  it("Other devices -> asks how they reach it; private network binds all interfaces with login", async () => {
    vi.mocked(prompts.select).mockResolvedValueOnce("shared").mockResolvedValueOnce("lan");
    vi.mocked(prompts.text)
      .mockResolvedValueOnce("3200")
      .mockResolvedValueOnce("dotta-macbook-pro, host.docker.internal");

    const { server } = await promptServer();

    expect(selectCall(1).message).toBe("How will other devices reach it?");
    expect(selectCall(1).options).toEqual(SHARED_BIND_OPTIONS);
    expect(selectCall(1).initialValue).toBe("lan");
    expect(server).toMatchObject({
      deploymentMode: "authenticated",
      exposure: "private",
      bind: "lan",
      host: "0.0.0.0",
      port: 3200,
      allowedHostnames: ["dotta-macbook-pro", "host.docker.internal"],
    });
  });

  it("Other devices over tailnet uses the detected Tailscale address", async () => {
    process.env.PAPERCLIP_TAILNET_BIND_HOST = "100.64.0.8";
    vi.mocked(prompts.select).mockResolvedValueOnce("shared").mockResolvedValueOnce("tailnet");
    vi.mocked(prompts.text).mockResolvedValueOnce("3100").mockResolvedValueOnce("");

    const { server } = await promptServer();

    expect(server).toMatchObject({
      deploymentMode: "authenticated",
      exposure: "private",
      bind: "tailnet",
      host: "100.64.0.8",
    });
    expect(prompts.log.warn).not.toHaveBeenCalled();
  });

  it("Other devices over tailnet falls back to loopback with the existing warning when Tailscale is missing", async () => {
    process.env.PATH = "";
    vi.mocked(prompts.select).mockResolvedValueOnce("shared").mockResolvedValueOnce("tailnet");
    vi.mocked(prompts.text).mockResolvedValueOnce("3100").mockResolvedValueOnce("");

    const { server } = await promptServer();

    expect(server).toMatchObject({ deploymentMode: "authenticated", bind: "tailnet", host: "127.0.0.1" });
    expect(prompts.log.warn).toHaveBeenCalledWith(expect.stringContaining("No Tailscale address was detected"));
  });

  it("Advanced -> the existing manual path (auth mode, exposure, host)", async () => {
    vi.mocked(prompts.select)
      .mockResolvedValueOnce("advanced")
      .mockResolvedValueOnce("authenticated")
      .mockResolvedValueOnce("public");
    vi.mocked(prompts.text)
      .mockResolvedValueOnce("3100")
      .mockResolvedValueOnce("0.0.0.0")
      .mockResolvedValueOnce("https://paperclip.example.com/");

    const { server, auth } = await promptServer();

    expect(vi.mocked(prompts.select).mock.calls.map(([call]) => (call as SelectCall).message)).toEqual([
      "How will you use Paperclip?",
      "Auth mode",
      "Exposure profile",
    ]);
    expect(server).toMatchObject({
      deploymentMode: "authenticated",
      exposure: "public",
      bind: "lan",
      host: "0.0.0.0",
    });
    expect(auth).toEqual({
      baseUrlMode: "explicit",
      disableSignUp: false,
      publicBaseUrl: "https://paperclip.example.com",
    });
  });

  it("preselects the current choice when reconfiguring an authenticated loopback instance", async () => {
    vi.mocked(prompts.select).mockResolvedValueOnce("unsure");
    vi.mocked(prompts.text).mockResolvedValueOnce("3100");

    await promptServer({
      currentServer: {
        deploymentMode: "authenticated",
        exposure: "private",
        bind: "loopback",
        host: "127.0.0.1",
        port: 3100,
        allowedHostnames: [],
        serveUi: true,
      },
    });

    expect(selectCall(0).initialValue).toBe("unsure");
  });
});
