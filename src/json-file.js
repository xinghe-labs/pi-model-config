// Reading and writing Pi's JSON files.
//
// models.json is JSONC (Pi tolerates comments and trailing commas) while
// settings.json is strict JSON. Both distinctions are Pi's, not ours, so they
// are reproduced faithfully: a file that parses for Pi must parse here, and a
// file that does not must abort before anything is written.
import fs from "node:fs";
import path from "node:path";
import { modelsJsonPath, settingsPath } from "./paths.js";

// Same approach as pi's dist/utils/json.js: strip `//` line comments and
// trailing commas only outside string literals.
export function stripJsonComments(input) {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

// Same as pi's dist/utils/text.js: a leading BOM only.
export function stripBom(content) {
	return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

export function readFileIfExists(p) {
	try {
		return fs.readFileSync(p, "utf8");
	} catch (err) {
		if (err?.code === "ENOENT") return undefined;
		throw err;
	}
}

// Throws when the file exists but cannot be parsed. Callers must abort and write
// nothing: overwriting a file we failed to understand destroys the user's keys.
export function readModelsConfig() {
	const raw = readFileIfExists(modelsJsonPath());
	if (raw === undefined) return { providers: {} };
	try {
		return JSON.parse(stripJsonComments(stripBom(raw)));
	} catch (err) {
		throw new Error(
			`models.json could not be parsed (${err instanceof Error ? err.message : String(err)}). Fix that file first; nothing was changed.`,
		);
	}
}

// Matches pi's settings-manager: no comments allowed. An unreadable settings file
// is treated as "no settings" rather than an error, and is never written back.
export function readSettings() {
	const raw = readFileIfExists(settingsPath());
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(stripBom(raw));
	} catch {
		return undefined;
	}
}

export function backupFile(p) {
	try {
		if (!fs.existsSync(p)) return;
		const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
		fs.copyFileSync(p, `${p}.bak-${stamp}`);
	} catch {
		/* a failed backup must not block the main flow */
	}
}

// Atomic write: a same-directory temp file, then rename. An interrupted write
// leaves the old file intact instead of a truncated one.
export function writeJson(p, data) {
	const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${Date.now()}.tmp`);
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
		fs.renameSync(tmp, p);
	} catch (err) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* cleanup failure must not mask the real error */
		}
		throw err;
	}
}
