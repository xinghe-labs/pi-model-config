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
import { canPrompt, errorMessage, notify } from "./output.js";

const USAGE = [
	"/model-setup            menu",
	"/model-setup add        add a provider (asks for URL, API type, key, models, id)",
	"/model-setup check      reconcile models.json against the endpoint and models.dev",
	"/model-setup list       show configured providers",
	"/model-setup remove     delete a provider",
].join("\n");

const SUBCOMMANDS = ["add", "check", "list", "remove"];

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
		const { sub } = parseArgs(args);
		try {
			if (sub === "list") return await listFlow(ctx);
			if (sub === "check") return await checkFlow(ctx);
			if (sub === "remove") return await removeFlow(ctx);
			if (sub === "add") return await addFlow(ctx);
			if (!canPrompt(ctx)) {
				// Non-interactive: there is no menu to show, so print the usage rather
				// than returning silently.
				notify(ctx, USAGE);
				return;
			}
			const action = await ctx.ui.select("Model endpoint configuration", [
				"Add endpoint",
				"Check / repair model parameters",
				"Show configured endpoints",
				"Remove endpoint",
			]);
			if (action === undefined) return;
			if (action === "Check / repair model parameters") return await checkFlow(ctx);
			if (action === "Show configured endpoints") return await listFlow(ctx);
			if (action === "Remove endpoint") return await removeFlow(ctx);
			return await addFlow(ctx);
		} catch (err) {
			notify(ctx, `model-setup failed: ${errorMessage(err)}`, "error");
		}
	};

	pi.registerCommand("model-setup", {
		description:
			"Configure a model endpoint and infer model capabilities (endpoint metadata > models.dev > name): add / check / list / remove",
		handler,
	});
	// The name this command shipped under before it was packaged. Kept registered so
	// existing habits keep working, but /model-setup is the documented one.
	pi.registerCommand("model-config", {
		description: "Alias for /model-setup",
		handler,
	});
}
