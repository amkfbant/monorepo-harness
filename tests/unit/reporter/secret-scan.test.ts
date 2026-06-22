import { describe, it, expect } from "vitest";
import {
  scanForSecrets,
  redactSecretLines,
  createSecretLineRedactor,
  containsLikelySecret,
  COMMAND_LOG_LINE_WITHHELD,
} from "../../../src/reporter/secret-scan.js";

describe("containsLikelySecret — extended vendor shapes (#84 P1 fix)", () => {
  it.each([
    ["slack bot token", `xoxb-12345678901-abcdefghijkl`],
    ["slack app token", `xapp-1-A0123456789-abcdefghijklmno`],
    ["gitlab pat", `glpat-abcdefghijklmnopqrstuvwx`],
    ["google api key", `AIza${"x".repeat(35)}`],
    ["http basic auth header", `Authorization: Basic QWxhZGRpbjpvcGVuc2VzYW1l`],
  ])("matches %s", (_label, text) => {
    expect(containsLikelySecret(text)).toBe(true);
  });

  it.each([
    ["the word basic in prose", "this is a basic implementation detail"],
    ["basic followed by a long word (no header)", "basic understanding required"],
    ["plain identifier", "hitch-12345 fixed pagination off-by-one"],
  ])("does NOT over-redact %s", (_label, text) => {
    expect(containsLikelySecret(text)).toBe(false);
  });
});

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

describe("redactSecretLines (single-shot)", () => {
  it("withholds a whole line that contains a secret-shaped token", () => {
    expect(redactSecretLines(`token=ghp_${"a".repeat(36)}`)).toBe(
      COMMAND_LOG_LINE_WITHHELD,
    );
  });

  it("passes benign lines through unchanged (incl. blank lines)", () => {
    const input = "build started\n\nno secrets here\nbuild finished";
    expect(redactSecretLines(input)).toBe(input);
  });

  it("redacts only the offending line in multi-line input", () => {
    const input = [
      "build started",
      `OPENAI_API_KEY=sk-${"c".repeat(40)}`,
      "build finished",
    ].join("\n");
    expect(redactSecretLines(input)).toBe(
      ["build started", COMMAND_LOG_LINE_WITHHELD, "build finished"].join("\n"),
    );
  });

  it("preserves a trailing newline (final empty segment)", () => {
    const input = `before\nAWS_SECRET_ACCESS_KEY=${"d".repeat(40)}\nafter\n`;
    expect(redactSecretLines(input)).toBe(
      ["before", COMMAND_LOG_LINE_WITHHELD, "after", ""].join("\n"),
    );
  });

  it("withholds EVERY line of a multi-line PEM private-key block (P1)", () => {
    const pem = [
      "preamble line",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEArandombase64bodyline1",
      "morebase64bodyline2WithoutAnyTokenShape",
      "-----END RSA PRIVATE KEY-----",
      "trailer line",
    ].join("\n");
    const out = redactSecretLines(pem);
    // the base64 body lines must NOT survive (they match no token pattern alone)
    expect(out).not.toContain("MIIEpAIBAA");
    expect(out).not.toContain("morebase64bodyline2");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(out).not.toContain("END RSA PRIVATE KEY");
    expect(out).toBe(
      [
        "preamble line",
        COMMAND_LOG_LINE_WITHHELD,
        COMMAND_LOG_LINE_WITHHELD,
        COMMAND_LOG_LINE_WITHHELD,
        COMMAND_LOG_LINE_WITHHELD,
        "trailer line",
      ].join("\n"),
    );
  });

  it("handles a single-line PEM (BEGIN+END same line) without leaving the block open", () => {
    const input = [
      "-----BEGIN PRIVATE KEY----- inlinebody -----END PRIVATE KEY-----",
      "next benign line",
    ].join("\n");
    expect(redactSecretLines(input)).toBe(
      [COMMAND_LOG_LINE_WITHHELD, "next benign line"].join("\n"),
    );
  });
});

describe("createSecretLineRedactor (streaming, stateful PEM)", () => {
  it("keeps the PEM block open across separate redactLine calls", () => {
    const r = createSecretLineRedactor();
    expect(r.redactLine("ok before")).toBe("ok before");
    expect(r.redactLine("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(
      COMMAND_LOG_LINE_WITHHELD,
    );
    expect(r.redactLine("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU")).toBe(
      COMMAND_LOG_LINE_WITHHELD,
    );
    expect(r.redactLine("-----END OPENSSH PRIVATE KEY-----")).toBe(
      COMMAND_LOG_LINE_WITHHELD,
    );
    // block closed — benign content flows again
    expect(r.redactLine("ok after")).toBe("ok after");
  });
});
