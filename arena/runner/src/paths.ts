// Where the arena is on disk. Its own file so that the rail registry and
// the run context can both have it without importing each other.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The arena directory, which is also the web root the mocks serve. */
export const ARENA_ROOT = resolve(here, "..", "..");
