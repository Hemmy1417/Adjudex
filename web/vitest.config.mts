import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The suite's baseline contract. The pre-launch suppression threshold is
    // scoped to this address (lib/marketview.ts), so the fixtures that assume
    // "the first twelve markets are test records" only hold when the suite
    // runs AS that deployment. Tests that care about other configurations
    // stub the variable themselves.
    env: { NEXT_PUBLIC_CONTRACT_ADDRESS: "0x0D086bB63a2fDFFF8B0583CEa0705368AA1BB043" },
  },
});
