// `/model-setup sync` — make models.json's model list match what the endpoint
// currently serves: add what appeared, remove what disappeared, repair what
// drifted.
//
// `check` deliberately only reports (and repairs parameters). Sync is the one
// that changes membership, so it is a separate command with a separate opt-in.
//
// Two safety rules, both load-bearing:
//
//   1. Removal requires a *successful* probe. `planProvider` already returns an
//      empty `vanished` list when the endpoint could not be reached, so a
//      gateway that is briefly down can never wipe a configuration.
//   2. Runtime providers are skipped entirely. Their model list is produced by
//      another extension at refresh time; models.json holds a static fallback
//      that is supposed to differ from live data.
//
// Nothing is written unless --all or --only was given: the plan is printed
// first, because it names models that are about to be deleted.
import { USAGE_TEXT, onlyIds, parseOptions, wantsWrite } from "../args.js";
import { ZERO_COST } from "../const.js";
import { backupFile, readModelsConfig, writeJson } from "../json-file.js";
import { loadOfficialData } from "../official.js";
import { errorMessage, notify } from "../output.js";
import { modelsJsonPath } from "../paths.js";
import { fetchModelMeta, probeKey } from "../probe.js";
import { SOURCE_LABEL, resolveModelMeta } from "../resolve.js";
import { applyScopeUpdate } from "../scope.js";
import { isRuntimeProvider, runtimeProviders } from "../user-config.js";
import { planProvider } from "./check.js";

// An endpoint that lists the same id twice must not become two identical entries
// in models.json. First one wins; they carry the same metadata in practice.
function uniqueById(list) {
	const seen = new Set();
	const out = [];
	for (const entry of list) {
		if (!entry?.id || seen.has(entry.id)) continue;
		seen.add(entry.id);
		out.push(entry);
	}
	return out;
}

const RUNTIME_SKIP = "runtime provider; another extension owns its model list";

function emptyRow(plan, extra) {
	return { ...plan, unreachable: false, runtime: false, added: [], removed: [], changed: [], candidates: [], ...extra };
}

function describeAdded({ def, sources }) {
	const efforts = def.thinkingLevelMap ? Object.values(def.thinkingLevelMap).filter(Boolean) : [];
	return (
		`      + ${def.id}  ctx=${def.contextWindow} (${SOURCE_LABEL[sources.contextWindow]})` +
		`  max=${def.maxTokens} (${SOURCE_LABEL[sources.maxTokens]})` +
		`${def.reasoning ? `  reasoning (${SOURCE_LABEL[sources.reasoning]})${efforts.length ? ` [${efforts.join("/")}]` : ""}` : ""}` +
		`${def.input.includes("image") ? `  +image (${SOURCE_LABEL[sources.vision]})` : ""}`
	);
}

// Plan only; throws for a provider id that does not exist or an --only id the
// endpoint never offered (both are typos worth stopping on).
export async function planSync({ pids, only, fetchImpl = fetch } = {}) {
	const config = readModelsConfig();
	const providers = config.providers ?? {};
	const runtime = runtimeProviders();
	const targets = pids && pids.length ? pids : Object.keys(providers);

	const missing = targets.filter((pid) => !providers[pid]);
	if (missing.length) throw new Error(`No such provider in models.json: ${missing.join(", ")}`);
	if (!targets.length) throw new Error("models.json has no provider entries yet");

	// One models.dev request shared by every endpoint; each probe runs in parallel
	// with it (see planProvider).
	const official = loadOfficialData({ fetchImpl });
	const plans = await Promise.all(
		targets.map((pid) => planProvider({ pid, provider: providers[pid], official, fetchImpl })),
	);
	const officialData = (await official) ?? {};

	const rows = await Promise.all(
		plans.map(async (plan) => {
			if (plan.skipped) {
				// `check` treats a provider with no static list as runtime-managed and says
				// nothing. For sync that missing list is exactly what is worth filling —
				// a hand-written `{ baseUrl, api, apiKey }` with no models — but only when
				// nothing else owns the provider.
				// `planProvider` returns only { pid, skipped } for a provider it never read,
				// so the entry itself has to come from the config.
				const provider = plan.provider ?? providers[plan.pid];
				const hasList = Array.isArray(provider?.models) && provider.models.length > 0;
				if (hasList || !provider?.baseUrl) return emptyRow({ ...plan, provider }, {});
				// Say why, rather than borrowing `check`'s "no static model list" wording:
				// the reason here is ownership, not an empty fallback.
				if (isRuntimeProvider(plan.pid, runtime)) return emptyRow({ ...plan, provider }, { skipped: RUNTIME_SKIP });				let endpointList = [];
				let endpointErr;
				try {
					endpointList = await fetchModelMeta(provider.baseUrl, probeKey(provider), provider.api, { fetchImpl });
				} catch (err) {
					endpointErr = err;
				}
				if (endpointErr) return emptyRow({ ...plan, provider }, { unreachable: true, endpointErr });
				return emptyRow({ ...plan, provider }, { fillFromEmpty: true, endpointList: uniqueById(endpointList), skipped: undefined });
			}
			// A probe that failed proves nothing about which models exist. `check` still
			// repairs from models.dev / names in that case (it only reports), but sync
			// writes, so it must not act on a guess: skip the provider entirely.
			if (plan.endpointErr) return emptyRow(plan, { unreachable: true });
			return { ...plan, unreachable: false };
		}),
	);

	for (const row of rows) {
		if (row.skipped || row.unreachable) continue;
		const models = Array.isArray(row.provider.models) ? row.provider.models : [];
		const known = new Set(models.map((m) => m?.id).filter(Boolean));
		const candidates = uniqueById(row.endpointList).filter((m) => !known.has(m.id));
		const wanted = only && only.length ? new Set(only) : undefined;
		const selected = wanted ? candidates.filter((m) => wanted.has(m.id)) : candidates;
		row.candidates = candidates;
		row.added = selected.map((meta) => ({
			meta,
			...resolveModelMeta(meta.id, row.provider.api, meta, officialData),
		}));
		row.runtime = isRuntimeProvider(row.pid, runtime);
		row.removed = row.vanished ?? [];
		// A model that is about to be deleted must not also be listed as "to
		// repair": the repair would be a guess based on a name the endpoint no
		// longer serves, and reporting it twice is just noise.
		row.changed = (row.changes ?? []).filter((c) => !row.removed.includes(c.id));
	}

	// Only an id that no endpoint lists at all is an error; ids that already exist
	// in the configuration are accepted and simply add nothing.
	if (only && only.length) {
		const offered = new Set(
			rows.flatMap((r) => {
				if (r.skipped || r.unreachable) return [];
				const existing = Array.isArray(r.provider.models) ? r.provider.models : [];
				return [...r.candidates.map((m) => m.id), ...existing.map((m) => m?.id)];
			}),
		);
		const unknown = only.filter((id) => !offered.has(id));
		if (unknown.length) throw new Error(`Not offered by any endpoint: ${unknown.join(", ")}`);
	}

	return { targets, rows, only };
}

export function renderSyncPlan(plan, { prune = true } = {}) {
	const blocks = plan.rows.map((row) => {
		if (row.skipped) return `- ${row.pid}: skipped (${row.skipped})`;
		if (row.runtime) return `- ${row.pid}: skipped (${RUNTIME_SKIP})`;
		if (row.unreachable) {
			return (
				`- ${row.pid} (${row.provider.baseUrl})\n` +
				`    endpoint unreadable: ${errorMessage(row.endpointErr)}\n` +
				"    skipped: sync will not guess, and will remove nothing it cannot verify"
			);
		}

		const lines = [`- ${row.pid} (${row.provider.baseUrl})`];
		const removed = prune ? row.removed : [];
		if (row.fillFromEmpty) lines.push("    no model list yet; it will be filled from the endpoint");
		if (row.added.length) {
			lines.push(`    ${row.added.length} new model(s)`);
			lines.push(...row.added.map(describeAdded));
		}
		if (removed.length) {
			lines.push(`    ${removed.length} model(s) the endpoint no longer lists (will be removed)`);
			lines.push(...removed.map((id) => `      - ${id}`));
		} else if (row.removed.length && !prune) {
			lines.push(`    ${row.removed.length} gone model(s) kept (--no-prune)`);
		}
		if (row.changed.length) {
			lines.push(`    ${row.changed.length} model(s) to repair`);
			lines.push(...row.changed.map((c) => `      ~ ${c.id}: ${c.diffs.join(", ")}`));
		}
		if (lines.length === 1) lines.push("    already in sync");
		return lines.join("\n");
	});
	return `Model list sync:\n${blocks.join("\n")}`;
}

function pendingChanges(plan, prune) {
	return plan.rows.filter(
		(row) =>
			!row.skipped &&
			!row.runtime &&
			!row.unreachable &&
			(row.added.length || row.changed.length || (prune && row.removed.length)),
	);
}

// The only place sync touches disk.
export async function applySync(ctx, plan, { prune = true } = {}) {
	const config = readModelsConfig();
	config.providers ??= {};
	const touched = [];

	for (const row of pendingChanges(plan, prune)) {
		const provider = config.providers[row.pid];
		// Re-read: the provider may have been removed while the probes ran.
		if (!provider) continue;
		const removeSet = new Set(prune ? row.removed : []);
		// A provider with no model list at all has nothing to keep or repair.
		const existing = Array.isArray(provider.models) ? provider.models : [];
		const kept = existing
			.map((model, index) => ({ id: model?.id, next: row.newModels?.[index] ?? model }))
			.filter((entry) => !removeSet.has(entry.id))
			.map((entry) => entry.next);
		// cost first and last, as in add: pi-ai's calculateCost dereferences it.
		provider.models = [...kept, ...row.added.map(({ def }) => ({ cost: { ...ZERO_COST }, ...def }))];
		touched.push(row.pid);
	}

	if (!touched.length) {
		// "Already in sync" would be a lie when an endpoint could not be read.
		const unreadable = plan.rows.filter((row) => !row.skipped && row.unreachable);
		notify(
			ctx,
			unreadable.length
				? `Nothing was changed: ${unreadable.map((r) => r.pid).join(", ")} could not be read.`
				: "Nothing to do: already in sync.",
		);
		return [];
	}

	backupFile(modelsJsonPath());
	try {
		writeJson(modelsJsonPath(), config);
	} catch (err) {
		notify(ctx, `Writing models.json failed: ${errorMessage(err)}`, "error");
		return [];
	}

	const summary = pendingChanges(plan, prune)
		.filter((row) => touched.includes(row.pid))
		.map((row) => `${row.pid} (+${row.added.length} -${prune ? row.removed.length : 0} ~${row.changed.length})`);
	notify(ctx, `Wrote models.json (backup kept) and synced ${summary.join(", ")}.`);

	try {
		await ctx.modelRegistry.refresh({ providers: touched });
	} catch (err) {
		notify(ctx, `Written, but the registry refresh failed (a restart will load it): ${errorMessage(err)}`, "warning");
	}
	for (const pid of touched) applyScopeUpdate(ctx, pid);
	notify(ctx, "Use /model to pick a model; a new session may be needed for the list to refresh.");
	return touched;
}

export async function syncFlow(ctx, { argv, fetchImpl = fetch } = {}) {
	const options = argv ? parseOptions(argv) : { flags: new Set(), values: {}, positional: [] };
	if (options.flags.has("help")) return notify(ctx, USAGE_TEXT);

	const prune = !options.flags.has("no-prune");
	let plan;
	try {
		plan = await planSync({ pids: options.positional, only: onlyIds(options), fetchImpl });
	} catch (err) {
		return notify(ctx, `sync failed: ${errorMessage(err)}`, "error");
	}

	notify(ctx, renderSyncPlan(plan, { prune }));

	if (!wantsWrite(options)) {
		notify(
			ctx,
			"Nothing was written. Re-run with --all to apply every change, or --only <ids> to add just those models.",
		);
		return plan;
	}

	// Deletions are the irreversible half, so an interactive user is asked. A
	// scripted run proceeds: the caller has the plan in hand and asked for it.
	const doomed = prune
		? plan.rows.filter((row) => !row.skipped && !row.runtime && !row.unreachable && row.removed.length)
		: [];
	if (doomed.length && ctx?.hasUI && typeof ctx.ui?.confirm === "function") {
		const ok = await ctx.ui.confirm(
			"Remove models",
			`The endpoint no longer lists:\n${doomed.map((row) => `${row.pid}: ${row.removed.join(", ")}`).join("\n")}\n\n` +
				"Remove them from models.json? (backed up first)",
		);
		if (!ok) return notify(ctx, "Cancelled; nothing was written.");
	}

	return applySync(ctx, plan, { prune });
}
