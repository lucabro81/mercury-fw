import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@mercury-fw/channel-types";
import { createLinkStore } from "./links.ts";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-links-"));
  dirs.push(dir);
  return join(dir, ".mercury", "identity-links.json");
}

const alice = { id: "alice", provider: "static" as const };

describe("createLinkStore", () => {
  test("knows no link before anything is written, and no file is needed for that", async () => {
    const store = createLinkStore({ path: await tempPath() });
    expect(store.ownerOf("google-chat:users/1")).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  test("a link names the identity's owner, and survives a new store on the same file", async () => {
    const path = await tempPath();
    const store = createLinkStore({ path, now: () => new Date("2026-10-09T10:00:00Z") });
    store.link("google-chat:users/1", alice);
    expect(store.ownerOf("google-chat:users/1")).toEqual(alice);
    const again = createLinkStore({ path });
    expect(again.ownerOf("google-chat:users/1")).toEqual(alice);
    expect(again.list()).toEqual([{ identity: "google-chat:users/1", owner: alice, linkedAt: "2026-10-09T10:00:00.000Z" }]);
  });

  test("keeps only who the owner is, never what else the principal carried", async () => {
    const path = await tempPath();
    const full: Principal = { ...alice, displayName: "Alice", claims: { email: "a@x" } };
    createLinkStore({ path }).link("google-chat:users/1", full);
    expect(JSON.parse(await readFile(path, "utf8")).links["google-chat:users/1"].owner).toEqual(alice);
  });

  test("linking an identity again moves it; unlinking removes it, once", async () => {
    const store = createLinkStore({ path: await tempPath() });
    store.link("google-chat:users/1", alice);
    store.link("google-chat:users/1", { id: "bob", provider: "static" });
    expect(store.ownerOf("google-chat:users/1")).toEqual({ id: "bob", provider: "static" });
    expect(store.unlink("google-chat:users/1")).toBe(true);
    expect(store.unlink("google-chat:users/1")).toBe(false);
    expect(store.ownerOf("google-chat:users/1")).toBeUndefined();
  });

  // `mfw identity` changes the file from a one-off container while the
  // service runs: the service has to see it without a restart.
  test("rereads the file when another process changed it", async () => {
    const path = await tempPath();
    const service = createLinkStore({ path });
    expect(service.ownerOf("google-chat:users/1")).toBeUndefined();
    await Bun.sleep(5);
    createLinkStore({ path }).link("google-chat:users/1", alice);
    expect(service.ownerOf("google-chat:users/1")).toEqual(alice);
    await Bun.sleep(5);
    createLinkStore({ path }).unlink("google-chat:users/1");
    expect(service.ownerOf("google-chat:users/1")).toBeUndefined();
  });

  // An unreadable file joins nobody: each identity is then on its own, which
  // never gives anyone more than they had.
  test("an unreadable file is no links, and says so", async () => {
    const path = await tempPath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "not json");
    const logs: string[] = [];
    const store = createLinkStore({ path, log: (m) => logs.push(m) });
    expect(store.ownerOf("google-chat:users/1")).toBeUndefined();
    expect(logs).toEqual([`[identity] can't read the account links in ${path}, none applied: not JSON`]);
  });

  test("an inherited key is never a link", async () => {
    const store = createLinkStore({ path: await tempPath() });
    expect(store.ownerOf("constructor")).toBeUndefined();
    expect(store.ownerOf("__proto__")).toBeUndefined();
  });
});
