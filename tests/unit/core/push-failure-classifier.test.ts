import { describe, it, expect } from "vitest";
import { classifyPushFailure } from "../../../src/core/push-failure-classifier.js";

// (#396 part 2) The classifier is the single tuning point for transient-retry vs
// terminal-escalate. It MUST be fail-closed (unknown → permanent) and immune to
// server-controlled text fabricating a transient signal.
describe("classifyPushFailure (#396 part 2)", () => {
  describe("transient (client-line connectivity / 5xx / ref-lock)", () => {
    const transient = [
      "fatal: unable to access 'https://github.com/x.git/': Could not resolve host: github.com",
      "ssh: connect to host github.com port 22: Connection timed out",
      "fatal: unable to access '...': Failed to connect to github.com port 443",
      "error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503",
      "fatal: the remote end hung up unexpectedly",
      "error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: early EOF",
      "error: 503 Service Unavailable",
      "error: cannot lock ref 'refs/heads/x': is at ... but expected ...",
      "fatal: Unable to create '.../index.lock': File exists.",
      "kex_exchange_identification: Connection closed by remote host",
      "GnuTLS recv error (-110): gnutls_handshake() failed",
      "error: RPC failed; HTTP 429 too many requests",
      // HTTP 500 (a git-host 500 is a retryable server error) — codex review P2
      "error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500",
      "error: 500 Internal Server Error",
      // SSH connectivity whose generic trailer must NOT force permanent — codex P2
      "ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.",
      // a `gitTimeoutMs` push kill synthesizes a `timed out` marker (pr-creator) — codex P2
      "git push timed out",
    ];
    for (const t of transient) {
      it(`→ transient: ${t.slice(0, 48)}`, () => {
        expect(classifyPushFailure(t)).toBe("transient");
      });
    }
  });

  describe("permanent (server refusal / auth / policy / stale ref / cert)", () => {
    const permanent = [
      " ! [remote rejected] main -> main (pre-receive hook declined)",
      "remote: error: GH006: Protected branch update failed for refs/heads/main.",
      "remote: Permission to x.git denied to y.",
      "fatal: Authentication failed for 'https://github.com/x.git/'",
      "remote: Repository not found.\nfatal: repository 'https://...' not found",
      "remote: error: 403 Forbidden",
      " ! [rejected]        main -> main (non-fast-forward)",
      "error: failed to push some refs to 'origin'\nhint: Updates were rejected because the remote contains work\nhint: ... 'git pull' ... (fetch first)",
      "error: failed to push some refs ... (stale info)",
      "fatal: unable to access '...': SSL certificate problem: self-signed certificate",
      "fatal: unable to access '...': server certificate verification failed",
      "fatal: unable to access '...': certificate has expired",
      "remote: push declined due to repository rule violations",
      // a PERMANENT ssh auth failure keeps escalating even though the generic
      // `could not read from remote repository` trailer is no longer permanent —
      // the specific `permission denied` signal still wins (codex P2).
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    ];
    for (const p of permanent) {
      it(`→ permanent: ${p.slice(0, 48)}`, () => {
        expect(classifyPushFailure(p)).toBe("permanent");
      });
    }
  });

  describe("fail-closed default", () => {
    it("empty string → permanent", () => {
      expect(classifyPushFailure("")).toBe("permanent");
    });
    it("unknown gibberish → permanent", () => {
      expect(classifyPushFailure("fatal: something nobody has seen before")).toBe(
        "permanent",
      );
    });
  });

  describe("server-controlled text cannot fabricate a transient (escalate-semantics)", () => {
    it("server side-band counter (503/503) on a remote: line → permanent, not transient", () => {
      const body =
        "remote: error: push blocked: signed commits required\n" +
        "remote: Resolving deltas: 100% (503/503), completed with 503 local objects.\n" +
        "error: failed to push some refs to 'origin'";
      expect(classifyPushFailure(body)).toBe("permanent");
    });
    it("a server file-size message mentioning 503 MB → permanent", () => {
      expect(
        classifyPushFailure("remote: error: file foo exceeds 503 MB GitHub limit"),
      ).toBe("permanent");
    });
    it("a branch/ref name containing 502 with no transient client signal → permanent", () => {
      expect(
        classifyPushFailure(" ! [rejected] feature/issue-502 -> feature/issue-502 (fetch first)"),
      ).toBe("permanent");
    });
    it("permanent signature anywhere wins even with a transient client phrase present", () => {
      const body =
        "error: RPC failed; HTTP 503\n" +
        "remote: error: GH006: Protected branch update failed.";
      expect(classifyPushFailure(body)).toBe("permanent");
    });
  });
});
