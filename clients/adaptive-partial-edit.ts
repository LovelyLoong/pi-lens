import { createHash } from "node:crypto";
import type {
	EditToolInput,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

type NativeHostEdit = EditToolInput["edits"][number];

export type AdaptivePartialFailureReason =
	| "oldText_not_found"
	| "oldText_duplicate"
	| "unsupported_match";

export interface AdaptivePartialCandidate {
	oldText: NativeHostEdit["oldText"];
	newText: NativeHostEdit["newText"];
	originalIndex: number;
	range: [number, number];
	/** Half-open LF-normalized byte-independent string offsets in the preflight snapshot. */
	matchSpan: [number, number];
}

export interface AdaptivePartialFailure {
	originalIndex: number;
	reason: AdaptivePartialFailureReason;
	message: string;
}

export interface AdaptivePartialPlan {
	toolCallId: string;
	filePath: string;
	beforeHash: string;
	originalEditCount: number;
	selected: AdaptivePartialCandidate[];
	failed: AdaptivePartialFailure[];
}

export type AdaptivePartialFallbackReason =
	| "no_candidates"
	| "no_failures"
	| "incomplete_classification"
	| "invalid_candidate_index"
	| "invalid_candidate_span"
	| "overlapping_candidates";

export type AdaptivePartialPlanResult =
	| { ok: true; plan: AdaptivePartialPlan; narrowedEdits: EditToolInput["edits"] }
	| { ok: false; reason: AdaptivePartialFallbackReason };

export interface AdaptivePartialResultDetails {
	status: "partial_success";
	committed: true;
	originalEditCount: number;
	applied: number[];
	failed: Array<{
		index: number;
		reason: AdaptivePartialFailureReason;
		message: string;
	}>;
	beforeHash: string;
	nextAction: "re-read-before-retrying-failed";
}

export interface AdaptivePartialRejectedDetails {
	status: "partial_rejected";
	committed: "not_confirmed";
	originalEditCount: number;
	attempted: number[];
	preflightFailed: Array<{
		index: number;
		reason: AdaptivePartialFailureReason;
		message: string;
	}>;
	beforeHash: string;
	nextAction: "re-read-before-retrying";
}

export interface AdaptivePartialResultPatch {
	content: ToolResultEvent["content"];
	details: Record<string, unknown>;
	isError: boolean;
}

export interface AdaptivePartialAnnotation {
	patch: AdaptivePartialResultPatch;
	notification: string;
	plan: AdaptivePartialPlan;
}

function hashContent(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export function hashAdaptivePartialSnapshot(content: string): string {
	return hashContent(content);
}

function candidatesOverlap(candidates: AdaptivePartialCandidate[]): boolean {
	const ordered = [...candidates].sort(
		(a, b) => a.matchSpan[0] - b.matchSpan[0],
	);
	for (let index = 1; index < ordered.length; index += 1) {
		if (ordered[index - 1].matchSpan[1] > ordered[index].matchSpan[0]) {
			return true;
		}
	}
	return false;
}

export function buildAdaptivePartialPlan(args: {
	toolCallId: string;
	filePath: string;
	beforeHash: string;
	originalEditCount: number;
	candidates: AdaptivePartialCandidate[];
	failures: AdaptivePartialFailure[];
}): AdaptivePartialPlanResult {
	if (args.candidates.length === 0) {
		return { ok: false, reason: "no_candidates" };
	}
	if (args.failures.length === 0) {
		return { ok: false, reason: "no_failures" };
	}
	if (
		args.candidates.length + args.failures.length !==
		args.originalEditCount
	) {
		return { ok: false, reason: "incomplete_classification" };
	}
	const allIndexes = [
		...args.candidates.map((candidate) => candidate.originalIndex),
		...args.failures.map((failure) => failure.originalIndex),
	];
	if (
		new Set(allIndexes).size !== args.originalEditCount ||
		allIndexes.some(
			(index) => index < 0 || index >= args.originalEditCount,
		)
	) {
		return { ok: false, reason: "invalid_candidate_index" };
	}
	if (
		args.candidates.some(
			(candidate) =>
				candidate.matchSpan[0] < 0 ||
				candidate.matchSpan[1] <= candidate.matchSpan[0] ||
				candidate.range[0] < 1 ||
				candidate.range[1] < candidate.range[0],
		)
	) {
		return { ok: false, reason: "invalid_candidate_span" };
	}
	if (candidatesOverlap(args.candidates)) {
		return { ok: false, reason: "overlapping_candidates" };
	}

	const selected = [...args.candidates].sort(
		(a, b) => a.originalIndex - b.originalIndex,
	);
	return {
		ok: true,
		plan: {
			toolCallId: args.toolCallId,
			filePath: args.filePath,
			beforeHash: args.beforeHash,
			originalEditCount: args.originalEditCount,
			selected,
			failed: [...args.failures].sort(
				(a, b) => a.originalIndex - b.originalIndex,
			),
		},
		narrowedEdits: selected.map(({ oldText, newText }) => ({
			oldText,
			newText,
		})),
	};
}

function formatEditIndexes(prefix: string, indexes: number[]): string {
	return indexes.map((index) => `${prefix}[${index}]`).join(", ");
}

function resultDetails(event: ToolResultEvent): Record<string, unknown> {
	return event.details && typeof event.details === "object"
		? (event.details as Record<string, unknown>)
		: {};
}

function buildRejectedAnnotation(
	event: ToolResultEvent,
	plan: AdaptivePartialPlan,
): AdaptivePartialAnnotation {
	const attempted = plan.selected.map((candidate) => candidate.originalIndex);
	const preflightFailed = plan.failed.map((failure) => ({
		index: failure.originalIndex,
		reason: failure.reason,
		message: failure.message,
	}));
	const rejectedDetails: AdaptivePartialRejectedDetails = {
		status: "partial_rejected",
		committed: "not_confirmed",
		originalEditCount: plan.originalEditCount,
		attempted,
		preflightFailed,
		beforeHash: plan.beforeHash,
		nextAction: "re-read-before-retrying",
	};
	const attemptedLabel = formatEditIndexes("edits", attempted);
	return {
		patch: {
			content: [
				...event.content,
				{
					type: "text",
					text: `🔒 ADAPTIVE PARTIAL REJECTED — The native host did not report a successful commit for original ${attemptedLabel}. pi-lens is not claiming that any selected edit was applied. Re-read the file before retrying.`,
				},
			],
			details: {
				...resultDetails(event),
				piLensPartial: rejectedDetails,
			},
			isError: true,
		},
		notification: `Adaptive partial rejected for ${attemptedLabel}. Re-read before retrying.`,
		plan,
	};
}

function buildSuccessAnnotation(
	event: ToolResultEvent,
	plan: AdaptivePartialPlan,
): AdaptivePartialAnnotation {
	const applied = plan.selected.map((candidate) => candidate.originalIndex);
	const failed = plan.failed.map((failure) => ({
		index: failure.originalIndex,
		reason: failure.reason,
		message: failure.message,
	}));
	const partialDetails: AdaptivePartialResultDetails = {
		status: "partial_success",
		committed: true,
		originalEditCount: plan.originalEditCount,
		applied,
		failed,
		beforeHash: plan.beforeHash,
		nextAction: "re-read-before-retrying-failed",
	};
	const appliedLabel = formatEditIndexes("edits", applied);
	const failedLabel = formatEditIndexes(
		"edits",
		failed.map((failure) => failure.index),
	);
	const summary =
		`⚠️ PARTIAL SUCCESS — The host applied ${appliedLabel}; ${failedLabel} did not run.\n\n` +
		`${failed.map((failure) => failure.message).join("\n\n")}\n\n` +
		`Re-read the file, then retry only the failed edit indexes.`;
	return {
		patch: {
			content: [...event.content, { type: "text", text: summary }],
			details: {
				...resultDetails(event),
				piLensPartial: partialDetails,
			},
			isError: false,
		},
		notification: `Partial edit: applied ${appliedLabel}; failed ${failedLabel}. Re-read before retrying.`,
		plan,
	};
}

export class AdaptivePartialCoordinator {
	private readonly pending = new Map<string, AdaptivePartialPlan>();

	remember(plan: AdaptivePartialPlan): void {
		this.pending.set(plan.toolCallId, plan);
	}

	peek(toolCallId: string): AdaptivePartialPlan | undefined {
		return this.pending.get(toolCallId);
	}

	clear(toolCallId: string): boolean {
		return this.pending.delete(toolCallId);
	}

	clearAll(): void {
		this.pending.clear();
	}

	get size(): number {
		return this.pending.size;
	}

	consumeToolResult(
		event: ToolResultEvent,
	): AdaptivePartialAnnotation | undefined {
		if (event.toolName !== "edit") return undefined;
		const plan = this.pending.get(event.toolCallId);
		if (!plan) return undefined;
		this.pending.delete(event.toolCallId);
		return event.isError
			? buildRejectedAnnotation(event, plan)
			: buildSuccessAnnotation(event, plan);
	}
}
