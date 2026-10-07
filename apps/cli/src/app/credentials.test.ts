/**
 * Writing a variable into the app's env file, and reading a service account
 * key file, on temporary folders.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { readServiceAccountKey, setEnvVar } from "./credentials.ts";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mercury-credentials-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("setEnvVar", () => {
  test("replaces the variable's line, leaving every other line as it was", () => {
    const file = join(base, "env");
    writeFileSync(file, "# comment\nOLLAMA_MODEL=qwen\nJIRA_CLI_CONFIG_TAR_B64=old\nJIRA_SITE_URL=https://x\n");
    setEnvVar(file, "JIRA_CLI_CONFIG_TAR_B64", "new");
    expect(readFileSync(file, "utf-8")).toBe("# comment\nOLLAMA_MODEL=qwen\nJIRA_CLI_CONFIG_TAR_B64=new\nJIRA_SITE_URL=https://x\n");
  });

  test("appends it when it isn't there, adding the missing final newline first", () => {
    const file = join(base, "env");
    writeFileSync(file, "OLLAMA_MODEL=qwen");
    setEnvVar(file, "JIRA_CLI_CONFIG_TAR_B64", "new");
    expect(readFileSync(file, "utf-8")).toBe("OLLAMA_MODEL=qwen\nJIRA_CLI_CONFIG_TAR_B64=new\n");
  });

  test("a commented-out line or a longer name isn't the variable", () => {
    const file = join(base, "env");
    writeFileSync(file, "# JIRA_CLI_CONFIG_TAR_B64=x\nJIRA_CLI_CONFIG_TAR_B64_OLD=y\n");
    setEnvVar(file, "JIRA_CLI_CONFIG_TAR_B64", "new");
    expect(readFileSync(file, "utf-8")).toBe("# JIRA_CLI_CONFIG_TAR_B64=x\nJIRA_CLI_CONFIG_TAR_B64_OLD=y\nJIRA_CLI_CONFIG_TAR_B64=new\n");
  });

  // Regression: only the first assignment was replaced, and Compose takes the
  // last one, so a pasted duplicate kept the stale credentials in effect.
  test("every assignment of the variable becomes the one new line, `export` form included", () => {
    const file = join(base, "env");
    writeFileSync(file, "JIRA_CLI_CONFIG_TAR_B64=old1\nA=1\nexport JIRA_CLI_CONFIG_TAR_B64=old2\nB=2\nJIRA_CLI_CONFIG_TAR_B64 = old3\n");
    setEnvVar(file, "JIRA_CLI_CONFIG_TAR_B64", "new");
    expect(readFileSync(file, "utf-8")).toBe("JIRA_CLI_CONFIG_TAR_B64=new\nA=1\nB=2\n");
  });

  test("an existing file keeps its permissions", () => {
    const file = join(base, "env");
    writeFileSync(file, "A=1\n", { mode: 0o640 });
    chmodSync(file, 0o640);
    setEnvVar(file, "JIRA_CLI_CONFIG_TAR_B64", "new");
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  test("the file is replaced whole, through a temporary file next to it that doesn't stay behind", () => {
    const file = join(base, "env");
    writeFileSync(file, "A=1\n");
    setEnvVar(file, "JIRA_CLI_CONFIG_TAR_B64", "new");
    expect(readdirSync(base)).toEqual(["env"]);
  });

  test("a missing file is created, readable by its owner only", () => {
    const file = join(base, "env");
    setEnvVar(file, "JIRA_CLI_CONFIG_TAR_B64", "new");
    expect(readFileSync(file, "utf-8")).toBe("JIRA_CLI_CONFIG_TAR_B64=new\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("readServiceAccountKey", () => {
  /** A key file shaped like the one `gcloud iam service-accounts keys create`
   * writes, around a key generated here (never a real one). */
  function keyFile(overrides: Record<string, unknown> = {}): { file: string; pem: string } {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const file = join(base, "key.json");
    writeFileSync(
      file,
      JSON.stringify({
        type: "service_account",
        project_id: "proj",
        private_key_id: "abc",
        private_key: pem,
        client_email: "bot@proj.iam.gserviceaccount.com",
        ...overrides,
      }),
    );
    return { file, pem };
  }

  test("returns the client email, and the private key on one line with literal \\n", () => {
    const { file, pem } = keyFile();
    const key = readServiceAccountKey(file);
    expect(key.clientEmail).toBe("bot@proj.iam.gserviceaccount.com");
    expect(key.privateKey).not.toContain("\n");
    expect(key.privateKey).toStartWith("-----BEGIN PRIVATE KEY-----\\n");
    expect(key.privateKey).toEndWith("-----END PRIVATE KEY-----\\n");
    // What the Google Chat channel does with the variable before using it.
    const unescaped = key.privateKey.replace(/\\n/g, "\n");
    expect(unescaped).toBe(pem);
    expect(createPrivateKey(unescaped).asymmetricKeyType).toBe("rsa");
  });

  test("a missing file is an error naming it", () => {
    expect(() => readServiceAccountKey(join(base, "nope.json"))).toThrow(join(base, "nope.json"));
  });

  test("a file that isn't JSON is an error naming it", () => {
    writeFileSync(join(base, "key.json"), "not json");
    expect(() => readServiceAccountKey(join(base, "key.json"))).toThrow(`${join(base, "key.json")} isn't a service account key`);
  });

  test("JSON that isn't a service account key is an error naming it", () => {
    for (const overrides of [{ type: "authorized_user" }, { client_email: undefined }, { private_key: 42 }]) {
      const { file } = keyFile(overrides);
      expect(() => readServiceAccountKey(file)).toThrow(`${file} isn't a service account key`);
    }
  });
});
