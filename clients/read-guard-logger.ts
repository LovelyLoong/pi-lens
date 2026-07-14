import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createNdjsonLogger } from "./ndjson-logger.js";

const READ_GUARD_LOG_DIR = getGlobalPiLensDir();
const READ_GUARD_LOG_FILE = path.join(READ_GUARD_LOG_DIR, "read-guard.log");
const READ_GUARD_LOG_BACKUP_FILE = path.join(
	READ_GUARD_LOG_DIR,
	"read-guard.log.1",
);
const MAX_LOG_BYTES = Math.max(
	128 * 1024,
	Number.parseInt(process.env.PI_LENS_READ_GUARD_MAX_BYTES ?? "1048576", 10) ||
		1048576,
);
const writer = createNdjsonLogger({
	filePath: READ_GUARD_LOG_FILE,
	maxBytes: MAX_LOG_BYTES,
	backupPath: READ_GUARD_LOG_BACKUP_FILE,
});
const VERBOSE_READ_GUARD_LOG =
	process.env.PI_LENS_READ_GUARD_VERBOSE === "1" ||
	process.env.PI_LENS_READ_GUARD_LOG === "verbose";
const LOG_ALLOWED_EDITS = process.env.PI_LENS_READ_GUARD_LOG_ALLOWS === "1";
const SNAPSHOT_LOG_SETTING = (
	process.env.PI_LENS_READ_GUARD_LOG_SNAPSHOTS ?? "1"
).toLowerCase();
const LOG_SNAPSHOT_VALIDATION = !["0", "false", "off"].includes(
	SNAPSHOT_LOG_SETTING,
);

export interface ReadGuardLogEntry {
	event: string;
	sessionId?: string;
	filePath: string;
	requestedOffset?: number;
	requestedLimit?: number;
	effectiveOffset?: number;
	effectiveLimit?: number;
	symbol?: string;
	symbolKind?: string;
	symbolStartLine?: number;
	symbolEndLine?: number;
	metadata?: Record<string, unknown>;
}

function shouldLogEvent(event: string): boolean {
	if (VERBOSE_READ_GUARD_LOG) return true;
	if (event === "edit_allowed") return LOG_ALLOWED_EDITS;
	if (event === "range_snapshot_validation") return LOG_SNAPSHOT_VALIDATION;
	return (
		event === "edit_blocked" ||
		event === "edit_warned" ||
		event === "exemption_added" ||
		event === "oldtext_not_found" ||
		event === "oldtext_duplicate" ||
		event === "oldtext_indent_autopatched" ||
		event === "oldtext_trailing_ws_autopatched" ||
		event === "oldtext_escape_autopatched" ||
		event === "edit_range_relocated" ||
		event === "edit_preflight_blocked" ||
		event === "edit_adaptive_partial_planned" ||
		event === "edit_adaptive_partial_fallback" ||
		event === "edit_adaptive_partial_committed" ||
		event === "edit_adaptive_partial_rejected" ||
		event === "edit_adaptive_partial_terminal_cleanup" ||
		event === "touched_lines_missing"
	);
}

export function logReadGuardEvent(entry: ReadGuardLogEntry): void {
	if (isTestMode() || !shouldLogEvent(entry.event)) {
		return;
	}
	writer.log({ ts: new Date().toISOString(), ...entry });
}

export function getReadGuardLogPath(): string {
	return READ_GUARD_LOG_FILE;
}

/** Resolve once all enqueued read-guard writes are on disk (tests/shutdown). */
export function flushReadGuardLog(): Promise<void> {
	return writer.flush();
}
