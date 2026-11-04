import type { TestProject } from "vite-plus/test/node";
import { startVaultwarden } from "../src/index.ts";

declare module "vite-plus/test" {
  interface ProvidedContext {
    vaultwarden: { url: string; caCertPath: string };
  }
}

/** One Vaultwarden for the whole integration run; test files register their own accounts. */
export default async function setup(project: TestProject) {
  const vaultwarden = await startVaultwarden();
  project.provide("vaultwarden", { url: vaultwarden.url, caCertPath: vaultwarden.caCertPath });
  return () => vaultwarden.stop();
}
