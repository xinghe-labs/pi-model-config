// resolveProbeKey's fallback chain and the auth.json tolerance rules.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveProbeKey } from "../src/auth-store.js";

function withAgentDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmc-auth-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

const authFile = (dir) => path.join(dir, "auth.json");

test("explicit models.json key wins over auth.json", (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(authFile(dir), JSON.stringify({ gw: { type: "api_key", key: "sk-auth" } }));
	const got = resolveProbeKey({ apiKey: "sk-models" }, "gw");
	assert.equal(got, "sk-models");
});

test("missing models.json key falls back to the auth.json credential", (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(authFile(dir), JSON.stringify({ gw: { type: "api_key", key: " sk-auth " } }));
	// "none" is models.json's no-key convention, not a key literally named none.
	assert.equal(resolveProbeKey({ apiKey: "none" }, "gw"), "sk-auth");
	assert.equal(resolveProbeKey({}, "gw"), "sk-auth");
});

test("oauth credentials are not usable as a bearer", (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(authFile(dir), JSON.stringify({ gw: { type: "oauth", access: "token" } }));
	assert.equal(resolveProbeKey({}, "gw"), "");
});

test("no auth.json, broken JSON, or an unknown shape all degrade to empty", (t) => {
	const dir = withAgentDir(t);
	assert.equal(resolveProbeKey({}, "gw"), "");
	fs.writeFileSync(authFile(dir), "{ torn");
	assert.equal(resolveProbeKey({}, "gw"), "");
	fs.writeFileSync(authFile(dir), JSON.stringify({ gw: "a bare string" }));
	assert.equal(resolveProbeKey({}, "gw"), "");
	fs.writeFileSync(authFile(dir), JSON.stringify({ gw: { type: "api_key" } }));
	assert.equal(resolveProbeKey({}, "gw"), "");
});
