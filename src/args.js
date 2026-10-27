// Option parsing for the non-interactive forms of `add` and `sync`.
//
// Deliberately tiny and strict: an unknown flag is an error rather than being
// ignored, because these commands write models.json and a silently dropped
// `--only` would add every model on a gateway instead of the three that were
// asked for.
//
// Writing is never implied. `--all` and `--only` both mean "write what was
// described"; without either, the flow prints its plan and touches nothing.

const BOOLEAN = new Set(["all", "yes", "apply", "dry-run", "no-prune", "help", "fix"]);
const VALUED = new Set(["only", "api", "id", "key", "url"]);

export const USAGE_TEXT = [
	"用法：",
	"  /model-setup add <url> [<key>] [选项]",
	"      --all              添加端点提供的全部模型，并写入",
	"      --only a,b,c       只添加这些模型，并写入（逗号分隔）",
	"      --id <pid>         供应商 id（默认从主机名推导）",
	"      --api <type>       openai-completions | openai-responses | anthropic-messages | google-generative-ai",
	"      --key <key>        API Key（否则依次取：第二个参数、$PI_MODEL_CONFIG_API_KEY）",
	"      --dry-run          即使带了 --all / --only 也只打印计划",
	"",
	"  /model-setup sync [<pid>...] [选项]",
	"      --all              补齐新模型、删除失效模型、修复参数，并写入",
	"      --only a,b,c       只添加这些新模型，并写入；点名忽略名单里的 id 即恢复",
	"      --no-prune         绝不删除端点已下线的模型",
	"      --dry-run          即使带了 --all / --only 也只打印计划",
	"",
	"  /model-setup check [--fix]",
	"      --fix              不询问，直接修复全部端点的参数偏差",
	"",
	"--all / --yes / --apply 是同一个请求的三种写法。",
	"不带 --all 或 --only 时一个字节都不写：先给你看计划。",
].join("\n");

// `--only a,b,c` and `--only=a,b,c` both work; the value is a single
// comma-separated word — extra positionals are rejected in addFromArgs rather
// than silently read as an API key.
export function parseOptions(words) {
	const flags = new Set();
	const values = {};
	const positional = [];

	for (let i = 0; i < words.length; i += 1) {
		const word = words[i];
		if (word === "--") {
			positional.push(...words.slice(i + 1));
			break;
		}
		if (!word.startsWith("--")) {
			positional.push(word);
			continue;
		}
		const body = word.slice(2);
		const eq = body.indexOf("=");
		const name = (eq === -1 ? body : body.slice(0, eq)).toLowerCase();
		const inline = eq === -1 ? undefined : body.slice(eq + 1);

		if (VALUED.has(name)) {
			if (inline !== undefined) {
				// An empty value (`--only=`) must be an error, not "no filter": the
				// flows treat a falsy/empty only as "everything", so silently
				// accepting it would turn a typo into a full unfiltered write.
				if (inline.trim() === "") throw new Error(`--${name} needs a value`);
				values[name] = inline;
				continue;
			}
			const next = words[i + 1];
			if (next === undefined || next.startsWith("--") || next.trim() === "") {
				throw new Error(`--${name} needs a value`);
			}
			values[name] = next;
			// `--only` may take several space-separated ids (`sync --only a b c`);
			// consuming them here keeps them out of the positionals, where the old
			// single-word behavior silently read the second id as an API key.
			if (name === "only") {
				let j = i + 2;
				while (j < words.length && words[j] !== "--" && !words[j].startsWith("--")) {
					if (words[j].trim() === "") throw new Error("--only needs a value");
					values.only = `${values.only},${words[j]}`;
					j += 1;
				}
				i = j - 1;
			} else {
				i += 1;
			}
			continue;
		}
		if (BOOLEAN.has(name)) {
			if (inline !== undefined) throw new Error(`--${name} does not take a value`);
			flags.add(name);
			continue;
		}
		throw new Error(`Unknown option: --${name}`);
	}

	return { flags, values, positional };
}

// Each flow declares the options it actually understands. parseOptions knows the
// union for every command, so a valid-but-inapplicable flag (`sync --key x`,
// `check --no-prune`) would otherwise be accepted and silently ignored — the
// same trap as a dropped --only. Calling this after parseOptions turns those
// into hard errors.
export function restrictOptions(cmd, options, allowedFlags, allowedValues) {
	for (const flag of options.flags) {
		if (!allowedFlags.has(flag)) throw new Error(`${cmd} 不支持选项：--${flag}`);
	}
	for (const name of Object.keys(options.values)) {
		if (!allowedValues.has(name)) throw new Error(`${cmd} 不支持选项：--${name}`);
	}
	return options;
}

export function parseIdList(raw) {
	if (typeof raw !== "string") return [];
	return raw
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

// `--all` and `--yes` are the same request: accept the whole plan. `--apply`
// exists so a habit of typing it is not punished.
//
// Deliberate: `--yes` does NOT also answer the delete confirmation in `sync`.
// Removing models is the one irreversible thing this package does, so it always
// asks once when a UI exists. `--yes` is a synonym for "accept the plan", not for
// "stop asking questions". Do not "fix" this into a silent delete.
export function wantsAll(options) {
	return options.flags.has("all") || options.flags.has("yes") || options.flags.has("apply");
}

export function wantsWrite(options) {
	if (options.flags.has("dry-run")) return false;
	return wantsAll(options) || options.values.only !== undefined;
}

export function onlyIds(options) {
	return options.values.only === undefined ? undefined : parseIdList(options.values.only);
}
