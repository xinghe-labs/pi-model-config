// `/model-config list` — read-only summary of every configured provider.
import { maskKey } from "../infer.js";
import { readModelsConfig } from "../json-file.js";
import { errorMessage, notify } from "../output.js";
import { isRuntimeProvider, runtimeProviders } from "../user-config.js";

export function renderProviderList(providers, { runtime = new Set() } = {}) {
	const ids = Object.keys(providers);
	if (!ids.length) return "models.json 里还没有任何供应商。";
	const lines = ids.map((id) => {
		const p = providers[id] ?? {};
		const models = Array.isArray(p.models) ? `${p.models.length} 个模型` : "继承 / 覆盖已有模型";
		const flags = [];
		if (isRuntimeProvider(id, runtime)) flags.push("运行时供应商");
		if (p.apiKey === "none") flags.push("无 Key");
		return (
			`- ${id}${flags.length ? `（${flags.join("；")}）` : ""}\n` +
			`    ${p.baseUrl ?? "（无 baseUrl）"}  |  api=${p.api ?? "（默认）"}  |  key=${maskKey(p.apiKey)}  |  ${models}`
		);
	});
	return `models.json 里的供应商（共 ${ids.length} 个）：\n${lines.join("\n")}`;
}

export async function listFlow(ctx) {
	let config;
	try {
		config = readModelsConfig();
	} catch (err) {
		return notify(ctx, errorMessage(err), "error");
	}
	notify(ctx, renderProviderList(config.providers ?? {}, { runtime: runtimeProviders() }));
}
