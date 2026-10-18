// pi-model-config — add a model endpoint to Pi in five answers.
//
// `/model-setup` writes models.json, but it is not an editor: the point is that
// context window, output limit, reasoning, image input and thinking levels are
// *derived* (endpoint metadata > models.dev > model name) and can be re-audited
// later against the same sources.
//
//   /model-setup             menu
//   /model-setup add         add or replace a provider
//   /model-setup check       audit models.json against the live endpoint and models.dev
//   /model-setup list        show configured providers
//   /model-setup remove      delete a provider
//
// `check` and `list` are read-only and work without a UI (their report goes to
// stdout); `add` and `remove` need dialogs.
import { checkFlow } from "./flows/check.js";
import { addFlow } from "./flows/add.js";
import { listFlow } from "./flows/list.js";
import { removeFlow } from "./flows/remove.js";
import { syncFlow } from "./flows/sync.js";
import { canPrompt, errorMessage, notify } from "./output.js";

const USAGE = [
	"/model-setup                    菜单",
	"/model-setup add                交互式添加供应商（问五个问题）",
	"/model-setup add <url> <key>    只给 URL 和 Key，参数自动推断",
	"/model-setup sync               补齐新模型 / 删掉失效模型 / 修参数",
	"/model-setup check              对账模型参数（不改模型列表）",
	"/model-setup list               列出已配置的供应商",
	"/model-setup remove             删除一个供应商",
	"",
	"add 和 sync 默认只打印计划，加 --all 或 --only <ids> 才写盘。",
	"全部选项见 `/model-setup add --help`。",
].join("\n");

const SUBCOMMANDS = ["add", "check", "list", "remove", "sync"];
const MENU = [
	"添加端点",
	"与端点同步模型列表",
	"检查 / 修复模型参数",
	"查看已配置的端点",
	"删除端点",
];

// A first-word match, but only when the whole input is a subcommand: `/model-setup
// list` is a command, `/model-setup https://x/v1` is a URL to add.
export function parseArgs(rawArgs) {
	const words = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
	const first = (words[0] ?? "").toLowerCase();
	const sub = SUBCOMMANDS.includes(first) ? first : "";
	return { sub, rest: sub ? words.slice(1) : words, words };
}

export default function modelConfigExtension(pi) {
	// One silent audit per process, on real startup only. `/reload` raises
	// session_start again and would repeat the work for no benefit.
	let autoCheckStarted = false;
	pi.on("session_start", (event, ctx) => {
		if (event?.reason !== "startup" || autoCheckStarted) return;
		autoCheckStarted = true;
		void checkFlow(ctx, { auto: true }).catch(() => {
			/* a background audit must never surface as an error; run /model-setup check */
		});
	});

	const handler = async (args, ctx) => {
		const { sub, rest } = parseArgs(args);
		try {
			if (sub === "list") return await listFlow(ctx);
			if (sub === "check") return await checkFlow(ctx);
			if (sub === "remove") return await removeFlow(ctx);
			if (sub === "sync") return await syncFlow(ctx, { argv: rest });
			if (sub === "add") return await addFlow(ctx, { argv: rest.length ? rest : undefined });
			if (!canPrompt(ctx)) {
				// Non-interactive: there is no menu to show, so print the usage rather
				// than returning silently.
				notify(ctx, USAGE);
				return;
			}
			const action = await ctx.ui.select("模型端点配置", MENU);
			if (action === undefined) return;
			if (action === "与端点同步模型列表") return await syncFlow(ctx);
			if (action === "检查 / 修复模型参数") return await checkFlow(ctx);
			if (action === "查看已配置的端点") return await listFlow(ctx);
			if (action === "删除端点") return await removeFlow(ctx);
			return await addFlow(ctx);
		} catch (err) {
			notify(ctx, `model-setup failed: ${errorMessage(err)}`, "error");
		}
	};

	pi.registerCommand("model-setup", {
		description:
			"Add a model endpoint from a URL and key and infer model capabilities (endpoint metadata > models.dev > name), then sync or check: add / sync / check / list / remove",
		handler,
	});
	// The name this command shipped under before it was packaged. Kept registered so
	// existing habits keep working, but /model-setup is the documented one.
	pi.registerCommand("model-config", {
		description: "Alias for /model-setup",
		handler,
	});
}
