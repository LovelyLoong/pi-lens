import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AdaptivePartialCoordinator,
	buildAdaptivePartialPlan,
	hashAdaptivePartialSnapshot,
	type AdaptivePartialCandidate,
	type AdaptivePartialFailure,
} from "../../clients/adaptive-partial-edit.js";

const candidate = (
	originalIndex: number,
	matchSpan: [number, number],
): AdaptivePartialCandidate => ({
	oldText: `old-${originalIndex}`,
	newText: `new-${originalIndex}`,
	originalIndex,
	range: [originalIndex + 1, originalIndex + 1],
	matchSpan,
});

const failure = (originalIndex: number): AdaptivePartialFailure => ({
	originalIndex,
	reason: "oldText_not_found",
	message: `edits[${originalIndex}] was not found`,
});

describe("adaptive partial edit planning", () => {
	it("builds an index-preserving narrowed host batch", () => {
		const result = buildAdaptivePartialPlan({
			toolCallId: "call-1",
			filePath: "/tmp/file.ts",
			beforeHash: "before",
			originalEditCount: 3,
			candidates: [candidate(2, [20, 25]), candidate(0, [0, 5])],
			failures: [failure(1)],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.selected.map((edit) => edit.originalIndex)).toEqual([
			0, 2,
		]);
		expect(result.narrowedEdits).toEqual([
			{ oldText: "old-0", newText: "new-0" },
			{ oldText: "old-2", newText: "new-2" },
		]);
	});

	it("falls back atomically when selected spans overlap", () => {
		const result = buildAdaptivePartialPlan({
			toolCallId: "call-overlap",
			filePath: "/tmp/file.ts",
			beforeHash: "before",
			originalEditCount: 3,
			candidates: [candidate(0, [0, 8]), candidate(1, [7, 12])],
			failures: [failure(2)],
		});

		expect(result).toEqual({
			ok: false,
			reason: "overlapping_candidates",
		});
	});

	it("falls back atomically when a candidate span is invalid", () => {
		const invalid = candidate(0, [5, 5]);
		const result = buildAdaptivePartialPlan({
			toolCallId: "call-invalid-span",
			filePath: "/tmp/file.ts",
			beforeHash: "before",
			originalEditCount: 2,
			candidates: [invalid],
			failures: [failure(1)],
		});

		expect(result).toEqual({
			ok: false,
			reason: "invalid_candidate_span",
		});
	});

	it("falls back atomically when classification is incomplete", () => {
		const result = buildAdaptivePartialPlan({
			toolCallId: "call-incomplete",
			filePath: "/tmp/file.ts",
			beforeHash: "before",
			originalEditCount: 3,
			candidates: [candidate(0, [0, 5])],
			failures: [failure(2)],
		});

		expect(result).toEqual({
			ok: false,
			reason: "incomplete_classification",
		});
	});
});

describe("AdaptivePartialCoordinator", () => {
	it("annotates a successful host result, preserves native details, and clears state", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "pi-adaptive-partial-"),
		);
		try {
			const filePath = path.join(tmpDir, "file.ts");
			await fs.writeFile(filePath, "const value = 2;\n", "utf-8");
			const coordinator = new AdaptivePartialCoordinator();
			const planResult = buildAdaptivePartialPlan({
				toolCallId: "call-success",
				filePath,
				beforeHash: hashAdaptivePartialSnapshot("const value = 1;\n"),
				originalEditCount: 2,
				candidates: [candidate(0, [0, 16])],
				failures: [failure(1)],
			});
			expect(planResult.ok).toBe(true);
			if (!planResult.ok) return;
			coordinator.remember(planResult.plan);

			const annotation = await coordinator.consumeToolResult({
				type: "tool_result",
				toolName: "edit",
				toolCallId: "call-success",
				input: { path: filePath, edits: planResult.narrowedEdits },
				content: [{ type: "text", text: "native result" }],
				details: {
					diff: "native-diff",
					patch: "native-patch",
					firstChangedLine: 1,
				},
				isError: false,
			});

			expect(coordinator.size).toBe(0);
			expect(annotation?.patch.content.at(-1)).toMatchObject({
				type: "text",
				text: expect.stringContaining("PARTIAL SUCCESS"),
			});
			expect(annotation?.patch.details).toMatchObject({
				diff: "native-diff",
				patch: "native-patch",
				firstChangedLine: 1,
				piLensPartial: {
					status: "partial_success",
					committed: true,
					applied: [0],
					failed: [expect.objectContaining({ index: 1 })],
					beforeHash: hashAdaptivePartialSnapshot("const value = 1;\n"),
				},
			});
			expect(annotation?.patch.isError).toBe(false);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("clears a failed host call without claiming partial success", async () => {
		const coordinator = new AdaptivePartialCoordinator();
		const planResult = buildAdaptivePartialPlan({
			toolCallId: "call-failed",
			filePath: "/tmp/file.ts",
			beforeHash: "before",
			originalEditCount: 2,
			candidates: [candidate(0, [0, 5])],
			failures: [failure(1)],
		});
		expect(planResult.ok).toBe(true);
		if (!planResult.ok) return;
		coordinator.remember(planResult.plan);

		const annotation = await coordinator.consumeToolResult({
			type: "tool_result",
			toolName: "edit",
			toolCallId: "call-failed",
			input: { path: "/tmp/file.ts", edits: planResult.narrowedEdits },
			content: [{ type: "text", text: "host rejected stale oldText" }],
			details: undefined,
			isError: true,
		});

		expect(annotation?.patch.content.at(-1)).toMatchObject({
			type: "text",
			text: expect.stringContaining("not claiming"),
		});
		expect(annotation?.patch.details).toMatchObject({
			piLensPartial: {
				status: "partial_rejected",
				committed: "not_confirmed",
				attempted: [0],
			},
		});
		expect(annotation?.patch.isError).toBe(true);
		expect(coordinator.size).toBe(0);
	});
});
