import * as p from "@clack/prompts";
import pc from "picocolors";
import { isLoopbackHost, type BindMode } from "@paperclipai/shared";
import type { AuthConfig, ServerConfig } from "../config/schema.js";
import { parseHostnameCsv } from "../config/hostnames.js";
import {
  buildCustomServerConfig,
  buildPresetServerConfig,
  inferConfiguredBind,
  type ServerPreset,
} from "../config/server-bind.js";

const TAILNET_BIND_WARNING =
  "No Tailscale address was detected during setup. The saved config will stay on loopback until Tailscale is available or PAPERCLIP_TAILNET_BIND_HOST is set.";

/**
 * The first server question asks how Paperclip will be used, not where it
 * listens (doc/DEPLOYMENT-MODES.md section 4). Login and bind are decided
 * separately: choosing login never widens the listening address.
 */
export type ServerUsageChoice = "local" | "shared" | "unsure" | "advanced";

export type SharedBindChoice = Extract<BindMode, "lan" | "tailnet">;

export const SERVER_USAGE_PROMPT_MESSAGE = "How will you use Paperclip?";

export const LOCAL_ONLY_LOGIN_LATER_COPY =
  "You can enable login later. Your work stays with your account when you do.";

export const SERVER_USAGE_OPTIONS: ReadonlyArray<{ value: ServerUsageChoice; label: string; hint: string }> = [
  {
    value: "local",
    label: "Only on this computer",
    hint: `No login, localhost only. ${LOCAL_ONLY_LOGIN_LATER_COPY}`,
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
];

export const SHARED_BIND_PROMPT_MESSAGE = "How will other devices reach it?";

export const SHARED_BIND_OPTIONS: ReadonlyArray<{ value: SharedBindChoice; label: string; hint: string }> = [
  {
    value: "lan",
    label: "Private network",
    hint: "Listen on all interfaces (0.0.0.0) for LAN, VPN, or legacy --tailscale-auth style access",
  },
  {
    value: "tailnet",
    label: "Tailnet",
    hint: "Listen only on the machine's detected Tailscale address",
  },
];

/**
 * The preset a usage choice maps to. `shared` needs the follow-up bind answer;
 * `advanced` has no preset because it goes through the manual path.
 */
export function serverPresetForUsage(choice: "local" | "unsure"): ServerPreset;
export function serverPresetForUsage(choice: "shared", bind: SharedBindChoice): ServerPreset;
export function serverPresetForUsage(choice: "advanced"): null;
export function serverPresetForUsage(choice: ServerUsageChoice, bind?: SharedBindChoice): ServerPreset | null;
export function serverPresetForUsage(choice: ServerUsageChoice, bind?: SharedBindChoice): ServerPreset | null {
  switch (choice) {
    case "local":
      return { bind: "loopback", requireLogin: false };
    case "unsure":
      return { bind: "loopback", requireLogin: true };
    case "shared":
      return { bind: bind ?? "lan", requireLogin: true };
    case "advanced":
      return null;
  }
}

/** The usage choice that describes an existing config, used to preselect it when reconfiguring. */
export function inferUsageChoice(server?: Partial<ServerConfig>): ServerUsageChoice {
  if (!server?.deploymentMode) return "local";
  const bind = inferConfiguredBind(server);
  if (server.deploymentMode === "local_trusted") return bind === "loopback" ? "local" : "advanced";
  if (server.exposure === "public" || bind === "custom") return "advanced";
  return bind === "loopback" ? "unsure" : "shared";
}

function cancelled(): never {
  p.cancel("Setup cancelled.");
  process.exit(0);
}

async function promptPort(currentServer?: Partial<ServerConfig>): Promise<number> {
  const portStr = await p.text({
    message: "Server port",
    defaultValue: String(currentServer?.port ?? 3100),
    placeholder: "3100",
    validate: (val) => {
      const n = Number(val);
      if (isNaN(n) || n < 1 || n > 65535 || !Number.isInteger(n)) {
        return "Must be an integer between 1 and 65535";
      }
    },
  });

  if (p.isCancel(portStr)) cancelled();
  return Number(portStr) || 3100;
}

async function promptAllowedHostnames(input: {
  currentServer?: Partial<ServerConfig>;
  placeholder: string;
}): Promise<string[]> {
  const allowedHostnamesInput = await p.text({
    message: "Allowed private hostnames (comma-separated, optional)",
    defaultValue: (input.currentServer?.allowedHostnames ?? []).join(", "),
    placeholder: input.placeholder,
    validate: (val) => {
      try {
        parseHostnameCsv(val ?? "");
        return;
      } catch (err) {
        return err instanceof Error ? err.message : "Invalid hostname list";
      }
    },
  });

  if (p.isCancel(allowedHostnamesInput)) cancelled();
  return parseHostnameCsv(allowedHostnamesInput);
}

export async function promptServer(opts?: {
  currentServer?: Partial<ServerConfig>;
  currentAuth?: Partial<AuthConfig>;
}): Promise<{ server: ServerConfig; auth: AuthConfig }> {
  const currentServer = opts?.currentServer;
  const currentAuth = opts?.currentAuth;
  const currentBind = inferConfiguredBind(currentServer);

  const usageSelection = await p.select({
    message: SERVER_USAGE_PROMPT_MESSAGE,
    options: SERVER_USAGE_OPTIONS.map((option) => ({ ...option })),
    initialValue: inferUsageChoice(currentServer),
  });

  if (p.isCancel(usageSelection)) cancelled();
  const usage = usageSelection as ServerUsageChoice;

  if (usage === "local") {
    p.log.message(pc.dim(LOCAL_ONLY_LOGIN_LATER_COPY));
    const port = await promptPort(currentServer);
    return buildPresetServerConfig(serverPresetForUsage("local"), {
      port,
      allowedHostnames: [],
      serveUi: currentServer?.serveUi ?? true,
    });
  }

  if (usage === "unsure") {
    p.log.message(
      pc.dim(
        `Login will be required and the server stays on localhost. Run ${pc.cyan("paperclipai configure --section server")} later to reach it from other devices.`,
      ),
    );
    const port = await promptPort(currentServer);
    return buildPresetServerConfig(serverPresetForUsage("unsure"), {
      port,
      allowedHostnames: [],
      serveUi: currentServer?.serveUi ?? true,
    });
  }

  if (usage === "shared") {
    const bindSelection = await p.select({
      message: SHARED_BIND_PROMPT_MESSAGE,
      options: SHARED_BIND_OPTIONS.map((option) => ({ ...option })),
      initialValue: currentBind === "tailnet" ? "tailnet" : "lan",
    });
    if (p.isCancel(bindSelection)) cancelled();
    const bind = bindSelection as SharedBindChoice;

    const port = await promptPort(currentServer);
    const allowedHostnames = await promptAllowedHostnames({
      currentServer,
      placeholder: bind === "tailnet" ? "your-machine.tailnet.ts.net" : "dotta-macbook-pro, host.docker.internal",
    });

    const preset = buildPresetServerConfig(serverPresetForUsage("shared", bind), {
      port,
      allowedHostnames,
      serveUi: currentServer?.serveUi ?? true,
    });
    if (bind === "tailnet" && isLoopbackHost(preset.server.host)) {
      p.log.warn(TAILNET_BIND_WARNING);
    }
    return preset;
  }

  const port = await promptPort(currentServer);
  const serveUi = currentServer?.serveUi ?? true;

  const deploymentModeSelection = await p.select({
    message: "Auth mode",
    options: [
      {
        value: "local_trusted",
        label: "Local trusted",
        hint: "No login required; only safe with loopback-only or similarly trusted access",
      },
      {
        value: "authenticated",
        label: "Authenticated",
        hint: "Login required; supports both private-network and public deployments",
      },
    ],
    initialValue: currentServer?.deploymentMode ?? "authenticated",
  });

  if (p.isCancel(deploymentModeSelection)) cancelled();
  const deploymentMode = deploymentModeSelection as ServerConfig["deploymentMode"];

  let exposure: ServerConfig["exposure"] = "private";
  if (deploymentMode === "authenticated") {
    const exposureSelection = await p.select({
      message: "Exposure profile",
      options: [
        {
          value: "private",
          label: "Private network",
          hint: "Private access only, with automatic URL handling",
        },
        {
          value: "public",
          label: "Public internet",
          hint: "Internet-facing deployment with explicit public URL requirements",
        },
      ],
      initialValue: currentServer?.exposure ?? "private",
    });
    if (p.isCancel(exposureSelection)) cancelled();
    exposure = exposureSelection as ServerConfig["exposure"];
  }

  const defaultHost =
    currentServer?.customBindHost ??
    currentServer?.host ??
    (deploymentMode === "local_trusted" ? "127.0.0.1" : "0.0.0.0");
  const host = await p.text({
    message: "Bind host",
    defaultValue: defaultHost,
    placeholder: defaultHost,
    validate: (val) => {
      if (!val || !val.trim()) return "Host is required";
      if (deploymentMode === "local_trusted" && !isLoopbackHost(val.trim())) {
        return "Local trusted mode requires a loopback host such as 127.0.0.1";
      }
    },
  });

  if (p.isCancel(host)) cancelled();

  let allowedHostnames: string[] = [];
  if (deploymentMode === "authenticated" && exposure === "private") {
    allowedHostnames = await promptAllowedHostnames({
      currentServer,
      placeholder: "dotta-macbook-pro, your-host.tailnet.ts.net",
    });
  }

  let publicBaseUrl: string | undefined;
  if (deploymentMode === "authenticated" && exposure === "public") {
    const urlInput = await p.text({
      message: "Public base URL",
      defaultValue: currentAuth?.publicBaseUrl ?? "",
      placeholder: "https://paperclip.example.com",
      validate: (val) => {
        const candidate = val?.trim() ?? "";
        if (!candidate) return "Public base URL is required for public exposure";
        try {
          const url = new URL(candidate);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            return "URL must start with http:// or https://";
          }
          return;
        } catch {
          return "Enter a valid URL";
        }
      },
    });
    if (p.isCancel(urlInput)) cancelled();
    publicBaseUrl = urlInput.trim().replace(/\/+$/, "");
  }

  return buildCustomServerConfig({
    deploymentMode,
    exposure,
    host: host.trim(),
    port,
    allowedHostnames,
    serveUi,
    publicBaseUrl,
  });
}
