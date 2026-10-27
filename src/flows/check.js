// `/model-config check` — reconcile models.json's static model lists against the
// endpoint and models.dev, and optionally write the corrections back.
//
// The same function runs silently at session start. That path may only report
// findings and must stay quiet when there are none, so the two passes are kept
// separate on purpose: the first pass computes a plan without touching
// `p.models`, the second applies it. Mutable state updated during pass one would
// make the "nothing to report" decision read its own repairs.
import { backupFile, readModelsConfig, writeJson } from "../json-file.js";
import { parseOptions, restrictOptions } from "../args.js";
import { loadOfficialData } from "../official.js";
import { errorMessage, notify, canPrompt } from "../output.js";
import { modelsJsonPath } from "../paths.js";
import { fetchModelMeta, probeKey } from "../probe.js";
import { diffModel, repairedDef, resolveModelMeta } from "../resolve.js";
import { isRuntimeProvider, runtimeProviders } from "../user-config.js";

const NONE = "没有静态模型列表（由刷新或其他扩展生成）";

export async function planProvider({ pid, provider, official, fetchImpl }) {
	if (!provider || typeof provider !== "object") return { pid, skipped: "provider 缺失" };
	if (!provider.baseUrl) return { pid, skipped: "没有 baseUrl" };
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
		lines.push(`    ！端点探测失败（${errorMessage(plan.endpointErr)}），仅按 models.dev / 名称对账`);
	}
	if (!plan.changes.length && !plan.vanished.length) {
		lines.push(`    ✓ ${plan.provider.models.length} 个模型参数一致`);
	} else {
		for (const c of plan.changes) lines.push(`    ${c.id}: ${c.diffs.join(", ")}`);
		if (plan.vanished.length) {
			lines.push(`    ！端点已不再提供：${plan.vanished.join("、")}（保留，未删除）`);
		}
	}
	if (runtime) {
		lines.push(`    ℹ 运行时供应商：models.json 里只是静态兜底，只报告、绝不改写`);
	}
	return lines.join("\n");
}

async function selectTargets(ctx, targets) {
	const pick = await ctx.ui.select("检查哪些端点？", ["全部端点", ...targets]);
	if (pick === undefined) return undefined;
	return pick === "全部端点" ? targets : [pick];
}

// `--fix` is consent in writing: every deviation found is repaired without a
// dialog, which is what a script or an agent driving `pi -p` needs. Without it
// the flow stays read-only outside an interactive session.
export async function checkFlow(ctx, { auto = false, argv, fetchImpl = fetch } = {}) {
	const options = restrictOptions(
		"check",
		argv ? parseOptions(argv) : { flags: new Set(), values: {} },
		new Set(["fix"]),
		new Set(),
	);
	const fix = !auto && options.flags.has("fix");
	let config;
	try {
		config = readModelsConfig();
	} catch (err) {
		if (!auto) notify(ctx, errorMessage(err), "error");
		return;
	}
	const providers = config.providers ?? {};
	if (!Object.keys(providers).length) {
		if (!auto) notify(ctx, "models.json 里还没有任何供应商");
		return;
	}

	const runtime = runtimeProviders();
	let targets = Object.keys(providers);
	// Whether the user can be *asked*. The target picker and the per-provider repair
	// confirm both need a UI; without one, `check` can only report.
	const canConsent = !auto && canPrompt(ctx);
	if (auto) {
		// Startup must not re-report a deviation it cannot fix. A runtime provider's
		// static fallback legitimately differs from live data.
		targets = targets.filter((pid) => !isRuntimeProvider(pid, runtime));
		if (!targets.length) return;
	} else if (fix) {
		// No target picker and no per-provider confirm: --fix names every endpoint.
	} else if (canConsent) {
		const picked = await selectTargets(ctx, targets);
		if (picked === undefined) return notify(ctx, "已取消");
		targets = picked;
	} else {
		// print / JSON / RPC mode. Checking everything read-only is still useful, so
		// do that instead of refusing the whole command.
		notify(ctx, "当前不是交互式会话：只报告所有端点，不写入任何内容。", "warning");
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
			report.push(`- ${plan.pid}：跳过（${plan.skipped}）`);
			continue;
		}
		findings.push(plan);
		report.push(renderPlan(plan, { runtime: isRuntimeProvider(plan.pid, runtime) }));
	}

	if (auto && !findings.some((p) => p.changes.length || p.vanished.length)) return;

	notify(ctx, `模型参数对账：\n${report.join("\n\n")}`);

	const repairPlans = [];
	for (const plan of findings) {
		if (!plan.changes.length) continue;
		if (isRuntimeProvider(plan.pid, runtime)) continue;
		let apply = true;
		if (!auto && !fix) {
			// A write needs consent, and consent needs a dialog. This used to call
			// ctx.ui.confirm unconditionally, which threw in print / JSON / RPC mode.
			apply = canConsent
				? Boolean(
						await ctx.ui.confirm(
							`修复 ${plan.pid}`,
							`发现 ${plan.changes.length} 处参数偏差，按推断值修复吗？\n` +
								plan.changes.map((c) => `${c.id}: ${c.diffs.join("，")}`).join("\n"),
						),
					)
				: false;
		}
		if (!apply) continue;
		repairPlans.push(plan);
	}

	if (!repairPlans.length) {
		if (auto) return;
		// Three different reasons end here, and "nothing written" alone would read
		// as a failure in all of them: nothing deviated, the user declined, or
		// there was no UI to consent with. Say which one it was.
		const hadDeviations = findings.some((p) => p.changes.length);
		if (!hadDeviations) {
			notify(ctx, "所有模型参数一致，没有需要修复的。");
		} else if (canConsent) {
			notify(ctx, "已跳过修复，什么都没写入。");
		} else {
			notify(
				ctx,
				"什么都没写入：修复需要确认。要落地请运行 /model-config check --fix 或 sync --all，或在交互式会话里操作。",
			);
		}
		return;
	}

	// Re-read after the confirms: the file may have changed while dialogs were
	// open, and writing the startup snapshot would discard those edits. Repairs
	// are applied by model id, so models added in the meantime survive untouched.
	let fresh;
	try {
		fresh = readModelsConfig();
	} catch (err) {
		notify(ctx, errorMessage(err), "error");
		return;
	}
	const applied = [];
	for (const plan of repairPlans) {
		const provider = fresh.providers?.[plan.pid];
		if (!provider) {
			notify(ctx, `${plan.pid} 已不存在，跳过修复。`, "warning");
			continue;
		}
		const fixedById = new Map((plan.newModels ?? []).filter((m) => m?.id).map((m) => [m.id, m]));
		provider.models = (Array.isArray(provider.models) ? provider.models : []).map(
			(model) => (model?.id && fixedById.get(model.id)) || model,
		);
		applied.push(plan.pid);
	}
	if (!applied.length) {
		notify(ctx, "要修复的供应商都已不存在，什么都没写入。");
		return;
	}

	const bakErr = backupFile(modelsJsonPath());
	if (bakErr) notify(ctx, `${bakErr}，models.json 将在没有备份的情况下写入。`, "warning");
	try {
		writeJson(modelsJsonPath(), fresh);
	} catch (err) {
		notify(ctx, `写入 models.json 失败：${errorMessage(err)}`, "error");
		return;
	}
	notify(ctx, `已写入 models.json（保留备份），修复了 ${applied.join("、")}。`);
	try {
		await ctx.modelRegistry.refresh({ providers: applied });
	} catch (err) {
		notify(ctx, `已写入，但注册表刷新失败（重启后会加载）：${errorMessage(err)}`, "warning");
	}
}
