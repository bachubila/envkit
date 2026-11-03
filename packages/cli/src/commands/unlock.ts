import { defineCommand } from "citty";
import { useContext } from "../context.ts";
import { currentSession, requireLogin, sessionNote, unlockVault } from "../session.ts";

export const unlock = defineCommand({
  meta: {
    name: "unlock",
    description: "Unlock the vault with your master password",
  },
  async run() {
    const context = useContext();
    const status = await requireLogin(context);
    if (await currentSession(context, status)) {
      context.output.stdout("Vault is already unlocked.");
      return;
    }
    await unlockVault(context, status);
    context.output.stdout("Vault unlocked.");
    context.output.stdout(await sessionNote(context));
  },
});
