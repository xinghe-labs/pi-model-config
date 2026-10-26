import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backupFile, readFileIfExists, readModelsConfig, readSettings, stripBom, stripJsonComments, writeJson } from "../src/json-file.js";
import { modelsJsonPath, settingsPath } from "../src/paths.js";

function withAgentDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmc-json-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

test("stripJsonComments removes line comments but not string contents", () => {
	const input = '{\n  // a comment\n  "url": "https://example.com//not-a-comment"\n}';
	assert.deepEqual(JSON.parse(stripJsonComments(input)), { url: "https://example.com//not-a-comment" });
});

test("stripJsonComments removes trailing commas", () => {
	assert.deepEqual(JSON.parse(stripJsonComments('{"a":[1,2,],}')), { a: [1, 2] });
});

test("stripJsonComments leaves escaped quotes intact", () => {
	const input = '{"a":"he said \\"// hi\\"","b":1,}';
	assert.deepEqual(JSON.parse(stripJsonComments(input)), { a: 'he said "// hi"', b: 1 });
});

test("stripBom removes only a leading BOM", () => {
	assert.equal(stripBom("\uFEFF{}"), "{}");
	assert.equal(stripBom("{}"), "{}");
	assert.equal(stripBom("\uFEFF\uFEFF{}"), "\uFEFF{}");
});

test("readModelsConfig accepts the JSONC pi accepts", (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "models.json"), '{\n  // provider list\n  "providers": {"p": {"baseUrl": "https://x/v1",}},\n}\n');
	assert.deepEqual(readModelsConfig(), { providers: { p: { baseUrl: "https://x/v1" } } });
});

test("readModelsConfig returns an empty shell when the file is absent", (t) => {
	withAgentDir(t);
	assert.deepEqual(readModelsConfig(), { providers: {} });
});

test("readModelsConfig treats an empty or whitespace-only file as empty", (t) => {
	// An editor that truncated models.json to nothing must not wedge every flow
	// on "could not be parsed": there is nothing left in the file to protect.
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "models.json"), "");
	assert.deepEqual(readModelsConfig(), { providers: {} });
	fs.writeFileSync(path.join(dir, "models.json"), "  \n\t\n");
	assert.deepEqual(readModelsConfig(), { providers: {} });
});

test("readModelsConfig throws on a file it cannot parse", (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "models.json"), "{ broken");
	assert.throws(() => readModelsConfig(), /could not be parsed/);
	// The message must say nothing was changed: overwriting an unreadable file
	// would destroy the user's keys.
	assert.throws(() => readModelsConfig(), /nothing was changed/);
});

test("readSettings tolerates a corrupt file instead of throwing", (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "settings.json"), "{ broken");
	assert.equal(readSettings(), undefined);
});

test("readSettings does not accept comments", (t) => {
	const dir = withAgentDir(t);
	// pi's settings-manager is strict JSON; accepting more than pi does would let a
	// file we consider valid break the next pi start.
	fs.writeFileSync(path.join(dir, "settings.json"), '{\n // x\n "a": 1\n}');
	assert.equal(readSettings(), undefined);
});

test("readSettings reads a plain file and strips a BOM", (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "settings.json"), '\uFEFF{"enabledModels":["a/*"]}');
	assert.deepEqual(readSettings(), { enabledModels: ["a/*"] });
});

test("writeJson writes indented JSON with a trailing newline", (t) => {
	const dir = withAgentDir(t);
	const target = path.join(dir, "out.json");
	writeJson(target, { a: 1 });
	const raw = fs.readFileSync(target, "utf8");
	assert.equal(raw, '{\n  "a": 1\n}\n');
});

test("writeJson is atomic and leaves no temp file", (t) => {
	const dir = withAgentDir(t);
	const target = path.join(dir, "out.json");
	writeJson(target, { a: 1 });
	writeJson(target, { a: 2 });
	assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { a: 2 });
	assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp")), []);
});

test("writeJson overwrites the old file rather than merging", (t) => {
	const dir = withAgentDir(t);
	const target = path.join(dir, "out.json");
	writeJson(target, { a: 1, b: 2 });
	writeJson(target, { a: 1 });
	assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { a: 1 });
});

test("backupFile copies beside the original and does nothing when missing", (t) => {
	const dir = withAgentDir(t);
	const target = path.join(dir, "models.json");
	assert.equal(backupFile(target), undefined, "a missing file is a no-op success");
	assert.deepEqual(fs.readdirSync(dir), [], "a missing file must not create a backup");

	fs.writeFileSync(target, '{"providers":{}}');
	assert.equal(backupFile(target), undefined, "a successful backup returns undefined");
	const backups = fs.readdirSync(dir).filter((f) => f.startsWith("models.json.bak-"));
	assert.equal(backups.length, 1);
	assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), '{"providers":{}}');
});

test("backupFile returns a failure message when the copy fails", (t) => {
	const dir = withAgentDir(t);
	// copyFileSync cannot copy a directory: a portable failure even as root.
	const target = path.join(dir, "not-a-file");
	fs.mkdirSync(target);
	const failed = backupFile(target);
	assert.equal(typeof failed, "string");
	assert.match(failed, /备份失败/);
	assert.deepEqual(
		fs.readdirSync(dir).filter((f) => f.includes(".bak-")),
		[],
		"a failed backup must not leave a partial copy",
	);
});

test("backupFile keeps only the newest five timestamped backups", (t) => {
	const dir = withAgentDir(t);
	const target = path.join(dir, "models.json");
	fs.writeFileSync(target, "current");
	for (const stamp of [
		"20260101000000",
		"20260102000000",
		"20260103000000",
		"20260104000000",
		"20260105000000",
		"20260106000000",
		"20260107000000",
	]) {
		fs.writeFileSync(path.join(dir, `models.json.bak-${stamp}`), stamp);
	}
	// Not ours: no timestamp suffix, so it must survive pruning.
	fs.writeFileSync(path.join(dir, "models.json.bak"), "hand-made");

	assert.equal(backupFile(target), undefined);
	const left = fs.readdirSync(dir).filter((f) => f.startsWith("models.json.bak-")).sort();
	// The four surviving fakes plus the fresh copy (its stamp is dynamic).
	assert.equal(left.length, 5);
	assert.deepEqual(left.slice(0, 4), [
		"models.json.bak-20260104000000",
		"models.json.bak-20260105000000",
		"models.json.bak-20260106000000",
		"models.json.bak-20260107000000",
	]);
	assert.match(left[4], /^models\.json\.bak-\d{17}$/);
	// The live copy plus the untouched hand-made backup.
	assert.equal(fs.readFileSync(path.join(dir, left[4]), "utf8"), "current");
	assert.equal(fs.readFileSync(path.join(dir, "models.json.bak"), "utf8"), "hand-made");
});

test("writeJson preserves the original file's permissions", (t) => {
	const dir = withAgentDir(t);
	const target = path.join(dir, "models.json");
	fs.writeFileSync(target, "{}");
	fs.chmodSync(target, 0o600);

	writeJson(target, { providers: {} });
	// models.json carries API keys; a rewrite must not widen a restrictive mode.
	assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test("readFileIfExists distinguishes missing from unreadable", (t) => {
	const dir = withAgentDir(t);
	assert.equal(readFileIfExists(path.join(dir, "nope")), undefined);
	assert.throws(() => readFileIfExists(dir), /EISDIR/);
});

test("the path helpers follow PI_CODING_AGENT_DIR at call time", (t) => {
	const dir = withAgentDir(t);
	assert.equal(modelsJsonPath(), path.join(dir, "models.json"));
	assert.equal(settingsPath(), path.join(dir, "settings.json"));
});
