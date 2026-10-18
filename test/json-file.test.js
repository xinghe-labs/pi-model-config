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
	backupFile(target);
	assert.deepEqual(fs.readdirSync(dir), [], "a missing file must not create a backup");

	fs.writeFileSync(target, '{"providers":{}}');
	backupFile(target);
	const backups = fs.readdirSync(dir).filter((f) => f.startsWith("models.json.bak-"));
	assert.equal(backups.length, 1);
	assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), '{"providers":{}}');
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
