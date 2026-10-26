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
// A whitespace-only file is treated as "empty", not as corruption: an editor
// that truncated the file to nothing would otherwise wedge every flow here,
// and there is nothing left in it to protect.
export function readModelsConfig() {
	const raw = readFileIfExists(modelsJsonPath());
	if (raw === undefined || raw.trim() === "") return { providers: {} };
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

// Keep this many timestamped backups beside the file; older ones are pruned so
// a long-lived install does not accumulate a copy of every historical key.
const BACKUP_KEEP = 5;

// Returns undefined when the backup succeeded (or there was nothing to back up),
// or a failure message the caller must surface before overwriting the file:
// a silent failed backup would let the write proceed without its safety net.
// A failed backup never blocks the main flow — the caller warns and continues.
export function backupFile(p) {
	try {
		if (!fs.existsSync(p)) return undefined;
		// Millisecond precision: two writes in the same second would otherwise
		// silently overwrite each other's backup.
		const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 17);
		fs.copyFileSync(p, `${p}.bak-${stamp}`);
	} catch (err) {
		return `备份失败（${err instanceof Error ? err.message : String(err)}）`;
	}
	pruneBackups(p);
	return undefined;
}

// Best-effort: keep only the BACKUP_KEEP newest timestamped backups. Only files
// this function created (name ends in .bak-<stamp>) are ever removed, so a
// hand-made models.json.bak or settings.json.bak-before-scope-fix survives.
function pruneBackups(p) {
	try {
		const dir = path.dirname(p);
		const prefix = `${path.basename(p)}.bak-`;
		const stale = fs
			.readdirSync(dir)
			.filter((name) => name.startsWith(prefix))
			.sort()
			.slice(0, -BACKUP_KEEP);
		for (const name of stale) fs.rmSync(path.join(dir, name), { force: true });
	} catch {
		/* pruning must never fail the flow */
	}
}

// Atomic write: a same-directory temp file, then rename. An interrupted write
// leaves the old file intact instead of a truncated one. The original file's
// permissions are preserved: models.json carries API keys, and a restrictive
// mode (e.g. 0600) must not silently widen to the process default on rewrite.
export function writeJson(p, data) {
	const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${Date.now()}.tmp`);
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
		try {
			fs.chmodSync(tmp, fs.statSync(p).mode & 0o777);
		} catch {
			/* the target does not exist yet: keep the process default */
		}
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
