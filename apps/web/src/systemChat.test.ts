import { describe, expect, it } from "vite-plus/test";

import { isSystemChatWorkspaceRoot } from "./systemChat";

describe("isSystemChatWorkspaceRoot", () => {
  it("matches the expanded System chat folder on every platform", () => {
    expect(isSystemChatWorkspaceRoot("/home/fool/.t3/system-chat")).toBe(true);
    expect(isSystemChatWorkspaceRoot("C:\\Users\\Fool\\.t3\\system-chat")).toBe(true);
    expect(isSystemChatWorkspaceRoot("/home/fool/.t3/system-chat/")).toBe(true);
  });

  it("does not match ordinary projects", () => {
    expect(isSystemChatWorkspaceRoot("/home/fool/code/system-chat")).toBe(false);
    expect(isSystemChatWorkspaceRoot("/home/fool/.t3/system-chat/nested")).toBe(false);
    expect(isSystemChatWorkspaceRoot("C:\\Users\\Fool\\FoolsAdmin")).toBe(false);
  });
});
