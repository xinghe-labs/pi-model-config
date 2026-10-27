// `/model-config edit` — change one provider's connection fields without
// touching anything else.
//
// The difference from `add`: add is a whole-table replace (models are re-probed
// and rewritten), edit updates only the fields the user actually gave and keeps
// the model list as-is. Changing baseUrl or api triggers one verification probe
// against the new endpoint — if it cannot be read, nothing is written, the same
// rule check and sync already live by. A failed probe never deletes models.
//
// Forms:
//   /model-config edit                 pick a provider, then edit field by field
//   /model-config edit <pid>           straight into that provider
//   /model-config edit <pid> --url ... --key ... --api ... [--id new] [--all]
//
// Without --all the scripted form prints the planned diff and writes nothing.
// Renaming via --id also offers to clean the old provider's entries out of
// enabledModels and append the new id.
import { API_TYPES, API_VALUES } from "../const.js";
import { parseOptions, restrictOptions } from "../args.js";
import { inferApi, maskKey } from "../infer.js";
import { backupFile, readModelsConfig, writeJson } from "../json-file.js";
import { errorMessage, notify, canPrompt, requireUI } from "../output.js";
import { modelsJsonPath } from "../paths.js";
import { probeHeaders, probeUrl } from "../probe.js";
import { applyScopeUpdate, removeScopeUpdate } from "../scope.js";
import { normalizeBaseUrl, validateProviderId } from "./add.js";

const CANCELLED = "已取消";
const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];

const EDIT_USAGE = [
	"用法：",
	"  /model-config edit                选一个供应商，逐项修改（回车跳过）",
	"  /model-config edit <pid>          直接进入该供应商",
	"  /model-config edit <pid> [选项]",
	"      --url <url>        新的端点地址",
	"      --key <key>        新的 API Key",
	"      --api <type>       openai-completions | openai-responses | anthropic-messages | google-generative-ai",
	"      --id <new-pid>     重命名供应商（同步处理 enabledModels）",
	"      --all              应用修改（不带则只打印计划）",
	"      --dry-run          即使带了 --all 也只打印计划",
	"",
	"只修改给出的字段：模型列表、忽略名单等原样保留。",
	"修改 baseUrl / api 会先探测新端点，探测失败不写入。",
].join("\n");

// Shared with add's scripted gate: a non-loopback http URL sends the key in the
// clear, so a scripted edit needs an explicit --all to proceed.
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

// A light verification probe: not the whole metadata normalization, just "does
// this endpoint answer". Returns { ok, ids?, status?, err? }.
async function verifyEndpoint(baseUrl, apiKey, api, { fetchImpl = fetch } = {}) {
	try {
		const res = await fetchImpl(probeUrl(baseUrl, apiKey, api), {
			headers: probeHeaders(apiKey, api),
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) return { ok: false, status: res.status };
		const data = await res.json();
		const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
		const ids = new Set(
			list
				.map((m) => (typeof m === "string" ? m : m?.id ?? m?.name?.replace(/^models\//, "")))
				.filter(Boolean),
		);
		return { ok: true, ids };
	} catch (err) {
		return { ok: false, err };
	}
}

// Fields that may change. A changed baseUrl or api re-points the models at a
// different dialect or host, so those changes need the verification probe.
const FIELDS = [
	{ key: "baseUrl", label: "端点地址" },
	{ key: "apiKey", label: "API Key" },
	{ key: "api", label: "API 类型" },
];

function currentMasked(provider) {
	const key = provider.apiKey && provider.apiKey !== "none" ? provider.apiKey : "";
	return key ? maskKey(key) : "（无 key）";
}

function describeChange(key, from, to) {
	const shown = (v) => (v === "" || v === "none" ? "（无 key）" : key === "apiKey" ? maskKey(v) : v);
	return `${key}: ${shown(from)} -> ${shown(to)}`;
}

// Compute the update without touching disk. Throws on anything the caller
// should report (unknown provider, bad URL/API, nothing to change, dead
// endpoint). `updates.pid` carries the rename.
export async function planEdit({ pid, baseUrl, apiKey, api, newPid, fetchImpl = fetch }) {
	const targetPid = String(pid ?? "").trim();
	if (!targetPid) throw new Error("没有指定要修改的供应商");

	const config = readModelsConfig();
	const provider = config.providers?.[targetPid];
	if (!provider) throw new Error(`models.json 里没有这个供应商：${targetPid}`);

	const updates = {};
	if (baseUrl !== undefined) {
		const trimmed = normalizeBaseUrl(baseUrl);
		if (!trimmed) throw new Error("URL 为空");
		if (!/^https?:\/\//i.test(trimmed)) throw new Error(`不是有效的 URL：${trimmed}`);
		if (trimmed !== provider.baseUrl) updates.baseUrl = trimmed;
	}
	if (apiKey !== undefined) {
		const key = String(apiKey ?? "").trim();
		const normalized = key || "none";
		if (normalized !== (provider.apiKey ?? "none")) updates.apiKey = normalized;
	}
	if (api !== undefined) {
		if (!API_VALUES.includes(api)) throw new Error(`未知的 API 类型：${api}（可选：${API_VALUES.join(", ")}）`);
		if (api !== provider.api) updates.api = api;
	}
	if (newPid !== undefined && String(newPid).trim() !== "") {
		const cleaned = validateProviderId(String(newPid).trim());
		if (cleaned !== targetPid && config.providers?.[cleaned]) {
			throw new Error(`供应商 id 已被占用：${cleaned}`);
		}
		if (cleaned !== targetPid) updates.pid = cleaned;
	}

	if (!Object.keys(updates).length) {
		throw new Error("没有要修改的字段：至少给出 --url / --key / --api / --id 中的一个");
	}

	let verification;
	if (updates.baseUrl !== undefined || updates.api !== undefined) {
		const nextUrl = updates.baseUrl ?? provider.baseUrl;
		const nextApi = updates.api ?? provider.api;
		const nextKey = updates.apiKey !== undefined ? updates.apiKey : provider.apiKey;
		verification = await verifyEndpoint(nextUrl, nextKey, nextApi, { fetchImpl });
		if (!verification.ok) {
			const reason = verification.status ? `HTTP ${verification.status}` : errorMessage(verification.err);
			throw new Error(`新端点无法访问（${reason}）：什么都没改。修好端点或先核对 URL / Key 再试。`);
		}
	}

	return {
		pid: targetPid,
		provider,
		updates,
		verification,
		plaintext: plaintextRisk(updates.baseUrl ?? provider.baseUrl),
	};
}

export function renderEditPlan(plan) {
	const lines = [`修改 ${plan.pid}：`];
	for (const key of Object.keys(plan.updates)) {
		if (key === "pid") {
			lines.push(`  id: ${plan.pid} -> ${plan.updates.pid}`);
			continue;
		}
		lines.push(`  ${describeChange(key, plan.provider[key] ?? "", plan.updates[key])}`);
	}
	if (plan.verification?.ok) {
		const kept = plan.provider.models?.length ?? 0;
		lines.push(`  已验证新端点可访问（保留 ${kept} 个模型的列表不动）`);
	}
	if (plan.plaintext) lines.push("  ⚠ 该端点使用 http://，API Key 将以明文发送");
	lines.push("模型列表、忽略名单、cost 等其余字段原样保留；写盘前会先备份。");
	return lines.join("\n");
}

// The only place an edit touches disk.
export async function applyEdit(ctx, plan) {
	// Re-read: dialogs / probes may have taken a while, another writer may have
	// been here since.
	const fresh = readModelsConfig();
	const provider = fresh.providers?.[plan.pid];
	if (!provider) {
		notify(ctx, `${plan.pid} 已不存在，什么都没改。`, "error");
		return undefined;
	}

	const bakErr = backupFile(modelsJsonPath());
	if (bakErr) notify(ctx, `${bakErr}，models.json 将在没有备份的情况下写入。`, "warning");

	const renamedTo = plan.updates.pid;
	const next = { ...provider };
	for (const [key, value] of Object.entries(plan.updates)) {
		if (key === "pid") continue;
		next[key] = value;
	}
	if (renamedTo) {
		delete fresh.providers[plan.pid];
		fresh.providers[renamedTo] = next;
	} else {
		fresh.providers[plan.pid] = next;
	}

	try {
		writeJson(modelsJsonPath(), fresh);
	} catch (err) {
		notify(ctx, `写入 models.json 失败：${errorMessage(err)}`, "error");
		return undefined;
	}

	const changed = Object.keys(plan.updates)
		.filter((k) => k !== "pid")
		.map((k) => describeChange(k, plan.provider[k] ?? "", plan.updates[k]));
	notify(
		ctx,
		[
			`已修改 ${renamedTo ?? plan.pid}${renamedTo ? `（由 ${plan.pid} 重命名）` : ""}：`,
			...changed.map((c) => `  ${c}`),
			"模型列表未动。baseUrl/apiKey 的修改无需重启：另一个扩展（如 sub-models）每次刷新都会重读 models.json。",
		].join("\n"),
	);

	// A rename leaves the /model snapshot and enabledModels pointing at the old
	// id until the session restarts; the settings cleanup can happen right away.
	if (renamedTo) {
		if (canPrompt(ctx)) {
			const ok = await ctx.ui.confirm("清理列表", `enabledModels 里 ${plan.pid} 的条目要改成 ${renamedTo} 吗？`);
			if (ok) {
				removeScopeUpdate(ctx, plan.pid);
				applyScopeUpdate(ctx, renamedTo);
			}
		} else {
			notify(ctx, `提示：enabledModels 里若有 ${plan.pid}/… 条目，需要手动改成 ${renamedTo}/…。`, "warning");
		}
	}

	try {
		await ctx.modelRegistry.refresh({ providers: [renamedTo ?? plan.pid] });
	} catch (err) {
		notify(ctx, `已写入，但注册表刷新失败（重启后会加载）：${errorMessage(err)}`, "warning");
	}
	return plan;
}

// ---- scripted form --------------------------------------------------------

async function editFromArgs(ctx, { options, positionals, fetchImpl }) {
	const [pid, ...rest] = positionals;
	if (rest.length) {
		return notify(ctx, "参数过多：edit 只接受一个供应商 id，其余字段用选项给出。", "error");
	}

	let plan;
	try {
		plan = await planEdit({
			pid,
			baseUrl: options.values.url,
			apiKey: options.values.key,
			api: options.values.api,
			newPid: options.values.id,
			fetchImpl,
		});
	} catch (err) {
		return notify(ctx, `edit 失败：${errorMessage(err)}`, "error");
	}

	if (options.flags.has("dry-run") || !wantsWrite(options)) {
		notify(ctx, `${renderEditPlan(plan)}\n\n什么都没写入。确认无误加 --all 执行。`);
		return plan;
	}
	// The scripted plaintext gate mirrors add: the interactive flow asks, a
	// scripted run has no dialog, so only an explicit --all may ship a key over
	// plain http.
	if (plan.plaintext) {
		return notify(
			ctx,
			"该端点使用 http://，API Key 将以明文发送。脚本化 edit 拒绝执行：" +
				"请改用 https，或用交互式 edit 确认，或用 --dry-run 只看计划。",
			"error",
		);
	}
	return applyEdit(ctx, plan);
}

function wantsWrite(options) {
	return options.flags.has("all") || options.flags.has("yes") || options.flags.has("apply");
}

// ---- interactive form -----------------------------------------------------

async function askField(ctx, provider, field) {
	if (field.key === "baseUrl") {
		const raw = await ctx.ui.input("新的端点地址（回车保持不变）", provider.baseUrl ?? "https://api.example.com/v1");
		if (raw === undefined) return undefined;
		const trimmed = normalizeBaseUrl(raw.trim());
		return trimmed && trimmed !== provider.baseUrl ? trimmed : undefined;
	}
	if (field.key === "apiKey") {
		const raw = await ctx.ui.input(`新的 API Key（当前 ${currentMasked(provider)}，回车保持不变）`, "sk-...");
		if (raw === undefined) return undefined;
		const key = raw.trim();
		return key && key !== provider.apiKey ? key : undefined;
	}
	// api: current value first, labelled as such; picking it is a no-op.
	const guessed = inferApi(provider.baseUrl ?? "");
	const ordered = [...API_TYPES.filter((t) => t.value === guessed), ...API_TYPES.filter((t) => t.value !== guessed)];
	const labels = ordered.map((t) => (t.value === provider.api ? `${t.value}（当前）` : t.value));
	const picked = await ctx.ui.select("API 类型（当前项回车保持不变）", labels);
	if (picked === undefined) return undefined;
	const chosen = ordered[labels.indexOf(picked)]?.value;
	return chosen && chosen !== provider.api ? chosen : undefined;
}

export async function editFlow(ctx, { fetchImpl = fetch, argv } = {}) {
	if (Array.isArray(argv)) {
		const options = restrictOptions(
			"edit",
			parseOptions(argv),
			new Set(["all", "yes", "apply", "dry-run", "help"]),
			new Set(["id", "api", "key", "url"]),
		);
		if (options.flags.has("help")) {
			notify(ctx, EDIT_USAGE);
			return;
		}
		return editFromArgs(ctx, { options, positionals: options.positional, fetchImpl });
	}

	if (!requireUI(ctx, "edit")) {
		notify(ctx, EDIT_USAGE);
		return;
	}

	let config;
	try {
		config = readModelsConfig();
	} catch (err) {
		return notify(ctx, errorMessage(err), "error");
	}
	const ids = Object.keys(config?.providers ?? {});
	if (!ids.length) return notify(ctx, "models.json 里还没有任何供应商");

	const pid = await ctx.ui.select("修改哪个供应商？", ids);
	if (!pid) return notify(ctx, CANCELLED);
	let provider = config.providers[pid] ?? {};

	const updates = {};
	let newPid;
	const fields = [...FIELDS];
	for (;;) {
		const labels = [...fields.map((f) => f.label), "重命名供应商 id", "— 完成，应用修改 —"];
		const choice = await ctx.ui.select(`修改 ${pid} 的哪一项？（其余字段不受影响）`, labels);
		if (choice === undefined || choice === "— 完成，应用修改 —") break;
		if (choice === "重命名供应商 id") {
			const raw = await ctx.ui.input("新的供应商 id", pid);
			if (raw === undefined) return notify(ctx, CANCELLED);
			const cleaned = raw.trim();
			if (!cleaned || cleaned === pid) continue;
			try {
				newPid = validateProviderId(cleaned);
			} catch (err) {
				notify(ctx, errorMessage(err), "error");
			}
			continue;
		}
		const field = fields.find((f) => f.label === choice);
		const value = await askField(ctx, provider, field);
		if (value === undefined) continue;
		updates[field.key] = value;
		if (field.key === "baseUrl") {
			// Later questions describe the endpoint being edited now.
			provider = { ...provider, baseUrl: value };
		}
		// One edit per field is enough; drop it from the menu.
		fields.splice(fields.indexOf(field), 1);
		if (!fields.length) {
			notify(ctx, "所有可改字段都已设置。");
			break;
		}
	}

	if (!Object.keys(updates).length && !newPid) return notify(ctx, "没有修改任何字段，什么都没写。");

	// The probe runs before any confirmation: a dead endpoint should end the
	// flow before the user is asked to consent to nothing.
	let plan;
	try {
		plan = await planEdit({
			pid,
			baseUrl: updates.baseUrl,
			apiKey: updates.apiKey,
			api: updates.api,
			newPid,
			fetchImpl,
		});
	} catch (err) {
		return notify(ctx, `edit 失败：${errorMessage(err)}`, "error");
	}
	if (plan.plaintext) {
		const ok = await ctx.ui.confirm("明文传输警告", "该端点使用 http://，API Key 将以明文发送。继续吗？");
		if (!ok) return notify(ctx, CANCELLED);
	}
	const ok = await ctx.ui.confirm("应用修改", `${renderEditPlan(plan)}\n\n写入 models.json？`);
	if (!ok) return notify(ctx, CANCELLED);
	return applyEdit(ctx, plan);
}
