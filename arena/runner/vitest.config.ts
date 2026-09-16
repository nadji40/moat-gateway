import { defineConfig } from "vitest/config";

// Two of the test files start a gateway that binds the intent API on 7072
// and mock-web on 7100. Running files in parallel makes them race for those
// ports; one at a time is a few seconds slower and deterministic.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
