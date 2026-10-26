import { describe, expect, it } from "vitest";
import { resolveRuntimeBind, validateConfiguredBindMode } from "@paperclipai/shared";
import { buildPresetServerConfig, resolveQuickstartServerConfig } from "../config/server-bind.js";

const ORIGINAL_PATH = process.env.PATH;

describe("network bind helpers", () => {
  it("rejects non-loopback bind modes in local_trusted", () => {
    expect(
      validateConfiguredBindMode({
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bind: "lan",
        host: "0.0.0.0",
      }),
    ).toContain("local_trusted requires server.bind=loopback");
  });

  it("resolves tailnet bind using the detected tailscale address", () => {
    const resolved = resolveRuntimeBind({
      bind: "tailnet",
      host: "127.0.0.1",
      tailnetBindHost: "100.64.0.8",
    });

    expect(resolved.errors).toEqual([]);
    expect(resolved.host).toBe("100.64.0.8");
  });

  it("requires a custom bind host when bind=custom", () => {
    const resolved = resolveRuntimeBind({
      bind: "custom",
      host: "127.0.0.1",
    });

    expect(resolved.errors).toContain("server.customBindHost is required when server.bind=custom");
  });

  describe("buildPresetServerConfig decouples login from bind", () => {
    const input = { port: 3100, allowedHostnames: [], serveUi: true };

    it("keeps the loopback preset on local_trusted without login", () => {
      for (const preset of ["loopback", { bind: "loopback" }, { bind: "loopback", requireLogin: false }] as const) {
        const { server, auth } = buildPresetServerConfig(preset, input);
        expect(server).toMatchObject({
          deploymentMode: "local_trusted",
          exposure: "private",
          bind: "loopback",
          host: "127.0.0.1",
        });
        expect(auth).toEqual({ baseUrlMode: "auto", disableSignUp: false });
      }
    });

    it("supports authenticated/private on loopback: login never widens the listening address", () => {
      const { server, auth } = buildPresetServerConfig({ bind: "loopback", requireLogin: true }, input);
      expect(server).toMatchObject({
        deploymentMode: "authenticated",
        exposure: "private",
        bind: "loopback",
        host: "127.0.0.1",
        customBindHost: undefined,
      });
      expect(auth).toEqual({ baseUrlMode: "auto", disableSignUp: false });
    });

    it("keeps the lan preset on authenticated/private across all interfaces", () => {
      for (const preset of ["lan", { bind: "lan" }, { bind: "lan", requireLogin: true }] as const) {
        const { server } = buildPresetServerConfig(preset, input);
        expect(server).toMatchObject({
          deploymentMode: "authenticated",
          exposure: "private",
          bind: "lan",
          host: "0.0.0.0",
        });
      }
    });

    it("keeps the tailnet preset on authenticated/private using the detected address", () => {
      process.env.PAPERCLIP_TAILNET_BIND_HOST = "100.64.0.8";
      try {
        for (const preset of ["tailnet", { bind: "tailnet" }, { bind: "tailnet", requireLogin: true }] as const) {
          const { server } = buildPresetServerConfig(preset, input);
          expect(server).toMatchObject({
            deploymentMode: "authenticated",
            exposure: "private",
            bind: "tailnet",
            host: "100.64.0.8",
          });
        }
      } finally {
        delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
      }
    });

    it("refuses local_trusted on a non-loopback bind", () => {
      expect(() => buildPresetServerConfig({ bind: "lan", requireLogin: false }, input)).toThrow(
        /local_trusted mode is only safe on loopback/,
      );
      expect(() => buildPresetServerConfig({ bind: "tailnet", requireLogin: false }, input)).toThrow(
        /local_trusted mode is only safe on loopback/,
      );
    });

    it("keeps the --yes quickstart default on local_trusted loopback", () => {
      const { server } = resolveQuickstartServerConfig({ port: 3100, allowedHostnames: [], serveUi: true });
      expect(server).toMatchObject({
        deploymentMode: "local_trusted",
        exposure: "private",
        bind: "loopback",
        host: "127.0.0.1",
      });
    });
  });

  it("stores the detected tailscale address for tailnet presets", () => {
    process.env.PAPERCLIP_TAILNET_BIND_HOST = "100.64.0.8";

    const preset = buildPresetServerConfig("tailnet", {
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    });

    expect(preset.server.host).toBe("100.64.0.8");

    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
  });

  it("falls back to loopback when no tailscale address is available for tailnet presets", () => {
    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
    process.env.PATH = "";

    try {
      const preset = buildPresetServerConfig("tailnet", {
        port: 3100,
        allowedHostnames: [],
        serveUi: true,
      });

      expect(preset.server.host).toBe("127.0.0.1");
    } finally {
      process.env.PATH = ORIGINAL_PATH;
    }
  });
});
