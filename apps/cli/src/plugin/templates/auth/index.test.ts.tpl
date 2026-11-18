/**
 * The __TITLE__ auth provider: the person a known key belongs to, under the
 * provider's name; nobody for no key or an unknown one; no provider at all
 * when its setting is missing or malformed.
 */
import { describe, expect, test } from "bun:test";
import { __EXPORT__ } from "./index.ts";

/** The provider built with `keys` as its setting. */
function build(keys: string | undefined) {
  return __EXPORT__().build({ env: { __CONSTANT___KEYS: keys }, log: () => {} });
}

/** A request carrying `authorization`. */
const request = (authorization?: string) => new Request("http://localhost/", authorization === undefined ? {} : { headers: { authorization } });

describe("__NAME__", () => {
  test("knows who a key belongs to", async () => {
    const authenticate = build("k1=ada, k2=bob");
    expect(await authenticate(request("Bearer k2"))).toEqual({ id: "bob", provider: "__NAME__" });
  });

  test("knows nobody without a key, or with one nobody has", async () => {
    const authenticate = build("k1=ada");
    expect(await authenticate(request())).toBeNull();
    expect(await authenticate(request("Bearer nope"))).toBeNull();
    expect(await authenticate(request("Basic k1"))).toBeNull();
  });

  test("doesn't build without its setting, or with a malformed one", () => {
    expect(() => build(undefined)).toThrow("__CONSTANT___KEYS is not set");
    expect(() => build("k1")).toThrow('__CONSTANT___KEYS: "k1" isn\'t key=id');
  });
});
