// `/model-setup add` — add or replace one endpoint.
//
// Interactive form: five questions (URL, API type, key, models, provider id).
// Scripted form:   `/model-setup add <url> [<key>] [--id x] [--api y] [--all|--only a,b]`
//                  With neither --all nor --only it prints the plan and writes
//                  nothing, so a gateway's 200 models are never dumped in blind.
//
// Context window, output limit, reasoning, image input and thinking levels are
// resolved from endpoint metadata, then models.dev, then the model name. The
// same helpers back both forms, so they cannot drift apart.
import { API_TYPES, API_VALUES, ZERO_COST } from "../const.js";
import { USAGE_TEXT, onlyIds, parseOptions, wantsWrite } from "../args.js";
import { inferApi, maskKey, suggestProviderId } from "../infer.js";
import { backupFile, readModelsConfig, writeJson } from "../json-file.js";
import { loadOfficialData } from "../official.js";
import { errorMessage, notify } from "../output.js";
import { modelsJsonPath } from "../paths.js";
import { fetchModelMeta } from "../probe.js";
import { SOURCE_LABEL, resolveModelMeta } from "../resolve.js";
import { applyScopeUpdate } from "../scope.js";
import { isRuntimeProvider, readUserConfig } from "../user-config.js";

const CANCELLED = "Cancelled";
const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];
const MAX_PLAN_LINES = 40;

async function promptModelIds(ctx) {
	const raw = await ctx.ui.input("Model IDs (comma or space separated)", "gpt-4o, deepseek-v4-pro");
	if (raw === undefined) return undefined;
	return raw.split(/[\s,]+/).filter(Boolean);
}

async function pickModels(ctx, ids) {
	const how = await ctx.ui.select(`Probed ${ids.length} model(s). Add how?`, [
		"Add all of them",
		"Pick one by one",
		"Skip and type the IDs myself",
	]);
	if (how === undefined) return undefined;
	if (how === "Add all of them") return ids;
	if (how === "Skip and type the IDs myself") return promptModelIds(ctx);
	const chosen = new Set();
	for (;;) {
		const rest = ids.filter((id) => !chosen.has(id));
		if (!rest.length) break;
		const pick = await ctx.ui.select(`Pick a model (${chosen.size} selected)`, [...rest, "— done —"]);
		if (pick === undefined || pick === "— done —") break;
		chosen.add(pick);
	}
	return [...chosen];
}

// Plain http sends the API key in the clear. Loopback is exempt; anything else is
// a real decision, so it is asked rather than assumed.
async function confirmPlaintext(ctx, baseUrl) {
	if (!/^http:\/\//i.test(baseUrl)) return true;
	let hostname = "";
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		hostname = "";
	}
	if (LOOPBACK.includes(hostname)) return true;
	return Boolean(await ctx.ui.confirm("Plaintext warning", "This endpoint uses http://, so the API key is sent unencrypted. Continue?"));
}

async function chooseApi(ctx, baseUrl) {
	const guessed = inferApi(baseUrl);
	const ordered = [...API_TYPES.filter((t) => t.value === guessed), ...API_TYPES.filter((t) => t.value !== guessed)];
	const labels = ordered.map((t) =>
		t.value === guessed ? `${t.value} — ${t.hint} (guessed from URL, press enter to accept)` : `${t.value} — ${t.hint}`,
	);
	const picked = await ctx.ui.select("API type", labels);
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
		throw new Error(`Provider id may only contain letters, digits, - and _: ${raw}`);
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
		`${bare ? "  (endpoint reported no metadata)" : ""}`
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
	if (!baseUrl) throw new Error("No endpoint URL given");
	if (!/^https?:\/\//i.test(baseUrl)) throw new Error(`Not a URL: ${baseUrl}`);

	const chosenApi = api ?? inferApi(baseUrl);
	if (!API_VALUES.includes(chosenApi)) {
		throw new Error(`Unknown API type: ${chosenApi} (expected one of ${API_VALUES.join(", ")})`);
	}

	const providerId = validateProviderId(String(pid ?? "").trim() || suggestProviderId(baseUrl));

	// Read first: an unparseable models.json must stop us before the probe, not
	// after the user has waited for it.
	const config = readModelsConfig();

	const probed = await fetchModelMeta(baseUrl, apiKey, chosenApi, { fetchImpl });
	if (!probed.length) throw new Error(`The endpoint listed no models at ${baseUrl}`);

	let metas = probed;
	if (only && only.length) {
		const have = new Set(probed.map((m) => m.id));
		const missing = only.filter((id) => !have.has(id));
		if (missing.length) throw new Error(`The endpoint does not list: ${missing.join(", ")}`);
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
		(plan.replaces ? "  (exists; it will be replaced)" : "");
	const count =
		plan.metas.length === plan.probed.length
			? `Probed ${plan.probed.length} model(s); adding all of them:`
			: `Probed ${plan.probed.length} model(s); adding ${plan.metas.length}:`;
	return [
		head,
		count,
		renderResolved(plan.resolved, MAX_PLAN_LINES),
		"",
		"Inferred from endpoint metadata > models.dev > model name.",
		"models.json would be backed up and then rewritten.",
	].join("\n");
}

// The only place an add touches disk.
export async function applyAdd(ctx, plan) {
	// Re-read: the plan was made before a probe that may have taken a while, and
	// another writer may have been here since.
	const config = readModelsConfig();
	config.providers ??= {};
	config.providers[plan.pid] = buildProvider(plan);

	backupFile(modelsJsonPath());
	try {
		writeJson(modelsJsonPath(), config);
	} catch (err) {
		return notify(ctx, `Writing models.json failed: ${errorMessage(err)}`, "error");
	}

	// The refresh is not allowed to abort the flow: enabledModels still has to be
	// updated, otherwise a scoped /model list never shows the new provider.
	try {
		await ctx.modelRegistry.refresh({ providers: [plan.pid] });
	} catch (err) {
		notify(ctx, `Written, but the registry refresh failed (a restart will load it): ${errorMessage(err)}`, "warning");
	}

	notify(
		ctx,
		`Configured ${plan.pid}: ${plan.resolved.length} model(s), api=${plan.api}, key=${maskKey(plan.apiKey)}\n` +
			`${renderResolved(plan.resolved)}\n` +
			"Inferred from endpoint metadata > models.dev > model name. Edit models.json by hand at any time, " +
			"or re-audit with /model-setup check. The original file was backed up.",
	);

	const warn = readUserConfig().error;
	if (warn) notify(ctx, warn, "warning");
	applyScopeUpdate(ctx, plan.pid);
	notify(ctx, `Use /model to select ${plan.pid}/<model> (switching affects this session only).`);
	return plan;
}

// ---- scripted form --------------------------------------------------------

export async function addFromArgs(ctx, { options, positionals, fetchImpl = fetch }) {
	if (options.flags.has("help")) return notify(ctx, USAGE_TEXT);

	const [url, keyArg] = positionals;
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
		return notify(ctx, `add failed: ${errorMessage(err)}\nPass the key as the second argument or with --key.`, "error");
	}

	if (!wantsWrite(options)) {
		notify(
			ctx,
			`${renderAddPlan(plan)}\n\nNothing was written. Re-run with --all to add every probed model, or ` +
				`--only <ids> to add some of them.`,
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
		const options = parseOptions(argv);
		return addFromArgs(ctx, { options, positionals: options.positional, fetchImpl });
	}

	if (!(ctx?.hasUI && typeof ctx.ui?.select === "function")) {
		notify(ctx, "add needs an interactive session; this mode cannot prompt.", "error");
		notify(ctx, USAGE_TEXT);
		return;
	}

	const baseUrlInput = await ctx.ui.input("Endpoint base URL", "https://api.example.com/v1");
	if (baseUrlInput === undefined) return notify(ctx, CANCELLED);
	const baseUrl = normalizeBaseUrl(baseUrlInput);
	if (!baseUrl) return notify(ctx, CANCELLED);
	if (!/^https?:\/\//i.test(baseUrl)) return notify(ctx, `Not a URL: ${baseUrl}`, "error");
	if (!(await confirmPlaintext(ctx, baseUrl))) return notify(ctx, CANCELLED);

	const api = await chooseApi(ctx, baseUrl);
	if (api === undefined) return notify(ctx, CANCELLED);

	const apiKeyInput = await ctx.ui.input("API key (blank for a local server; input is echoed)", "sk-...");
	if (apiKeyInput === undefined) return notify(ctx, CANCELLED);
	const apiKey = apiKeyInput.trim();

	// Probe first: the model list and its metadata come from the same request.
	// A failed probe is not an error — the user can type the IDs.
	let metas;
	try {
		notify(ctx, "Probing the model list…");
		const probed = await fetchModelMeta(baseUrl, apiKey, api, { fetchImpl });
		const ids = await pickModels(ctx, probed.map((m) => m.id));
		if (ids === undefined) return notify(ctx, CANCELLED);
		const wanted = new Set(ids);
		const picked = probed.filter((m) => wanted.has(m.id));
		metas = picked.length ? picked : ids.map((id) => ({ id }));
	} catch (err) {
		notify(ctx, `Probe failed (${errorMessage(err)}); enter the model IDs by hand.`, "warning");
		const ids = await promptModelIds(ctx);
		if (ids === undefined) return notify(ctx, CANCELLED);
		metas = ids.map((id) => ({ id }));
	}
	if (!metas.length) return notify(ctx, "No models to add", "error");

	const suggested = suggestProviderId(baseUrl);
	const pidInput = await ctx.ui.input("Provider id (the key in models.json, press enter for the suggestion)", suggested);
	if (pidInput === undefined) return notify(ctx, CANCELLED);
	const pid = pidInput.trim() || suggested;
	if (!/^[A-Za-z0-9_-]+$/.test(pid)) return notify(ctx, `Provider id may only contain letters, digits, - and _: ${pid}`, "error");

	// Read before warning so an unparseable models.json stops here, not after four
	// more questions.
	let existingConfig;
	try {
		existingConfig = readModelsConfig();
	} catch (err) {
		return notify(ctx, errorMessage(err), "error");
	}
	if (existingConfig.providers?.[pid]) {
		notify(ctx, `${pid} already exists and will be replaced (models.json is backed up first).`, "warning");
	}
	if (isRuntimeProvider(pid)) {
		notify(
			ctx,
			`Note: ${pid} is listed as a runtime provider, so another extension replaces its models when it refreshes. ` +
				"Model parameters written here only act as the static fallback (apiKey / baseUrl are still read). " +
				"Consider a different id, or manage this endpoint in that extension.",
			"warning",
		);
	}

	notify(ctx, "Fetching official model data from models.dev…");
	const resolved = await resolveModels(metas, api, { fetchImpl });
	return applyAdd(ctx, { baseUrl, apiKey, api, pid, probed: metas, metas, resolved, replaces: false });
}
