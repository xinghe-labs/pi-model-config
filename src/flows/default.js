// `/model-config default` — set the default provider / model / thinking level.
//
// These three fields live in settings.json and normally mean hand-editing that
// file. This flow is a thin, safe front for exactly that: read, show, confirm,
// back up, write atomically. Nothing here touches models.json — the endpoint
// configuration is the other commands' job.
//
// Forms:
//   /model-config default                 show current defaults
//   /model-config default <provider>/<model> [level]   scripted set, needs --all
//   /model-config default                 (with a UI) pick interactively
//
// The thinking level is optional; leaving it out keeps the current value. Only
// models listed in settings' enabledModels (when that key exists) or in
// models.json are offered — picking a model pi cannot resolve would just move
// the broken state into the settings file.
import { PI_LEVELS } from "../const.js";
import { backupFile, readModelsConfig, readSettings, writeJson } from "../json-file.js";
import { errorMessage, notify, canPrompt, requireUI } from "../output.js";
import { settingsPath } from "../paths.js";
import { parseOptions, restrictOptions } from "../args.js";

const CANCELLED = "已取消";
const LEVELS = ["off", ...PI_LEVELS];

function parseModelRef(ref) {
	const slash = ref.indexOf("/");
	if (slash === -1) return undefined;
	return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

function describeCurrent(settings) {
	const provider = settings?.defaultProvider ?? "（未设置，pi 默认）";
	const model = settings?.defaultModel ?? "（未设置，pi 默认）";
	const level = settings?.defaultThinkingLevel ?? "（未设置，模型默认）";
	return `当前默认：${provider}/${model}，思考等级 ${level}`;
}

// Validate a provider/model pair against models.json and enabledModels. Returns
// an error string or undefined.
function validateRef(ref, providers, settings) {
	if (!ref) return undefined;
	const parsed = parseModelRef(ref);
	if (!parsed || !parsed.model) return `格式应为 <provider>/<model>：${ref}`;
	const provider = providers[parsed.provider];
	if (!provider) return `models.json 里没有这个供应商：${parsed.provider}`;
	const models = Array.isArray(provider.models) ? provider.models : [];
	if (models.length && !models.some((m) => m?.id === parsed.model)) {
		return `${parsed.provider} 没有这个模型：${parsed.model}`;
	}
	// enabledModels, when present, gates what pi actually resolves; a default
	// outside it would be rejected at startup with "No models match pattern".
	const enabled = settings?.enabledModels;
	if (Array.isArray(enabled) && enabled.length && !enabled.some((e) => typeof e === "string" && matchesEntry(e, parsed))) {
		const exact = enabled.includes(ref);
		return exact
			? undefined
			: `enabledModels 不含 ${ref}（是 ${parsed.provider}/* 或显式列表）。请先用 /scoped-models 加入，或直接改选列表内的模型。`;
	}
	return undefined;
}

function matchesEntry(entry, parsed) {
	const lower = entry.toLowerCase();
	if (lower === `${parsed.provider.toLowerCase()}/${parsed.model.toLowerCase()}`) return true;
	if (lower === `${parsed.provider.toLowerCase()}/*`) return true;
	// Explicit lists may carry thinking suffixes (`provider/id:high`).
	const base = lower.split(":")[0];
	return base === `${parsed.provider.toLowerCase()}/${parsed.model.toLowerCase()}`;
}

// Compute the next settings object without touching disk. Throws on anything
// the caller should report.
export function planDefault({ ref, level, settings }) {
	const next = { ...settings };
	const changes = [];
	if (ref) {
		const parsed = parseModelRef(ref);
		if (parsed.provider !== settings?.defaultProvider) {
			changes.push(`defaultProvider: ${settings?.defaultProvider ?? "（未设置）"} -> ${parsed.provider}`);
		}
		if (parsed.model !== settings?.defaultModel) {
			changes.push(`defaultModel: ${settings?.defaultModel ?? "（未设置）"} -> ${parsed.model}`);
		}
		next.defaultProvider = parsed.provider;
		next.defaultModel = parsed.model;
	}
	if (level !== undefined) {
		if (!LEVELS.includes(level)) {
			throw new Error(`未知的思考等级：${level}（可选：${LEVELS.join(", ")}）`);
		}
		if (level !== settings?.defaultThinkingLevel) {
			changes.push(`defaultThinkingLevel: ${settings?.defaultThinkingLevel ?? "（未设置）"} -> ${level}`);
		}
		next.defaultThinkingLevel = level;
	}
	if (!changes.length) {
		// Genuinely nothing to do. Distinguish the cases so the message says why:
		// same model with no level requested is a harmless no-op; same values
		// despite explicit arguments is a user mistake worth reporting.
		if (level === undefined && ref) return { changes, next };
		throw new Error("没有要修改的字段：给出与当前相同的值");
	}
	return { changes, next };
}

// The only place this flow touches disk.
export async function applyDefault(ctx, plan) {
	const bakErr = backupFile(settingsPath());
	if (bakErr) notify(ctx, `${bakErr}，settings.json 将在没有备份的情况下写入。`, "warning");
	try {
		writeJson(settingsPath(), plan.next);
	} catch (err) {
		notify(ctx, `写入 settings.json 失败：${errorMessage(err)}`, "error");
		return false;
	}
	notify(ctx, `已写入 settings.json（保留备份）：\n${plan.changes.map((c) => `  ${c}`).join("\n")}\n新会话生效（当前会话继续用已选的模型）。`);
	return true;
}

async function defaultFromArgs(ctx, { options, positionals }) {
	const [ref, level] = positionals;
	if (positionals.length > 2) {
		return notify(ctx, "参数过多：/model-config default <provider>/<model> [level]", "error");
	}
	const settings = readSettings();
	if (!ref) {
		notify(ctx, describeCurrent(settings));
		return;
	}
	const settingsBase = settings ?? {};
	const problem = validateRef(ref, readModelsConfig().providers ?? {}, settingsBase);
	if (problem) return notify(ctx, problem, "error");

	let plan;
	try {
		plan = planDefault({ ref, level, settings: settingsBase });
	} catch (err) {
		return notify(ctx, `default 失败：${errorMessage(err)}`, "error");
	}

	const wantsWrite = options.flags.has("all") || options.flags.has("yes") || options.flags.has("apply");
	if (!wantsWrite) {
		notify(ctx, `计划修改：\n${plan.changes.map((c) => `  ${c}`).join("\n")}\n\n什么都没写入。确认无误加 --all 执行。`);
		return;
	}
	await applyDefault(ctx, plan);
}

// ---- interactive form -----------------------------------------------------

export async function defaultFlow(ctx, { argv } = {}) {
	if (Array.isArray(argv)) {
		const options = restrictOptions(
			"default",
			parseOptions(argv),
			new Set(["all", "yes", "apply", "help"]),
			new Set(),
		);
		if (options.flags.has("help")) {
			notify(ctx, DEFAULT_USAGE);
			return;
		}
		return defaultFromArgs(ctx, { options, positionals: options.positional });
	}

	// Interactive: read-only summary is always available; changing values needs
	// the UI for the picker and the confirm.
	const settings = readSettings();
	if (!canPrompt(ctx)) {
		notify(ctx, describeCurrent(settings));
		notify(ctx, DEFAULT_USAGE);
		return;
	}
	requireUI(ctx, "default");

	let config;
	try {
		config = readModelsConfig();
	} catch (err) {
		return notify(ctx, errorMessage(err), "error");
	}
	const providers = config.providers ?? {};
	const ids = Object.keys(providers);
	if (!ids.length) return notify(ctx, "models.json 里还没有任何供应商，先 add 一个。");

	notify(ctx, describeCurrent(settings));
	const pid = await ctx.ui.select("默认用哪个供应商？", ids);
	if (!pid) return notify(ctx, CANCELLED);
	const models = (providers[pid].models ?? []).map((m) => m?.id).filter(Boolean);
	if (!models.length) return notify(ctx, `${pid} 没有静态模型列表，无法选择默认模型。`, "error");
	const model = await ctx.ui.select(`默认用 ${pid} 的哪个模型？`, models);
	if (!model) return notify(ctx, CANCELLED);

	const level = await ctx.ui.select("默认思考等级（选当前值保持不变）", [
		`${settings?.defaultThinkingLevel ?? "（未设置）"}（当前）`,
		...LEVELS.filter((l) => l !== settings?.defaultThinkingLevel),
	]);
	if (level === undefined) return notify(ctx, CANCELLED);
	const chosenLevel = level.startsWith("（未设置）") ? undefined : level.replace(/（当前）$/, "").trim();

	const plan = planDefault({ ref: `${pid}/${model}`, level: chosenLevel, settings: settings ?? {} });
	const ok = await ctx.ui.confirm("设置默认", `${describeChangeList(plan)}\n写入 settings.json？`);
	if (!ok) return notify(ctx, CANCELLED);
	await applyDefault(ctx, plan);
}

function describeChangeList(plan) {
	return plan.changes.length ? plan.changes.map((c) => `  ${c}`).join("\n") : "  （无变化）";
}

const DEFAULT_USAGE = [
	"用法：",
	"  /model-config default                      查看当前默认",
	"  /model-config default me/glm-5.3           设置默认供应商/模型（脚本化需 --all 写入）",
	"  /model-config default me/glm-5.3 high      同时设置思考等级",
].join("\n");
