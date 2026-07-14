import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createEditToolDefinition,
	createExtensionRuntime,
	ExtensionRunner,
	isEditToolResult,
	isToolCallEventType,
	type EditOperations,
	type EditToolInput,
	type Extension,
	type ExtensionContext,
	type ExtensionUIContext,
	type ModelRegistry,
	SessionManager,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

type PartialPlan = {
	applied: number[];
	failed: Array<{ index: number; reason: "oldText_not_found" }>;
};

type ToolResultPatch = {
	content?: ToolResultEvent["content"];
	details?: unknown;
	isError?: boolean;
};

type ProbeTerminalEvent = {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: {
		content: ToolResultEvent["content"];
		details?: unknown;
	};
	isError: boolean;
};

type ProbeHandler = (
	event: ToolCallEvent | ToolResultEvent | ProbeTerminalEvent,
	ctx: ExtensionContext,
) => Promise<ToolCallEventResult | ToolResultPatch | undefined>;

function probeExtension(
	extensionPath: string,
	handlers: Record<string, ProbeHandler[]>,
): Extension {
	return {
		path: extensionPath,
		handlers: new Map(Object.entries(handlers)),
	} as unknown as Extension;
}

function probeRunner(cwd: string, ...extensions: Extension[]): ExtensionRunner {
	return new ExtensionRunner(
		extensions,
		createExtensionRuntime(),
		cwd,
		SessionManager.inMemory(cwd),
		{} as ModelRegistry,
	);
}

describe("public Pi edit hook contract", () => {
	it("executes a narrowed batch through the host and annotates the same correlated result", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "pi-edit-hook-contract-"),
		);
		try {
			const filePath = path.join(tmpDir, "sample.ts");
			await fs.writeFile(
				filePath,
				"const a = 1;\nconst b = 2;\n",
				"utf-8",
			);

			const pending = new Map<string, PartialPlan>();
			const notifications: Array<{ message: string; level: string }> = [];
			const observedCallIds: Array<["call" | "result", string]> = [];
			let laterCallEditCount = -1;
			let laterResultSawPatch = false;
			let resultInputEditCount = -1;

			const firstExtension = probeExtension("<adaptive-probe-a>", {
				tool_call: [
					async (event) => {
						if (
							event.type !== "tool_call" ||
							!isToolCallEventType("edit", event)
						) {
							return undefined;
						}
						observedCallIds.push(["call", event.toolCallId]);
						const originalEdits = [...event.input.edits];
						pending.set(event.toolCallId, {
							applied: [0],
							failed: [{ index: 1, reason: "oldText_not_found" }],
						});
						event.input.edits = [originalEdits[0]];
						return undefined;
					},
				],
				tool_result: [
					async (event, ctx) => {
						if (event.type !== "tool_result" || !isEditToolResult(event)) {
							return undefined;
						}
						observedCallIds.push(["result", event.toolCallId]);
						resultInputEditCount = (event.input as EditToolInput).edits.length;
						const plan = pending.get(event.toolCallId);
						expect(plan).toBeDefined();
						pending.delete(event.toolCallId);
						ctx.ui.notify(
							"Partial edit: applied edits[0]; failed edits[1]",
							"warning",
						);
						return {
							content: [
								...event.content,
								{
									type: "text",
									text: "PARTIAL SUCCESS: applied edits[0]; failed edits[1]",
								},
							],
							details: {
								...(event.details ?? {}),
								piLensPartial: plan,
							},
							isError: false,
						};
					},
				],
			});

			const laterExtension = probeExtension("<adaptive-probe-b>", {
				tool_call: [
					async (event) => {
						if (
							event.type === "tool_call" &&
							isToolCallEventType("edit", event)
						) {
							laterCallEditCount = event.input.edits.length;
						}
						return undefined;
					},
				],
				tool_result: [
					async (event) => {
						if (event.type !== "tool_result" || !isEditToolResult(event)) {
							return undefined;
						}
						laterResultSawPatch = event.content.some(
							(item) =>
								item.type === "text" && item.text.includes("PARTIAL SUCCESS"),
						);
						return {
							details: {
								...(event.details ?? {}),
								laterHandlerObservedPatch: true,
							},
						};
					},
				],
			});

			const runner = probeRunner(tmpDir, firstExtension, laterExtension);
			runner.setUIContext({
				notify: (message: string, level: string) => {
					notifications.push({ message, level });
				},
			} as ExtensionUIContext);
			const toolCallId = "probe-call-123";
			const input: EditToolInput = {
				path: filePath,
				edits: [
					{
						oldText: "const a = 1;",
						newText: "const a = 10; // deliberate em dash: a—b",
					},
					{
						oldText: "const missing = true;",
						newText: "const missing = false;",
					},
				],
			};

			const callDecision = await runner.emitToolCall({
				type: "tool_call",
				toolName: "edit",
				toolCallId,
				input,
			});
			expect(callDecision).toBeUndefined();
			expect(input.edits).toHaveLength(1);
			expect(laterCallEditCount).toBe(1);

			const hostEdit = createEditToolDefinition(tmpDir);
			const hostResult = await hostEdit.execute(
				toolCallId,
				input,
				undefined,
				undefined,
				runner.createContext(),
			);
			const resultPatch = await runner.emitToolResult({
				type: "tool_result",
				toolName: "edit",
				toolCallId,
				input,
				content: hostResult.content,
				details: hostResult.details,
				isError: false,
			});

			expect(resultPatch).toBeDefined();
			expect(observedCallIds).toEqual([
				["call", toolCallId],
				["result", toolCallId],
			]);
			expect(resultInputEditCount).toBe(1);
			expect(laterResultSawPatch).toBe(true);
			expect(notifications).toEqual([
				{
					message: "Partial edit: applied edits[0]; failed edits[1]",
					level: "warning",
				},
			]);
			expect(resultPatch?.isError).toBe(false);
			expect(resultPatch?.content?.at(-1)).toEqual({
				type: "text",
				text: "PARTIAL SUCCESS: applied edits[0]; failed edits[1]",
			});
			expect(resultPatch?.details).toMatchObject({
				piLensPartial: {
					applied: [0],
					failed: [{ index: 1, reason: "oldText_not_found" }],
				},
				laterHandlerObservedPatch: true,
			});
			expect(await fs.readFile(filePath, "utf-8")).toBe(
				"const a = 10; // deliberate em dash: a—b\nconst b = 2;\n",
			);
			expect(pending.size).toBe(0);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("serializes concurrent host edits to the same file without losing disjoint changes", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "pi-edit-queue-contract-"),
		);
		try {
			const filePath = path.join(tmpDir, "sample.ts");
			await fs.writeFile(
				filePath,
				"const a = 1;\nconst b = 2;\n",
				"utf-8",
			);
			const active = new Set<string>();
			let maxActive = 0;
			const operationsFor = (label: string): EditOperations => ({
				access: (target) => fs.access(target),
				readFile: async (target) => {
					active.add(label);
					maxActive = Math.max(maxActive, active.size);
					await new Promise((resolve) => setTimeout(resolve, 25));
					return fs.readFile(target);
				},
				writeFile: async (target, content) => {
					try {
						await new Promise((resolve) => setTimeout(resolve, 25));
						await fs.writeFile(target, content, "utf-8");
					} finally {
						active.delete(label);
					}
				},
			});
			const firstHostEdit = createEditToolDefinition(tmpDir, {
				operations: operationsFor("first"),
			});
			const secondHostEdit = createEditToolDefinition(tmpDir, {
				operations: operationsFor("second"),
			});
			const ctx = probeRunner(tmpDir).createContext();

			await Promise.all([
				firstHostEdit.execute(
					"queue-call-a",
					{
						path: filePath,
						edits: [
							{ oldText: "const a = 1;", newText: "const a = 10;" },
						],
					},
					undefined,
					undefined,
					ctx,
				),
				secondHostEdit.execute(
					"queue-call-b",
					{
						path: filePath,
						edits: [
							{ oldText: "const b = 2;", newText: "const b = 20;" },
						],
					},
					undefined,
					undefined,
					ctx,
				),
			]);

			expect(maxActive).toBe(1);
			expect(active.size).toBe(0);
			expect(await fs.readFile(filePath, "utf-8")).toBe(
				"const a = 10;\nconst b = 20;\n",
			);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("does not claim partial success when the host rejects a stale narrowed subset", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "pi-edit-race-contract-"),
		);
		try {
			const filePath = path.join(tmpDir, "sample.ts");
			await fs.writeFile(
				filePath,
				"const a = 1;\nconst b = 2;\n",
				"utf-8",
			);
			const pending = new Map<string, PartialPlan>();
			const extension = probeExtension("<adaptive-race-probe>", {
				tool_call: [
					async (event) => {
						if (
							event.type !== "tool_call" ||
							!isToolCallEventType("edit", event)
						) {
							return undefined;
						}
						pending.set(event.toolCallId, {
							applied: [0],
							failed: [{ index: 1, reason: "oldText_not_found" }],
						});
						event.input.edits = [event.input.edits[0]];
						return undefined;
					},
				],
				tool_result: [
					async (event) => {
						if (event.type !== "tool_result" || !isEditToolResult(event)) {
							return undefined;
						}
						const plan = pending.get(event.toolCallId);
						pending.delete(event.toolCallId);
						if (event.isError || !plan) return undefined;
						return {
							details: { ...(event.details ?? {}), piLensPartial: plan },
						};
					},
				],
			});
			const runner = probeRunner(tmpDir, extension);
			const toolCallId = "race-call";
			const input: EditToolInput = {
				path: filePath,
				edits: [
					{ oldText: "const a = 1;", newText: "const a = 10;" },
					{
						oldText: "const missing = true;",
						newText: "const missing = false;",
					},
				],
			};
			await runner.emitToolCall({
				type: "tool_call",
				toolName: "edit",
				toolCallId,
				input,
			});
			await fs.writeFile(
				filePath,
				"const a = 99;\nconst b = 2;\n",
				"utf-8",
			);

			const hostEdit = createEditToolDefinition(tmpDir);
			let hostError: Error | undefined;
			try {
				await hostEdit.execute(
					toolCallId,
					input,
					undefined,
					undefined,
					runner.createContext(),
				);
			} catch (error) {
				hostError = error instanceof Error ? error : new Error(String(error));
			}
			expect(hostError?.message).toMatch(/Could not find/);
			const resultPatch = await runner.emitToolResult({
				type: "tool_result",
				toolName: "edit",
				toolCallId,
				input,
				content: [{ type: "text", text: hostError?.message ?? "host failed" }],
				details: undefined,
				isError: true,
			});

			expect(resultPatch).toBeUndefined();
			expect(pending.size).toBe(0);
			expect(await fs.readFile(filePath, "utf-8")).toBe(
				"const a = 99;\nconst b = 2;\n",
			);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("can clear a pending plan from tool_execution_end when no tool_result arrives", async () => {
		const tmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "pi-edit-terminal-cleanup-"),
		);
		try {
			const pending = new Map<string, PartialPlan>([
				[
					"aborted-call",
					{
						applied: [0],
						failed: [{ index: 1, reason: "oldText_not_found" }],
					},
				],
			]);
			const extension = probeExtension("<adaptive-cleanup-probe>", {
				tool_execution_end: [
					async (event) => {
						if (event.type === "tool_execution_end") {
							pending.delete(event.toolCallId);
						}
						return undefined;
					},
				],
			});
			const runner = probeRunner(tmpDir, extension);

			await runner.emit({
				type: "tool_execution_end",
				toolCallId: "aborted-call",
				toolName: "edit",
				result: {
					content: [{ type: "text", text: "Operation aborted" }],
				},
				isError: true,
			});

			expect(pending.size).toBe(0);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});
