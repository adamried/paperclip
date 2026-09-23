import os from "node:os";
import path from "node:path";

/**
 * PATH for child processes that need per-user developer tools (claude, codex,
 * gh, pnpm, cargo). A service manager starts Paperclip with a minimal
 * environment, so the directories an interactive shell would have are added
 * ahead of whatever PATH the process inherited.
 */
export function hostToolchainPath(): string {
  const home = os.homedir();
  const extra = [
    path.dirname(process.execPath),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/opt/rustup/bin",
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return [...new Set([...extra, ...current])].join(path.delimiter);
}
