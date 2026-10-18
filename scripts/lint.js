// Syntax-check every source file.
//
// `node --check src/index.js` only ever checks one file, so a syntax error in
// any other module survives it. This walks the same directories CI does, so
// there is one definition of "every source file".
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dirname` needs Node 20.11; `engines` promises 20.0.
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIRS = ["src", "test", "scripts"];

function walk(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith(".js")) out.push(full);
	}
	return out;
}

const files = DIRS.map((d) => path.join(ROOT, d))
	.filter((d) => fs.existsSync(d))
	.flatMap(walk);

let failed = 0;
for (const file of files) {
	try {
		execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
	} catch (e) {
		failed += 1;
		process.stderr.write(`${path.relative(ROOT, file)}: ${e.stderr ?? e.message}\n`);
	}
}

if (failed) {
	process.stderr.write(`\n${failed} of ${files.length} file(s) failed the syntax check\n`);
	process.exit(1);
}
console.log(`syntax ok: ${files.length} file(s)`);
