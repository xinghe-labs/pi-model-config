// Endpoint probing: read {baseUrl}/models and normalize whatever shape comes back.
//
// Three dialects matter because authentication differs between them:
//   - openai-*:            Authorization: Bearer <key>
//   - anthropic-messages:  x-api-key + anthropic-version
//   - google-generative-ai: ?key=<key> (a Bearer header is a guaranteed 401)
import { PROBE_TIMEOUT_MS, PROBE_UA } from "./const.js";
import { resolveProbeKey } from "./auth-store.js";

const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : undefined);

// An endpoint that lists the same id twice must not become two identical entries
// in models.json. First one wins; they carry the same metadata in practice.
export function uniqueById(list) {
	const seen = new Set();
	const out = [];
	for (const entry of list) {
		if (!entry?.id || seen.has(entry.id)) continue;
		seen.add(entry.id);
		out.push(entry);
	}
	return out;
}

// models.json uses the literal "none" for "no key"; never send it as a bearer.
// Falls back to pi's auth.json credential (the "stored credential" pi itself
// prefers) when the provider has no explicit key — see auth-store.js.
export function probeKey(provider, pid) {
	return resolveProbeKey(provider, pid);
}

// Google's Gemini REST API puts the version in the path. Pi's built-in google
// provider defaults to .../v1beta, so a base URL without a version segment gets
// one appended before /models.
export function probeUrl(baseUrl, apiKey, api) {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (api !== "google-generative-ai") return `${trimmed}/models`;
	const base = /\/v\d+(?:alpha|beta)?$/i.test(trimmed) ? trimmed : `${trimmed}/v1beta`;
	return `${base}/models${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`;
}

export function probeHeaders(apiKey, api) {
	const headers = { "User-Agent": PROBE_UA };
	if (api === "anthropic-messages") {
		if (apiKey) headers["x-api-key"] = apiKey;
		headers["anthropic-version"] = "2023-06-01";
	} else if (api === "google-generative-ai") {
		/* key travels in the query string */
	} else if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

// Returns [{ id, contextWindow?, maxTokens?, reasoning?, vision?, efforts? }].
// `fetchImpl` is injectable so tests never touch the network.
export async function fetchModelMeta(baseUrl, apiKey, api, { fetchImpl = fetch } = {}) {
	const res = await fetchImpl(probeUrl(baseUrl, apiKey, api), {
		headers: probeHeaders(apiKey, api),
		signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = await res.json();
	let list = [];
	if (Array.isArray(data?.data)) list = data.data;
	else if (Array.isArray(data?.models)) list = data.models;
	return uniqueById(list.map(normalizeListedModel).filter(Boolean));
}

export function normalizeListedModel(m) {
	if (typeof m === "string") return m ? { id: m } : undefined;
	// Gemini names entries "models/gemini-2.5-pro".
	const rawId = m?.id ?? m?.name;
	if (typeof rawId !== "string" || !rawId) return undefined;
	const id = rawId.replace(/^models\//, "");
	if (!id) return undefined;
	// Gemini's list mixes in embedding / aqa models; filter by declared capability
	// when the endpoint says what each model can do.
	const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : undefined;
	if (methods && !methods.includes("generateContent")) return undefined;

	const ctxLen = posInt(
		m?.context_length ??
			m?.context_window ??
			m?.max_input_tokens ??
			m?.input_token_limit ??
			m?.top_provider?.context_length ??
			m?.max_model_len ??
			m?.inputTokenLimit,
	);
	const outLen = posInt(
		m?.max_completion_tokens ??
			m?.max_output_tokens ??
			m?.output_token_limit ??
			m?.top_provider?.max_completion_tokens ??
			m?.outputTokenLimit,
	);
	const mods = Array.isArray(m?.architecture?.input_modalities)
		? m.architecture.input_modalities
		: Array.isArray(m?.input_modalities)
			? m.input_modalities
			: [];
	const params = Array.isArray(m?.supported_parameters) ? m.supported_parameters : [];

	// Thinking efforts come either in models.dev's reasoning_options shape or as a
	// flat list (some gateways report reasoning_supported_efforts directly).
	const efforts = [];
	for (const opt of Array.isArray(m?.reasoning_options) ? m.reasoning_options : []) {
		if (opt?.type === "effort" && Array.isArray(opt.values)) efforts.push(...opt.values);
	}
	if (Array.isArray(m?.reasoning_supported_efforts)) efforts.push(...m.reasoning_supported_efforts);

	// Effort options are themselves evidence of thinking support: an endpoint that
	// lists them is offering a reasoning knob even when it spells the flag
	// differently. That is why efforts.length alone can set reasoning=true here.
	const reasoning =
		params.includes("reasoning") || m?.reasoning === true || m?.supports_reasoning === true || efforts.length > 0;

	const meta = { id };
	if (ctxLen) meta.contextWindow = ctxLen;
	if (outLen) meta.maxTokens = outLen;
	if (mods.includes("image") || m?.supports_images === true) meta.vision = true;
	if (reasoning) meta.reasoning = true;
	if (efforts.length) meta.efforts = [...new Set(efforts)];
	return meta;
}
