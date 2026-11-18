/**
 * The window: whole within its size, the oldest exchanges dropped past it,
 * the newest message always kept, and a report of what went.
 */
import { describe, expect, test } from "bun:test";
import type { ConversationMessage } from "@mercury-fw/kit";
import { createWindow, messageChars } from "./window.ts";

const user = (content: string): ConversationMessage => ({ role: "user", content });
const answer = (content: string): ConversationMessage => ({ role: "assistant", content });

describe("createWindow", () => {
  test("keeps everything within its size, and reports nothing", () => {
    const window = createWindow(100);
    expect(window.add(user("hello"))).toBeUndefined();
    expect(window.add(answer("hi"))).toBeUndefined();
    expect(window.messages()).toEqual([user("hello"), answer("hi")]);
    expect(window.chars()).toBe(7);
  });

  test("drops the oldest exchange past its size, and reports it", () => {
    const window = createWindow(20);
    window.add(user("aaaaaaaaaa"));
    window.add(answer("bbbbbbbbbb"));
    const report = window.add(user("cccccccccc"));
    expect(window.messages()).toEqual([user("cccccccccc")]);
    expect(report).toMatchObject({ messages: 2, charsBefore: 30, charsAfter: 10, outcome: "done" });
  });

  test("drops a person's message with the answers after it", () => {
    const window = createWindow(15);
    window.add(answer("xxxxx"));
    window.add(user("aaaaa"));
    window.add(answer("bbbbb"));
    window.add(answer("ccccc"));
    window.add(user("ddddd"));
    expect(window.messages()).toEqual([user("ddddd")]);
  });

  test("never drops the newest message, however long", () => {
    const window = createWindow(5);
    window.add(user("aa"));
    window.add(answer("x".repeat(50)));
    expect(window.messages()).toEqual([answer("x".repeat(50))]);
  });

  test("still has every message added, dropped ones included", () => {
    const window = createWindow(5);
    window.add(user("aaaa"));
    window.add(answer("bbbb"));
    expect(window.added()).toEqual([user("aaaa"), answer("bbbb")]);
  });

  test("replaces the newest answer's text", () => {
    const window = createWindow(100);
    window.add(user("q"));
    window.add(answer("draft"));
    window.add(user("q2"));
    window.replaceLastAnswer("final");
    expect(window.messages()).toEqual([user("q"), answer("final"), user("q2")]);
  });

  test("counts what the context layers put in front of a message", () => {
    expect(messageChars({ role: "user", content: "abc", context: "de" })).toBe(5);
  });
});
