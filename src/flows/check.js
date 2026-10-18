// `/model-setup check` — reconcile models.json's static model lists against the
// endpoint and models.dev, and optionally write the corrections back.
//
// The same function runs silently at session start. That path may only report
// findings and must stay quiet when there are none, so the two passes are kept
// separate on purpose: the first pass computes a plan without touching
// `p.models`, the second applies it. Mutable state updated during pass one would
// make the "nothing to report" decision read its own repairs.
import { backupFile, readModelsConfig, writeJson } from "../json-file.js";
import { loadOfficialData } from "../official.js";
import { errorMessage, notify, requireUI } from "../output.js";
import { modelsJsonPath } from "../paths.js";
import { fetchModelMeta, probeKey } from "../probe.js";
import { diffModel, repairedDef, resolveModelMeta } from "../resolve.js";
import { isRuntimeProvider, runtimeProviders } from "../user-config.js";

const NONE = "No static model list (models are produced by a refresh or by another extension)";

export async function planProvider({ pid, provider, official, fetchImpl }) {
	if (!provider || typeof provider !== "object") return { pid, skipped: "provider missing" };
	if (!provider.baseUrl) return { pid, skipped: "no baseUrl" };
	if (!Array.isArray(provider.models) || provider.models.length === 0) return { pid, skipped: NONE };

	// Probe before awaiting models.dev. The two are independent, and the endpoint is
	// the authoritative source, so it must not queue behind a 400 kB catalog
	// download. `official` may therefore be a pending promise shared by every
	// provider, which is what lets the probes run concurrently with it.
	let endpointList = [];
	let endpointErr;
	try {
		endpointList = await fetchModelMeta(provider.baseUrl, probeKey(provider), provider.api, { fetchImpl });
	} catch (err) {
		endpointErr = err;
	}
	const officialData = (await official) ?? {};

	const endpointById = new Map(endpointList.map((m) => [m.id, m]));
	const changes = [];
	const newModels = provider.models.map((existing) => {
		if (!existing || typeof existing !== "object" || typeof existing.id !== "string") return existing;
		const resolved = resolveModelMeta(existing.id, provider.api, endpointById.get(existing.id), officialData);
		const diffs = diffModel(existing, resolved);
		if (!diffs.length) return existing;
		changes.push({ id: existing.id, diffs });
		return repairedDef(existing, resolved);
	});

	// A model the endpoint no longer lists is reported, never deleted: removing
	// someone's configuration is not an audit decision.
	const vanished =
		endpointList.length > 0
			? provider.models.filter((m) => m?.id && !endpointById.has(m.id)).map((m) => m.id)
			: [];

	return { pid, provider, endpointList, endpointErr, changes, newModels, vanished };
}

export function renderPlan(plan, { runtime = false } = {}) {
	const lines = [`- ${plan.pid} (${plan.provider.baseUrl})`];
	if (plan.endpointErr) {
		lines.push(`    ! endpoint probe failed (${errorMessage(plan.endpointErr)}); reconciled from models.dev / names only`);
	}
	if (!plan.changes.length && !plan.vanished.length) {
		lines.push(`    ok ${plan.provider.models.length} model(s) consistent`);
	} else {
		for (const c of plan.changes) lines.push(`    ${c.id}: ${c.diffs.join(", ")}`);
		if (plan.vanished.length) {
			lines.push(`    ! no longer listed by the endpoint: ${plan.vanished.join(", ")} (kept, not deleted)`);
		}
	}
	if (runtime) {
		lines.push(`    i runtime provider: models.json holds only the static fallback, so it is reported but never rewritten`);
	}
	return lines.join("\n");
}

async function selectTargets(ctx, targets) {
	const pick = await ctx.ui.select("Check which endpoints?", ["All endpoints", ...targets]);
	if (pick === undefined) return undefined;
	return pick === "All endpoints" ? targets : [pick];
}

export async function checkFlow(ctx, { auto = false, fetchImpl = fetch } = {}) {
	let config;
	try {
		config = readModelsConfig();
	} catch (err) {
		if (!auto) notify(ctx, errorMessage(err), "error");
		return;
	}
	const providers = config.providers ?? {};
	if (!Object.keys(providers).length) {
		if (!auto) notify(ctx, "models.json has no provider entries yet");
		return;
	}

	const runtime = runtimeProviders();
	let targets = Object.keys(providers);
	if (auto) {
		// Startup must not re-report a deviation it cannot fix. A runtime provider's
		// static fallback legitimately differs from live data.
		targets = targets.filter((pid) => !isRuntimeProvider(pid, runtime));
		if (!targets.length) return;
	} else {
		if (!requireUI(ctx, "check --select")) {
			// No UI: check everything rather than nothing.
			notify(ctx, "No interactive session: checking every endpoint.", "warning");
		} else {
			const picked = await selectTargets(ctx, targets);
			if (picked === undefined) return notify(ctx, "Cancelled");
			targets = picked;
		}
	}

	// models.dev is one request shared by every endpoint, and each endpoint probe is
	// independent of it: start the load, hand the pending promise to every provider,
	// and let `planProvider` await it after its own probe has already been issued.
	const official = loadOfficialData({ fetchImpl });
	const plans = await Promise.all(
		targets.map((pid) => planProvider({ pid, provider: providers[pid], official, fetchImpl })),
	);

	const report = [];
	const findings = [];
	for (const plan of plans) {
		if (plan.skipped) {
			report.push(`- ${plan.pid}: skipped (${plan.skipped})`);
			continue;
		}
		findings.push(plan);
		report.push(renderPlan(plan, { runtime: isRuntimeProvider(plan.pid, runtime) }));
	}

	if (auto && !findings.some((p) => p.changes.length || p.vanished.length)) return;

	notify(ctx, `Model parameter audit:\n${report.join("\n\n")}`);

	const repaired = [];
	for (const plan of findings) {
		if (!plan.changes.length) continue;
		if (isRuntimeProvider(plan.pid, runtime)) continue;
		let apply = true;
		if (!auto) {
			apply = Boolean(
				await ctx.ui.confirm(
					`Repair ${plan.pid}`,
					`${plan.changes.length} deviation(s) found. Apply the inferred values?\n` +
						plan.changes.map((c) => `${c.id}: ${c.diffs.join(", ")}`).join("\n"),
				),
			);
		}
		if (!apply) continue;
		plan.provider.models = plan.newModels;
		repaired.push(plan.pid);
	}

	if (!repaired.length) {
		if (!auto) notify(ctx, "Nothing written.");
		return;
	}

	backupFile(modelsJsonPath());
	try {
		writeJson(modelsJsonPath(), config);
	} catch (err) {
		notify(ctx, `Writing models.json failed: ${errorMessage(err)}`, "error");
		return;
	}
	notify(ctx, `Wrote models.json (backup kept) and repaired ${repaired.join(", ")}.`);
	try {
		await ctx.modelRegistry.refresh({ providers: repaired });
	} catch (err) {
		notify(ctx, `Written, but the registry refresh failed (a restart will load it): ${errorMessage(err)}`, "warning");
	}
}
