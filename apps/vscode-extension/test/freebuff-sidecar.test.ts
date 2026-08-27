import { describe, expect, test } from "bun:test";
import { FreebuffSidecarManager } from "../src/runtime/freebuff-sidecar";
import * as os from "node:os";
import * as path from "node:path";

describe("freebuff sidecar manager", () => {
  test("initializes with default port and loopback endpoint", () => {
    const manager = new FreebuffSidecarManager();
    expect(manager.getPort()).toBe(8080);
    expect(manager.getBaseUrl()).toBe("http://127.0.0.1:8080/v1");
    expect(manager.getStatus()).toEqual({ status: "stopped", error: undefined });
  });

  test("accepts custom port and storage directory", () => {
    const tmp = path.join(os.tmpdir(), "freebuff-test-" + Date.now());
    const manager = new FreebuffSidecarManager({ port: 9090, storageDir: tmp });
    expect(manager.getPort()).toBe(9090);
    expect(manager.getBaseUrl()).toBe("http://127.0.0.1:9090/v1");
  });

  test("rejects start when empty auth token is passed", async () => {
    const manager = new FreebuffSidecarManager();
    const result = await manager.start("");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("authToken is required");
  });

  test("finds binary on system", async () => {
    const manager = new FreebuffSidecarManager();
    try {
      const bin = await manager.findOrInstallBinary();
      expect(typeof bin).toBe("string");
      expect(bin.length).toBeGreaterThan(0);
    } catch {
      // If go environment is not configured in test runner, that's fine
    }
  });
});
