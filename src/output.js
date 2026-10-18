// Talking to the user in every mode Pi can run in.
//
// Pi loads extensions in interactive, RPC, JSON and print modes, and only the
// first two have a UI. A check or list is read-only and therefore useful in all
// of them, so instead of failing silently it falls back to stdout. Anything that
// needs a dialog must ask `canPrompt` first.
export function notify(ctx, text, level = "info") {
	if (ctx?.hasUI && typeof ctx.ui?.notify === "function") {
		ctx.ui.notify(text, level);
		return;
	}
	const stream = level === "error" ? process.stderr : process.stdout;
	stream.write(`${text}\n`);
}

export function canPrompt(ctx) {
	return Boolean(ctx?.hasUI && ctx.ui && typeof ctx.ui.select === "function");
}

// Guards a flow that cannot work without dialogs (add, remove). Returns false
// after explaining why, so the caller can bail out.
export function requireUI(ctx, what) {
	if (canPrompt(ctx)) return true;
	notify(ctx, `${what} 需要交互式会话，当前模式无法弹出对话框。`, "error");
	return false;
}

export function errorMessage(err) {
	return err instanceof Error ? err.message : String(err);
}
