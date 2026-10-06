/**
 * Operator pause for omp-strata.
 *
 * In goal mode one omp turn is a whole agent run (often 15+ tool calls), and
 * `/goal pause` only applies when that run ends. Pressing Esc instead aborts
 * the step that is generating and throws its thinking away.
 *
 * While the file ~/.config/omp-strata/pause-requested exists, this extension
 * refuses every tool call before it runs and asks the model to give a short
 * status and end its turn. The run stops at the next step with nothing lost:
 * finished tool results stay, no tool is cut off mid-way, and only one short
 * reply is generated. Send `/goal pause` first so goal mode does not
 * continue, wait for the `pi >` prompt, then delete the file.
 * `scripts/omp-pause.sh` does all of that.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PAUSE_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "omp-strata", "pause-requested");
const MARKER = `<system-interrupt reason="operator_pause">`;

export function pauseRequested(file = PAUSE_FILE): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

export function pauseReason(): string {
	return [
		MARKER,
		"The operator paused this session. This tool call was not run, and no further tools will run until the pause ends.",
		"Do not call any more tools. Reply in at most three sentences: what you just finished, what you were about to do next, and anything left half done. Then end your turn.",
		`</system-interrupt>`,
	].join("\n");
}

export default function (pi: {
	on(event: "tool_call", handler: (event: { toolName: string }) => { block?: boolean; reason?: string } | undefined): void;
	logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}): void {
	pi.logger?.warn?.("strata operator-pause loaded", { file: PAUSE_FILE });
	pi.on("tool_call", event => {
		if (!pauseRequested()) return undefined;
		pi.logger?.warn?.("operator pause: refused a tool call", { toolName: event.toolName });
		return { block: true, reason: pauseReason() };
	});
}
