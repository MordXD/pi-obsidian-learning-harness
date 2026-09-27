// Alias bare imports to the real installed Pi packages. No dependency stubs.
import { mock } from "bun:test";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
const executable = Bun.which("pi");
if (!executable) throw new Error("Pi must be installed to run extension tests");
const runtimeDirectory = dirname(realpathSync(executable));
for (const name of ["typebox", "@earendil-works/pi-tui", "@earendil-works/pi-coding-agent"]) {
  const realModule = await import(Bun.resolveSync(name, runtimeDirectory));
  mock.module(name, () => realModule);
}
