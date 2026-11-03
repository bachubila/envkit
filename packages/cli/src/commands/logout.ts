import { defineCommand } from "citty";
import { useContext } from "../context.ts";

export const logout = defineCommand({
  meta: {
    name: "logout",
    description: "Log out of the vault",
  },
  async run() {
    const context = useContext();
    await (await context.sessions()).clear();
    await context.backend().logout();
    context.output.stdout("Logged out.");
  },
});
