/* Runs a probe under this package's virtualenv.
   Resolved to an absolute path on purpose: Windows CreateProcess will not
   accept ".venv/Scripts/python.exe" with forward slashes. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const py = [resolve(root, ".venv/Scripts/python.exe"), resolve(root, ".venv/bin/python")].find(existsSync);

if (!py) {
  console.error("no virtualenv in arena/interop. See README.md for setup.");
  process.exit(1);
}

try {
  execFileSync(py, process.argv.slice(2), { cwd: root, stdio: "inherit" });
} catch (e) {
  process.exit(e.status ?? 1);
}
