// `/model-config add` — add or replace one endpoint.
//
// Interactive form: five questions (URL, API type, key, models, provider id).
// Scripted form:   `/model-config add <url> [<key>] [--id x] [--api y] [--all|--only a,b]`
//                  With neither --all nor --only it prints the plan and writes
//                  nothing, so a gateway's 200 models are never dumped in blind.
//
// Context window, output limit, reasoning, image input and thinking levels are
// resolved from endpoint metadata, then models.dev, then the model name. The
// same helpers back both forms, so they cannot drift apart.
import { API_TYPES, API_VALUES, ZERO_COST } from "../const.js";
import { USAGE_TEXT, onlyIds, parseOptions, restrictOptions, wantsAll, wantsWrite } from "../args.js";
import { inferApi, maskKey, suggestProviderId } from "../infer.js";
import { backupFile, readModelsConfig, writeJson } from "../json-file.js";
import { loadOfficialData } from "../official.js";
import { errorMessage, notify } from "../output.js";
import { authStoreKey } from "../auth-store.js";
import { modelsJsonPath } from "../paths.js";
import { fetchModelMeta } from "../probe.js";
import { SOURCE_LABEL, resolveModelMeta } from "../resolve.js";
import { applyScopeUpdate } from "../scope.js";
import { isRuntimeProvider, readUserConfig } from "../user-config.js";

const CANCELLED = "已取消";
const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];
const MAX_PLAN_LINES = 40;

async function promptModelIds(ctx) {
	const raw = await ctx.ui.input("模型 ID（逗号或空格分隔）", "gpt-4o, deepseek-v4-pro");
	if (raw === undefined) return undefined;
	return raw.split(/[\s,]+/).filter(Boolean);
}

async function pickModels(ctx, ids) {
	const how = await ctx.ui.select(`探测到 ${ids.length} 个模型，怎么加？`, [
		"全部添加",
		"逐个挑选",
		"跳过，我自己输入 ID",
	]);
	if (how === undefined) return undefined;
	if (how === "全部添加") return ids;
	if (how === "跳过，我自己输入 ID") return promptModelIds(ctx);
	const chosen = new Set();
	for (;;) {
		const rest = ids.filter((id) => !chosen.has(id));
		if (!rest.length) break;
		const pick = await ctx.ui.select(`挑选模型（已选 ${chosen.size} 个）`, [...rest, "— 完成了 —"]);
		if (pick === undefined || pick === "— 完成了 —") break;
		chosen.add(pick);
	}
	return [...chosen];
}

// Plain http sends the API key in the clear. Loopback is exempt; anything else is
// a real decision, so it is asked rather than assumed.
function plaintextRisk(baseUrl) {
	if (!/^http:\/\//i.test(baseUrl)) return false;
	let hostname = "";
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		hostname = "";
	}
	return !LOOPBACK.includes(hostname);
}

async function confirmPlaintext(ctx, baseUrl) {
	if (!plaintextRisk(baseUrl)) return true;
	return Boolean(await ctx.ui.confirm("明文传输警告", "该端点使用 http://，API Key 将以明文发送。继续吗？"));
}

async function chooseApi(ctx, baseUrl) {
	const guessed = inferApi(baseUrl);
	const ordered = [...API_TYPES.filter((t) => t.value === guessed), ...API_TYPES.filter((t) => t.value !== guessed)];
	const labels = ordered.map((t) =>
		t.value === guessed ? `${t.value} — ${t.hint}（根据 URL 推测，回车确认）` : `${t.value} — ${t.hint}`,
	);
	const picked = await ctx.ui.select("API 类型", labels);
	if (picked === undefined) return undefined;
	// select normally returns the label; tolerate a bare value so `api` can never
	// be written as undefined.
	return ordered[labels.indexOf(picked)]?.value ?? ordered.find((t) => t.value === picked)?.value ?? guessed;
}

// ---- shared core ----------------------------------------------------------
// Everything below is used by both the interactive and the scripted form.

export function normalizeBaseUrl(raw) {
	return String(raw ?? "").trim().replace(/\/+$/, "");
}

export function validateProviderId(raw) {
	if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
		throw new Error(`供应商 id 只能包含字母、数字、- 和 _：${raw}`);
	}
	return raw;
}

export function buildProvider({ pid, baseUrl, apiKey, api, resolved }) {
	return {
		name: pid,
		baseUrl,
		apiKey: apiKey || "none",
		api,
		// cost is spread first and last: a resolved definition always carries it,
		// and the outer spread guarantees it even if resolution changes.
		models: resolved.map((r) => ({ cost: { ...ZERO_COST }, ...r.def })),
	};
}

function describeModel({ def, sources, meta }) {
	const efforts = def.thinkingLevelMap ? Object.values(def.thinkingLevelMap).filter(Boolean) : [];
	const bare = meta?.contextWindow === undefined && meta?.reasoning === undefined && meta?.vision === undefined;
	return (
		`- ${def.id}  ctx=${def.contextWindow} (${SOURCE_LABEL[sources.contextWindow]})` +
		`  max=${def.maxTokens} (${SOURCE_LABEL[sources.maxTokens]})` +
		`${def.reasoning ? `  reasoning (${SOURCE_LABEL[sources.reasoning]})${efforts.length ? ` [${efforts.join("/")}]` : ""}` : ""}` +
		`${def.input.includes("image") ? `  +image (${SOURCE_LABEL[sources.vision]})` : ""}` +
		`${bare ? "（端点未提供元数据）" : ""}`
	);
}

export function renderResolved(resolved, limit = Number.POSITIVE_INFINITY) {
	const shown = resolved.slice(0, limit).map(describeModel);
	if (resolved.length > limit) shown.push(`  … and ${resolved.length - limit} more`);
	return shown.join("\n");
}

// Resolve every probed model against models.dev and the name heuristics.
export async function resolveModels(metas, api, { fetchImpl = fetch } = {}) {
	const official = await loadOfficialData({ fetchImpl });
	return metas.map((m) => ({ meta: m, ...resolveModelMeta(m.id, api, m, official) }));
}

// Plan an add without touching disk. Throws on anything the caller should report
// as a refusal (bad URL, unknown API type, empty model list, unknown --only id).
export async function planAdd({ baseUrl: rawUrl, apiKey = "", api, pid, only, fetchImpl = fetch }) {
	const baseUrl = normalizeBaseUrl(rawUrl);
	if (!baseUrl) throw new Error("没有给出端点 URL");
	if (!/^https?:\/\//i.test(baseUrl)) throw new Error(`不是有效的 URL：${baseUrl}`);

	const chosenApi = api ?? inferApi(baseUrl);
	if (!API_VALUES.includes(chosenApi)) {
		throw new Error(`未知的 API 类型：${chosenApi}（可选：${API_VALUES.join(", ")}）`);
	}
	// A present-but-empty filter is a typo, not "everything": fail instead of
	// dumping a gateway's whole catalogue into models.json.
	if (only !== undefined && !only.length) throw new Error("--only 需要至少一个模型 id");

	const providerId = validateProviderId(String(pid ?? "").trim() || suggestProviderId(baseUrl));

	// Read first: an unparseable models.json must stop us before the probe, not
	// after the user has waited for it.
	const config = readModelsConfig();

	const probed = await fetchModelMeta(baseUrl, apiKey, chosenApi, { fetchImpl });
	if (!probed.length) throw new Error(`端点没有返回任何模型：${baseUrl}`);

	let metas = probed;
	if (only && only.length) {
		const have = new Set(probed.map((m) => m.id));
		const missing = only.filter((id) => !have.has(id));
		if (missing.length) throw new Error(`端点未提供这些模型：${missing.join(", ")}`);
		const want = new Set(only);
		metas = probed.filter((m) => want.has(m.id));
	}

	const resolved = await resolveModels(metas, chosenApi, { fetchImpl });
	return {
		baseUrl,
		apiKey,
		api: chosenApi,
		pid: providerId,
		probed,
		metas,
		resolved,
		replaces: Boolean(config.providers?.[providerId]),
	};
}

export function renderAddPlan(plan) {
	const head =
		`Endpoint ${plan.baseUrl}  ·  api=${plan.api}  ·  key=${maskKey(plan.apiKey)}  ·  provider id ${plan.pid}` +
		(plan.replaces ? "（已存在，将被替换）" : "");
	const count =
		plan.metas.length === plan.probed.length
			? `探测到 ${plan.probed.length} 个模型，将全部添加：`
			: `探测到 ${plan.probed.length} 个模型，将添加其中 ${plan.metas.length} 个：`;
	return [
		head,
		count,
		renderResolved(plan.resolved, MAX_PLAN_LINES),
		"",
		"参数推断来源：端点元数据 > models.dev > 模型名。",
		"写盘前会先备份 models.json。",
	].join("\n");
}

// The only place an add touches disk.
export async function applyAdd(ctx, plan) {
	// Re-read: the plan was made before a probe that may have taken a while, and
	// another writer may have been here since.
	const config = readModelsConfig();
	config.providers ??= {};
	config.providers[plan.pid] = buildProvider(plan);

	const bakErr = backupFile(modelsJsonPath());
	if (bakErr) notify(ctx, `${bakErr}，models.json 将在没有备份的情况下写入。`, "warning");
	try {
		writeJson(modelsJsonPath(), config);
	} catch (err) {
		return notify(ctx, `写入 models.json 失败：${errorMessage(err)}`, "error");
	}

// The refresh is not allowed to abort the flow: enabledModels still has to be
// updated, otherwise a scoped /model list never shows the new provider.
	try {
		await ctx.modelRegistry.refresh({ providers: [plan.pid] });
	} catch (err) {
		notify(ctx, `已写入，但注册表刷新失败（重启后会加载）：${errorMessage(err)}`, "warning");
	}

	// pi prefers an auth.json credential over the models.json field; if one
	// exists, the key just written is a fallback, not the live credential.
	if (authStoreKey(plan.pid) && plan.apiKey) {
		notify(
			ctx,
			`注意：auth.json 里已有 ${plan.pid} 的 stored credential，pi 将优先使用它；models.json 里的 key 只是回退。`,
			"warning",
		);
	}

	notify(
		ctx,
		`已配置 ${plan.pid}：${plan.resolved.length} 个模型，api=${plan.api}，key=${maskKey(plan.apiKey)}\n` +
			`${renderResolved(plan.resolved, MAX_PLAN_LINES)}\n` +
			"参数推断来源：端点元数据 > models.dev > 模型名。随时可以手动编辑 models.json，" +
			"或用 /model-config check 重新对账。原文件已备份。",
	);

	const warn = readUserConfig().error;
	if (warn) notify(ctx, warn, "warning");
	applyScopeUpdate(ctx, plan.pid);
	notify(ctx, `用 /model 选择 ${plan.pid}/<模型>（切换只影响当前会话）。`);
	return plan;
}

// ---- scripted form --------------------------------------------------------

export async function addFromArgs(ctx, { options, positionals, fetchImpl = fetch }) {
	if (options.flags.has("help")) return notify(ctx, USAGE_TEXT);

	// `add <url> --only m1 m2` would silently read m1 as the API key and drop m2;
	// anything beyond URL + optional key is a typo worth stopping on.
	const [url, keyArg, ...extra] = positionals;
	if (extra.length) {
		return notify(ctx, "参数过多：add 只接受端点 URL 和可选的 Key。--only 的多个模型 id 请用逗号分隔。", "error");
	}
	// The plaintext gate lives here too: the interactive flow asks, but a scripted
	// run has no dialog to ask with, and silently sending a key over http is the
	// worst default. --all/--yes is the explicit override (see README).
	const requestedUrl = normalizeBaseUrl(url);
	if (plaintextRisk(requestedUrl) && !wantsAll(options)) {
		return notify(
			ctx,
			"该端点使用 http://，API Key 将以明文发送。脚本化 add 拒绝执行：" +
				"请改用 https，或用交互式 add 确认，或明确加 --all 表示接受该风险。",
			"error",
		);
	}

	const apiKey = String(options.values.key ?? keyArg ?? process.env.PI_MODEL_CONFIG_API_KEY ?? "").trim();
	const only = onlyIds(options);

	let plan;
	try {
		plan = await planAdd({
			baseUrl: url,
			apiKey,
			api: options.values.api,
			pid: options.values.id,
			only,
			fetchImpl,
		});
	} catch (err) {
		// A 401 on a keyless call is the common failure here, and the raw message
		// ("HTTP 401") does not say what to do about it.
		return notify(ctx, `add 失败：${errorMessage(err)}\n请把 Key 作为第二个参数传入，或用 --key。`, "error");
	}

	if (!wantsWrite(options)) {
		notify(
			ctx,
			`${renderAddPlan(plan)}\n\n什么都没写入。加 --all 添加全部探测到的模型，或加 ` +
				`--only <ids> 只添加其中一部分。`,
		);
		return plan;
	}

	return applyAdd(ctx, plan);
}

// ---- interactive form -----------------------------------------------------

export async function addFlow(ctx, { fetchImpl = fetch, argv } = {}) {
	// A scripted invocation must work in print/JSON/RPC mode, where there are no
	// dialogs at all.
	if (Array.isArray(argv)) {
		const options = restrictOptions(
			"add",
			parseOptions(argv),
			new Set(["all", "yes", "apply", "dry-run", "help"]),
			new Set(["id", "api", "key", "only"]),
		);
		return addFromArgs(ctx, { options, positionals: options.positional, fetchImpl });
	}

	if (!(ctx?.hasUI && typeof ctx.ui?.select === "function")) {
		notify(ctx, "add 需要交互式会话，当前模式无法弹出对话框。", "error");
		notify(ctx, USAGE_TEXT);
		return;
	}

	const baseUrlInput = await ctx.ui.input("端点地址（base URL）", "https://api.example.com/v1");
	if (baseUrlInput === undefined) return notify(ctx, CANCELLED);
	const baseUrl = normalizeBaseUrl(baseUrlInput);
	if (!baseUrl) return notify(ctx, CANCELLED);
	if (!/^https?:\/\//i.test(baseUrl)) return notify(ctx, `不是有效的 URL：${baseUrl}`, "error");
	if (!(await confirmPlaintext(ctx, baseUrl))) return notify(ctx, CANCELLED);

	const api = await chooseApi(ctx, baseUrl);
	if (api === undefined) return notify(ctx, CANCELLED);

	const apiKeyInput = await ctx.ui.input("API Key（本地服务可留空；输入会回显）", "sk-...");
	if (apiKeyInput === undefined) return notify(ctx, CANCELLED);
	const apiKey = apiKeyInput.trim();

	// Probe first: the model list and its metadata come from the same request.
	// A failed probe is not an error — the user can type the IDs.
	let metas;
	try {
		notify(ctx, "正在探测模型列表……");
		const probed = await fetchModelMeta(baseUrl, apiKey, api, { fetchImpl });
		const ids = await pickModels(ctx, probed.map((m) => m.id));
		if (ids === undefined) return notify(ctx, CANCELLED);
		const wanted = new Set(ids);
		const picked = probed.filter((m) => wanted.has(m.id));
		metas = picked.length ? picked : ids.map((id) => ({ id }));
	} catch (err) {
		notify(ctx, `探测失败（${errorMessage(err)}），请手动输入模型 ID。`, "warning");
		const ids = await promptModelIds(ctx);
		if (ids === undefined) return notify(ctx, CANCELLED);
		metas = ids.map((id) => ({ id }));
	}
	if (!metas.length) return notify(ctx, "没有可添加的模型", "error");

	const suggested = suggestProviderId(baseUrl);
	const pidInput = await ctx.ui.input("供应商 id（models.json 里的键名，回车用建议值）", suggested);
	if (pidInput === undefined) return notify(ctx, CANCELLED);
	const pid = pidInput.trim() || suggested;
	if (!/^[A-Za-z0-9_-]+$/.test(pid)) return notify(ctx, `供应商 id 只能包含字母、数字、- 和 _：${pid}`, "error");

	// Read before warning so an unparseable models.json stops here, not after four
	// more questions.
	let existingConfig;
	try {
		existingConfig = readModelsConfig();
	} catch (err) {
		return notify(ctx, errorMessage(err), "error");
	}
	if (existingConfig.providers?.[pid]) {
		notify(ctx, `${pid} 已存在，将被替换（会先备份 models.json）。`, "warning");
	}
	if (isRuntimeProvider(pid)) {
		notify(
			ctx,
			`注意：${pid} 是运行时供应商，另一个扩展刷新时会重写它的模型列表。` +
				"这里写的模型参数只是静态兜底（apiKey / baseUrl 仍然有效）。" +
				"建议换一个 id，或直接在那个扩展里管理该端点。",
			"warning",
		);
	}

	notify(ctx, "正在从 models.dev 获取官方模型数据……");
	const resolved = await resolveModels(metas, api, { fetchImpl });
	return applyAdd(ctx, { baseUrl, apiKey, api, pid, probed: metas, metas, resolved, replaces: false });
}
