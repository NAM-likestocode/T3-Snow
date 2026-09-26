import type { ProjectIconOverride } from "@t3tools/contracts";

/**
 * T3-Snow System chat: a built-in place to ask about the machine itself
 * ("why is my disk full?", "install this for me") without picking a project.
 *
 * Underneath it is an ordinary project rooted at an empty folder under the T3
 * home, so threads, providers, remote clients, and mobile all work unchanged.
 * The folder stays empty on purpose: rooting it at the home directory would
 * make file search and indexing crawl the whole drive. Agents still reach the
 * rest of the system through absolute paths.
 */
export const SYSTEM_CHAT_WORKSPACE_ROOT = "~/.t3/system-chat";
export const SYSTEM_CHAT_TITLE = "System";
export const SYSTEM_CHAT_ICON: ProjectIconOverride = {
  kind: "lucide",
  name: "monitor",
  color: "sky",
};

/** The server stores the expanded absolute path, so match on its tail. */
export function isSystemChatWorkspaceRoot(workspaceRoot: string): boolean {
  return /[\\/]\.t3[\\/]system-chat[\\/]?$/.test(workspaceRoot);
}
