// Filesystem locations. Everything resolves from PI_CODING_AGENT_DIR at call
// time (not import time) so tests can point it at a temp directory.
import os from "node:os";
import path from "node:path";

export function agentDir() {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export const modelsJsonPath = () => path.join(agentDir(), "models.json");
export const settingsPath = () => path.join(agentDir(), "settings.json");
export const officialCachePath = () => path.join(agentDir(), "model-config-modelsdev-cache.json");
export const userConfigPath = () => path.join(agentDir(), "model-config.json");
