import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { hashPassword } from "./auth.js";
import { Database } from "./database.js";

type UserRow = { id: string; username: string };
type Key = { ctrl?: boolean; meta?: boolean; name?: string };

function promptHidden(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) {
    throw new Error("This command requires an interactive terminal.");
  }

  stdout.write(label);
  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    };

    const onKeypress = (text: string, key: Key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        stdout.write("\n");
        reject(new Error("Password reset cancelled."));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        stdout.write("\n");
        resolve(value);
        return;
      }
      if (key.name === "backspace") {
        value = value.slice(0, -1);
        return;
      }
      if (!key.ctrl && !key.meta && text) value += text;
    };

    stdin.on("keypress", onKeypress);
  });
}

async function main() {
  const dataDir = path.resolve(process.env.FLOWARR_DATA_DIR ?? "./data");
  const database = new Database(dataDir);

  try {
    const users = database.raw
      .prepare("SELECT id, username FROM users ORDER BY username")
      .all() as UserRow[];

    if (users.length === 0) throw new Error("No administrator account exists yet.");

    const requestedUsername = process.argv[2];
    const user = requestedUsername
      ? users.find((candidate) => candidate.username === requestedUsername)
      : users.length === 1
        ? users[0]
        : undefined;

    if (!user) {
      if (requestedUsername) throw new Error(`Unknown user: ${requestedUsername}`);
      const names = users.map(({ username }) => username).join(", ");
      throw new Error(`Several users exist (${names}). Run: pnpm reset-password -- <username>`);
    }

    stdout.write(`Resetting password for ${user.username}.\n`);
    const password = await promptHidden("New password (12 characters minimum): ");
    const confirmation = await promptHidden("Confirm new password: ");
    if (password !== confirmation) throw new Error("Passwords do not match.");

    const passwordHash = hashPassword(password);
    database.raw.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);
    stdout.write(`Password updated for ${user.username}.\n`);
  } finally {
    database.raw.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Password reset failed: ${message}\n`);
  process.exitCode = 1;
});
