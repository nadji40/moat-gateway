// Which gateway binary a run gets, and when it is refused.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertCurrent, gatewayBinary, gatewayBuild } from "./gateway.js";

const NAME = process.platform === "win32" ? "moat-gateway.exe" : "moat-gateway";
const HOUR = 3_600_000;

/** A repo-shaped temp directory: `arena/`, `target/<profile>/`, `crates/`. */
function repo(): { root: string; arena: string; release: string; debug: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), "moat-gateway-pick-"));
  const arena = join(root, "arena");
  const release = join(root, "target", "release", NAME);
  const debug = join(root, "target", "debug", NAME);
  const source = join(root, "crates", "moat-core", "src", "lib.rs");
  for (const file of [release, debug, source]) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "");
  }
  mkdirSync(arena);
  return { root, arena, release, debug, source };
}

function builtAt(file: string, ms: number): void {
  utimesSync(file, new Date(ms), new Date(ms));
}

describe("choosing the gateway binary", () => {
  const saved = { bin: process.env["MOAT_GATEWAY_BIN"], stale: process.env["MOAT_ALLOW_STALE_GATEWAY"] };
  let r: ReturnType<typeof repo>;
  const now = Date.now();

  beforeEach(() => {
    delete process.env["MOAT_GATEWAY_BIN"];
    delete process.env["MOAT_ALLOW_STALE_GATEWAY"];
    r = repo();
  });
  afterEach(() => {
    rmSync(r.root, { recursive: true, force: true });
    if (saved.bin === undefined) delete process.env["MOAT_GATEWAY_BIN"];
    else process.env["MOAT_GATEWAY_BIN"] = saved.bin;
    if (saved.stale === undefined) delete process.env["MOAT_ALLOW_STALE_GATEWAY"];
    else process.env["MOAT_ALLOW_STALE_GATEWAY"] = saved.stale;
  });

  it("takes the newest build, not the release one", () => {
    builtAt(r.source, now - 3 * HOUR);
    builtAt(r.release, now - 24 * HOUR);
    builtAt(r.debug, now - 1 * HOUR);
    const build = gatewayBuild(r.arena);
    expect(build.path).toBe(r.debug);
    expect(build.chosen).toBe("newest-build");
    expect(build.stale).toBe(false);
    expect(gatewayBinary(r.arena)).toBe(r.debug);
  });

  it("refuses a build older than the newest source change", () => {
    builtAt(r.release, now - 24 * HOUR);
    builtAt(r.debug, now - 5 * HOUR);
    builtAt(r.source, now - 1 * HOUR);
    expect(gatewayBuild(r.arena).stale).toBe(true);
    expect(() => gatewayBinary(r.arena)).toThrow(/built .* before the newest source change/);
    process.env["MOAT_ALLOW_STALE_GATEWAY"] = "1";
    expect(gatewayBinary(r.arena)).toBe(r.debug);
  });

  it("runs a binary named on purpose, and still says it is stale", () => {
    builtAt(r.release, now - 24 * HOUR);
    builtAt(r.debug, now - 5 * HOUR);
    builtAt(r.source, now - 1 * HOUR);
    process.env["MOAT_GATEWAY_BIN"] = r.release;
    const build = gatewayBuild(r.arena);
    expect(build.path).toBe(r.release);
    expect(build.chosen).toBe("env");
    expect(build.stale).toBe(true);
    expect(assertCurrent(build).path).toBe(r.release);
    expect(gatewayBinary(r.arena)).toBe(r.release);
  });

  it("says where it looked when there is nothing to run", () => {
    rmSync(join(r.root, "target"), { recursive: true, force: true });
    expect(() => gatewayBinary(r.arena)).toThrow(/not found .*cargo build -p moat-gateway/);
  });
});
