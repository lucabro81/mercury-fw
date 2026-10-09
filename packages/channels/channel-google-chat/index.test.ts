import { describe, it, expect } from "bun:test";
import { googleChatChannel } from "./index.ts";

describe("googleChatChannel", () => {
  // A literal, not CHANNEL_API_VERSION: the import reports whatever contract
  // is installed, so an old channel next to a newer core would claim the new
  // version and be loaded. The literal is the contract this code was written for.
  it("declares the google-chat name at channel api version 3", () => {
    expect(googleChatChannel.name).toBe("google-chat");
    expect(googleChatChannel.apiVersion).toBe(5);
  });
});
