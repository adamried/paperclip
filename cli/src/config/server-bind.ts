import { execFileSync } from "node:child_process";
import {
  ALL_INTERFACES_BIND_HOST,
  LOOPBACK_BIND_HOST,
  inferBindModeFromHost,
  isAllInterfacesHost,
  isLoopbackHost,
  type BindMode,
  type DeploymentExposure,
  type DeploymentMode,
} from "@paperclipai/shared";
import type { AuthConfig, ServerConfig } from "./schema.js";

const TAILSCALE_DETECT_TIMEOUT_MS = 3000;

type BaseServerInput = {
  port: number;
  allowedHostnames: string[];
  serveUi: boolean;
};

export function inferConfiguredBind(server?: Partial<ServerConfig>): BindMode {
  if (server?.bind) return server.bind;
  return inferBindModeFromHost(server?.customBindHost ?? server?.host);
}

export function detectTailnetBindHost(): string | undefined {
  const explicit = process.env.PAPERCLIP_TAILNET_BIND_HOST?.trim();
  if (explicit) return explicit;

  try {
    const stdout = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TAILSCALE_DETECT_TIMEOUT_MS,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

export type PresetBind = Exclude<BindMode, "custom">;

/**
 * A server preset: where the server listens and whether a login is required.
 *
 * The two are independent (doc/DEPLOYMENT-MODES.md section 3): `loopback`
 * works with or without login, while `lan` and `tailnet` always require it
 * because `local_trusted` is only safe on loopback. The bare bind-name form
 * keeps the three historical presets unchanged: `loopback` means no login,
 * `lan` and `tailnet` mean login.
 */
export type ServerPreset = {
  bind: PresetBind;
  /** Defaults to `bind !== "loopback"`, which is the historical behaviour. */
  requireLogin?: boolean;
};

export function resolveServerPreset(preset: PresetBind | ServerPreset): Required<ServerPreset> {
  const bind = typeof preset === "string" ? preset : preset.bind;
  const requireLogin = typeof preset === "string" ? bind !== "loopback" : (preset.requireLogin ?? bind !== "loopback");
  if (!requireLogin && bind !== "loopback") {
    throw new Error(`Login is required for bind=${bind}: local_trusted mode is only safe on loopback.`);
  }
  return { bind, requireLogin };
}

export function buildPresetServerConfig(
  preset: PresetBind | ServerPreset,
  input: BaseServerInput,
): { server: ServerConfig; auth: AuthConfig } {
  const { bind, requireLogin } = resolveServerPreset(preset);
  const host =
    bind === "loopback"
      ? LOOPBACK_BIND_HOST
      : bind === "tailnet"
        ? (detectTailnetBindHost() ?? LOOPBACK_BIND_HOST)
        : ALL_INTERFACES_BIND_HOST;

  return {
    server: {
      deploymentMode: requireLogin ? "authenticated" : "local_trusted",
      exposure: "private",
      bind,
      customBindHost: undefined,
      host,
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
  };
}

export function buildCustomServerConfig(input: BaseServerInput & {
  deploymentMode: DeploymentMode;
  exposure: DeploymentExposure;
  host: string;
  publicBaseUrl?: string;
}): { server: ServerConfig; auth: AuthConfig } {
  const normalizedHost = input.host.trim();
  const bind = isLoopbackHost(normalizedHost)
    ? "loopback"
    : isAllInterfacesHost(normalizedHost)
      ? "lan"
      : "custom";

  return {
    server: {
      deploymentMode: input.deploymentMode,
      exposure: input.deploymentMode === "local_trusted" ? "private" : input.exposure,
      bind,
      customBindHost: bind === "custom" ? normalizedHost : undefined,
      host: normalizedHost,
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
    },
    auth:
      input.deploymentMode === "authenticated" && input.exposure === "public"
        ? {
          baseUrlMode: "explicit",
          disableSignUp: false,
          publicBaseUrl: input.publicBaseUrl,
        }
        : {
          baseUrlMode: "auto",
          disableSignUp: false,
        },
  };
}

export function resolveQuickstartServerConfig(input: {
  bind?: BindMode | null;
  deploymentMode?: DeploymentMode | null;
  exposure?: DeploymentExposure | null;
  host?: string | null;
  port: number;
  allowedHostnames: string[];
  serveUi: boolean;
  publicBaseUrl?: string;
}): { server: ServerConfig; auth: AuthConfig } {
  const trimmedHost = input.host?.trim();
  const explicitBind = input.bind ?? null;

  if (explicitBind === "loopback" || explicitBind === "lan" || explicitBind === "tailnet") {
    return buildPresetServerConfig(explicitBind, {
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
    });
  }

  if (explicitBind === "custom") {
    return buildCustomServerConfig({
      deploymentMode: input.deploymentMode ?? "authenticated",
      exposure: input.exposure ?? "private",
      host: trimmedHost || LOOPBACK_BIND_HOST,
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
      publicBaseUrl: input.publicBaseUrl,
    });
  }

  if (trimmedHost) {
    return buildCustomServerConfig({
      deploymentMode: input.deploymentMode ?? (isLoopbackHost(trimmedHost) ? "local_trusted" : "authenticated"),
      exposure: input.exposure ?? "private",
      host: trimmedHost,
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
      publicBaseUrl: input.publicBaseUrl,
    });
  }

  if (input.deploymentMode === "authenticated") {
    if (input.exposure === "public") {
      return buildCustomServerConfig({
        deploymentMode: "authenticated",
        exposure: "public",
        host: ALL_INTERFACES_BIND_HOST,
        port: input.port,
        allowedHostnames: input.allowedHostnames,
        serveUi: input.serveUi,
        publicBaseUrl: input.publicBaseUrl,
      });
    }

    return buildPresetServerConfig("lan", {
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
    });
  }

  return buildPresetServerConfig("loopback", {
    port: input.port,
    allowedHostnames: input.allowedHostnames,
    serveUi: input.serveUi,
  });
}
