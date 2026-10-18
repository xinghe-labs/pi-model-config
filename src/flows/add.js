// `/model-setup add` — five questions, everything else inferred.
//
//   1. endpoint base URL
//   2. API type (pre-selected from the URL)
//   3. API key
//   4. models (probed from the endpoint, or typed by hand)
//   5. provider id (default from the host)
//
// Context window, output limit, reasoning, image input and thinking levels are
// resolved from endpoint metadata, then models.dev, then the model name.
import { API_TYPES, ZERO_COST } from "../const.js";
import { inferApi, maskKey, suggestProviderId } from "../infer.js";
import { backupFile, readModelsConfig, writeJson } from "../json-file.js";
import { loadOfficialData } from "../official.js";
import { errorMessage, notify, requireUI } from "../output.js";
import { modelsJsonPath } from "../paths.js";
import { fetchModelMeta } from "../probe.js";
import { SOURCE_LABEL, resolveModelMeta } from "../resolve.js";
import { applyScopeUpdate } from "../scope.js";
import { isRuntimeProvider, readUserConfig } from "../user-config.js";

const CANCELLED = "Cancelled";
const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];

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

export async function addFlow(ctx, { fetchImpl = fetch } = {}) {
	if (!requireUI(ctx, "add")) return;

	const baseUrlInput = await ctx.ui.input("Endpoint base URL", "https://api.example.com/v1");
	if (baseUrlInput === undefined) return notify(ctx, CANCELLED);
	const baseUrl = baseUrlInput.trim().replace(/\/+$/, "");
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
	const official = await loadOfficialData({ fetchImpl });
	const resolved = metas.map((m) => ({ meta: m, ...resolveModelMeta(m.id, api, m, official) }));

	const config = existingConfig;
	config.providers ??= {};
	config.providers[pid] = {
		name: pid,
		baseUrl,
		apiKey: apiKey || "none",
		api,
		// cost is spread first and last: a resolved definition always carries it,
		// and the outer spread guarantees it even if resolution changes.
		models: resolved.map((r) => ({ cost: { ...ZERO_COST }, ...r.def })),
	};
	backupFile(modelsJsonPath());
	try {
		writeJson(modelsJsonPath(), config);
	} catch (err) {
		return notify(ctx, `Writing models.json failed: ${errorMessage(err)}`, "error");
	}

	// The refresh is not allowed to abort the flow: enabledModels still has to be
	// updated, otherwise a scoped /model list never shows the new provider.
	try {
		await ctx.modelRegistry.refresh({ providers: [pid] });
	} catch (err) {
		notify(ctx, `Written, but the registry refresh failed (a restart will load it): ${errorMessage(err)}`, "warning");
	}

	const detail = resolved
		.map(({ def, sources, meta }) => {
			const efforts = def.thinkingLevelMap ? Object.values(def.thinkingLevelMap).filter(Boolean) : [];
			const bare = meta?.contextWindow === undefined && meta?.reasoning === undefined && meta?.vision === undefined;
			return (
				`- ${def.id}  ctx=${def.contextWindow} (${SOURCE_LABEL[sources.contextWindow]})` +
				`  max=${def.maxTokens} (${SOURCE_LABEL[sources.maxTokens]})` +
				`${def.reasoning ? `  reasoning (${SOURCE_LABEL[sources.reasoning]})${efforts.length ? ` [${efforts.join("/")}]` : ""}` : ""}` +
				`${def.input.includes("image") ? `  +image (${SOURCE_LABEL[sources.vision]})` : ""}` +
				`${bare ? "  (endpoint reported no metadata)" : ""}`
			);
		})
		.join("\n");
	notify(
		ctx,
		`Configured ${pid}: ${resolved.length} model(s), api=${api}, key=${maskKey(apiKey)}\n${detail}\n` +
			"Inferred from endpoint metadata > models.dev > model name. Edit models.json by hand at any time, " +
			"or re-audit with /model-setup check. The original file was backed up.",
	);

	const warn = readUserConfig().error;
	if (warn) notify(ctx, warn, "warning");
	applyScopeUpdate(ctx, pid);
	notify(ctx, `Use /model to select ${pid}/<model> (switching affects this session only).`);
}
