import { describe, it, expect } from "vitest";
import {
  COMMAND_LOG_LINE_WITHHELD,
  redactSecretLines,
  scanForSecrets,
} from "../../../src/reporter/secret-scan.js";

describe("scanForSecrets — filename heuristics", () => {
  it("flags .env / .env.local / .env.production", () => {
    expect(scanForSecrets(".env", "").matched).toBe(true);
    expect(scanForSecrets(".env.local", "").matched).toBe(true);
    expect(scanForSecrets(".env.production", "").matched).toBe(true);
  });

  it("flags *.env and *.env.*", () => {
    expect(scanForSecrets("staging.env", "").matched).toBe(true);
    expect(scanForSecrets("staging.env.local", "").matched).toBe(true);
  });

  it("flags names containing secret/token/credential/password", () => {
    expect(scanForSecrets("my-secret.json", "").matched).toBe(true);
    expect(scanForSecrets("api_token.txt", "").matched).toBe(true);
    expect(scanForSecrets("credentials.yaml", "").matched).toBe(true);
    expect(scanForSecrets("admin_password", "").matched).toBe(true);
  });

  it("flags SSH private keys and *.pem/*.key/*.pfx/*.p12", () => {
    expect(scanForSecrets("id_rsa", "").matched).toBe(true);
    expect(scanForSecrets("id_ed25519", "").matched).toBe(true);
    expect(scanForSecrets("server.pem", "").matched).toBe(true);
    expect(scanForSecrets("client.key", "").matched).toBe(true);
    expect(scanForSecrets("identity.pfx", "").matched).toBe(true);
  });

  it("does not flag obviously benign names", () => {
    expect(scanForSecrets("profile.ts", "").matched).toBe(false);
    expect(scanForSecrets("README.md", "").matched).toBe(false);
    expect(scanForSecrets("index.html", "").matched).toBe(false);
  });
});

describe("scanForSecrets — content heuristics", () => {
  it("flags PEM private-key headers", () => {
    const sample = "-----BEGIN PRIVATE KEY-----\nMIIE...\n";
    expect(scanForSecrets("notes.txt", sample).matched).toBe(true);
    const sample2 = "-----BEGIN RSA PRIVATE KEY-----\nfoo\n";
    expect(scanForSecrets("notes.txt", sample2).matched).toBe(true);
  });

  it("flags AWS access key ids", () => {
    const sample = "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n";
    expect(scanForSecrets("config.sh", sample).matched).toBe(true);
  });

  it("flags GitHub tokens (classic + fine-grained PAT)", () => {
    expect(
      scanForSecrets("notes", `token=ghp_${"a".repeat(36)}`).matched,
    ).toBe(true);
    expect(
      scanForSecrets("notes", `pat=github_pat_${"A".repeat(30)}`).matched,
    ).toBe(true);
  });

  it("flags OpenAI sk- and sk-proj- keys", () => {
    expect(
      scanForSecrets("notes", `OPENAI_API_KEY=sk-${"a".repeat(40)}`).matched,
    ).toBe(true);
    expect(
      scanForSecrets("notes", `OPENAI_API_KEY=sk-proj-${"a".repeat(40)}`)
        .matched,
    ).toBe(true);
  });

  it("flags Stripe live/test secret keys", () => {
    expect(
      scanForSecrets("notes", `sk_live_${"a".repeat(24)}`).matched,
    ).toBe(true);
    expect(
      scanForSecrets("notes", `sk_test_${"a".repeat(24)}`).matched,
    ).toBe(true);
  });

  it("does not flag normal English prose", () => {
    expect(
      scanForSecrets(
        "post.md",
        "Hello world, this is a normal article about secrets management.\n",
      ).matched,
    ).toBe(false);
  });

  it("does not run content scan when sample is null", () => {
    // sample=null means caller could not / chose not to read content.
    // Filename check still runs; content patterns are skipped.
    const r = scanForSecrets(
      "profile.ts",
      null,
    );
    expect(r.matched).toBe(false);
  });

  it("returns each matched reason for reviewer triage", () => {
    const r = scanForSecrets(".env", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
    expect(r.reasons).toContain("filename:.env");
    expect(r.reasons).toContain("content:aws-access-key-id");
  });
});

describe("redactSecretLines", () => {
  it("replaces a whole line when it contains secret-shaped content", () => {
    expect(redactSecretLines(`token=ghp_${"a".repeat(36)}`)).toBe(
      COMMAND_LOG_LINE_WITHHELD,
    );
  });

  it("passes benign lines through unchanged", () => {
    const input = "build started\nno secrets here\nbuild finished";
    expect(redactSecretLines(input)).toBe(input);
  });

  it("redacts only offending lines in multi-line input", () => {
    const input = [
      "build started",
      `token=ghp_${"b".repeat(36)}`,
      "build finished",
    ].join("\n");
    expect(redactSecretLines(input)).toBe(
      ["build started", COMMAND_LOG_LINE_WITHHELD, "build finished"].join(
        "\n",
      ),
    );
  });

  it("preserves trailing newline structure", () => {
    const input = `before\nOPENAI_API_KEY=sk-${"c".repeat(40)}\nafter\n`;
    expect(redactSecretLines(input)).toBe(
      ["before", COMMAND_LOG_LINE_WITHHELD, "after", ""].join("\n"),
    );
  });

  it("redacts a newline-less final secret line", () => {
    expect(redactSecretLines(`AWS_SECRET_ACCESS_KEY=${"d".repeat(40)}`)).toBe(
      COMMAND_LOG_LINE_WITHHELD,
    );
  });
});
