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
const VALUED = new Set(["only", "api", "id", "key"]);

export const USAGE_TEXT = [
	"用法：",
	"  /model-setup add <url> [<key>] [选项]",
	"      --all              添加端点提供的全部模型，并写入",
	"      --only a,b,c       只添加这些模型，并写入",
	"      --id <pid>         供应商 id（默认从主机名推导）",
	"      --api <type>       openai-completions | openai-responses | anthropic-messages | google-generative-ai",
	"      --key <key>        API Key（否则依次取：第二个参数、$PI_MODEL_CONFIG_API_KEY）",
	"      --dry-run          即使带了 --all / --only 也只打印计划",
	"",
	"  /model-setup sync [<pid>...] [选项]",
	"      --all              补齐新模型、删除失效模型、修复参数，并写入",
	"      --only a,b,c       只添加这些新模型，并写入",
	"      --no-prune         绝不删除端点已下线的模型",
	"      --dry-run          即使带了 --all / --only 也只打印计划",
	"",
	"不带 --all 或 --only 时一个字节都不写：先给你看计划。",
].join("\n");

// `--only a,b,c` and `--only=a,b,c` both work; the value may also be a space
// separated list of several words, which is why it is collected below.
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
				values[name] = inline;
				continue;
			}
			const next = words[i + 1];
			if (next === undefined || next.startsWith("--")) {
				throw new Error(`--${name} needs a value`);
			}
			values[name] = next;
			i += 1;
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
