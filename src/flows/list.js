// `/model-config list` — read-only summary of every configured provider.
//
// Default: pure file reading, no network, instant. `--ping` adds one live
// probe per endpoint (status + latency), which answers "is hub up again?"
// without running the much heavier check flow. A failed ping changes nothing:
// it is a status report, not an audit.
import { parseOptions, restrictOptions } from "../args.js";
import { maskKey } from "../infer.js";
import { readModelsConfig } from "../json-file.js";
import { errorMessage, notify } from "../output.js";
import { probeKey, probeHeaders, probeUrl } from "../probe.js";
import { isRuntimeProvider, runtimeProviders } from "../user-config.js";

const PING_TIMEOUT_MS = 5000;

export function renderProviderList(providers, { runtime = new Set(), pings } = {}) {
	const ids = Object.keys(providers);
	if (!ids.length) return "models.json 里还没有任何供应商。";
	const lines = ids.map((id) => {
		const p = providers[id] ?? {};
		const models = Array.isArray(p.models) ? `${p.models.length} 个模型` : "继承 / 覆盖已有模型";
		const flags = [];
		if (isRuntimeProvider(id, runtime)) flags.push("运行时供应商");
		if (p.apiKey === "none") flags.push("无 Key");
		// The ping line reads as part of the same entry; --ping runs before
		// rendering so a slow endpoint cannot reorder the list.
		const ping = pings?.get(id);
		const pingText = pings
			? ping === undefined
				? "    ？未探测"
				: ping.ok
					? `    ✓ 可访问（${ping.ms}ms，HTTP ${ping.status}）`
					: `    ✗ 不可访问（${ping.reason}）`
			: "";
		return (
			`- ${id}${flags.length ? `（${flags.join("；")}）` : ""}\n` +
			`    ${p.baseUrl ?? "（无 baseUrl）"}  |  api=${p.api ?? "（默认）"}  |  key=${maskKey(p.apiKey)}  |  ${models}` +
			pingText
		);
	});
	const head = pings ? "端点状态与配置（--ping）：\n" : `models.json 里的供应商（共 ${ids.length} 个）：\n`;
	return head + lines.join("\n");
}

// One lightweight request per provider, in parallel. The endpoint's /models is
// the same request check uses, so a 401 here means a bad key, not a dead host.
async function pingProviders(providers, { fetchImpl = fetch } = {}) {
	const pings = new Map();
	await Promise.all(
		Object.entries(providers).map(async ([id, p]) => {
			if (!p?.baseUrl) {
				pings.set(id, { ok: false, reason: "无 baseUrl" });
				return undefined;
			}
			const started = Date.now();
			try {
				const res = await fetchImpl(probeUrl(p.baseUrl, probeKey(p), p.api), {
					headers: probeHeaders(probeKey(p), p.api),
					signal: AbortSignal.timeout(PING_TIMEOUT_MS),
				});
				const outcome = {
					ok: res.ok,
					status: res.status,
					ms: Date.now() - started,
					reason: res.ok ? undefined : `HTTP ${res.status}`,
				};
				pings.set(id, outcome);
				return outcome;
			} catch (err) {
				const outcome = { ok: false, ms: Date.now() - started, reason: err instanceof Error ? err.message : String(err) };
				pings.set(id, outcome);
				return outcome;
			}
		}),
	);
	return pings;
}

export async function listFlow(ctx, { argv, fetchImpl = fetch } = {}) {
	const options = restrictOptions(
		"list",
		argv ? parseOptions(argv) : { flags: new Set(), values: {}, positional: [] },
		new Set(["ping", "help"]),
		new Set(),
	);
	if (options.flags.has("help")) {
		notify(
			ctx,
			[
				"用法：",
				"  /model-config list          列出已配置的供应商（纯读文件，不联网）",
				"  /model-config list --ping   附带探测每个端点的状态与延迟",
			].join("\n"),
		);
		return;
	}

	let config;
	try {
		config = readModelsConfig();
	} catch (err) {
		return notify(ctx, errorMessage(err), "error");
	}
	const providers = config.providers ?? {};
	const pings = options.flags.has("ping") ? await pingProviders(providers, { fetchImpl }) : undefined;
	notify(ctx, renderProviderList(providers, { runtime: runtimeProviders(), pings }));
}
