/**
 * Context-Isolated Workflow Extension — v4
 *
 * Pipeline: Write → Test → Review → Fix → Verify → Done
 *
 * Modes:
 *   /workflow [name] <spec>           — full cycle
 *   /workflow [name] quick <spec>     — skip review
 *   /workflow [name] strict <spec>    — 90% coverage required
 *
 * Creates: projects/<name>/src/  +  projects/<name>/tests/
 * Outputs: projects/<name>/README.md, POSTMORTEM.md (on failure)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

type WorkflowStage = "write" | "test" | "review" | "fix" | "verify" | "done";
type WorkflowMode = "default" | "quick" | "strict";

interface Workflow {
	active: boolean; stage: WorkflowStage; mode: WorkflowMode;
	projectName: string; projectDir: string; spec: string;
	iteration: number; maxIterations: number; coverageThreshold: number;
	testsPassed: boolean; reviewIssues: string[];
	lintPassed: boolean; typeCheckPassed: boolean; coveragePct: number | null;
	history: { stage: string; passed: boolean; detail: string }[];
	startTime: string;
}

const STAGE_DESCRIPTIONS: Record<WorkflowStage, string> = {
	write: "📝 Writing", test: "🧪 Testing", review: "🔍 Review",
	fix: "🔧 Fixing", verify: "✅ Verifying", done: "🎉 Complete",
};

// ---- Helpers ----

const extractIssues = (text: string): string[] => {
	const refs: string[] = [];
	const matches = text.matchAll(/(?:fixes|closes|resolves|refs?|#|RM-|GH-)(\d[\d-]*)/gi);
	for (const m of matches) refs.push(m[0]);
	return [...new Set(refs)];
};

const buildChecklist = (spec: string): string[] => {
	const items: string[] = [];
	const s = spec.toLowerCase();
	if (/auth|password|login|token/i.test(s)) items.push("Security: injection, hashing, token safety");
	if (/api|fetch|http|request/i.test(s)) items.push("API: error handling, timeouts, response validation");
	if (/file|fs|read|write|save/i.test(s)) items.push("I/O: error recovery, missing files, encoding");
	if (/async|promise|await/i.test(s)) items.push("Async: error propagation, unhandled rejections");
	if (/ui|component|render|dom/i.test(s)) items.push("UI: a11y, loading/empty states, error boundaries");
	if (/db|database|sql|query/i.test(s)) items.push("Data: injection, transactions, connection handling");
	return items;
};

const generateName = (spec: string): string => {
	const skip = new Set(["a", "an", "the", "in", "at", "to", "for", "of",
		"create", "build", "make", "add", "implement", "write", "use"]);
	const words = spec.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/).filter(w => w.length > 2 && !skip.has(w));
	return (words.slice(0, 3).join("-")) || "project";
};

const gitCommit = async (message: string) => {
	try {
		const { execSync } = await import("node:child_process");
		execSync("git add -A", { stdio: "pipe" });
		execSync(`git commit -m "${message}"`, { stdio: "pipe" });
	} catch { /* best-effort */ }
};

// ---- Extension ----

export default function (pi: ExtensionAPI) {
	let workflow: Workflow | null = null;

	const updateStatus = (ctx: any) => {
		if (workflow?.active) {
			const modeLabel = workflow.mode !== "default" ? ` [${workflow.mode}]` : "";
			ctx.ui.setStatus("context-workflow", `${STAGE_DESCRIPTIONS[workflow.stage]}${modeLabel} (${workflow.iteration}/${workflow.maxIterations})`);
			pi.appendEntry("context-workflow-state", workflow);
		} else {
			ctx.ui.setStatus("context-workflow", undefined);
		}
	};

	const logStep = (stage: string, passed: boolean, detail: string) => {
		if (workflow) workflow.history.push({ stage, passed, detail });
	};

	const buildPostMortem = (w: Workflow): string => {
		const lines = [
			"## ⚠️ Workflow Failed — Post-Mortem", "",
			`**Project**: ${w.projectName}  |  **Started**: ${w.startTime}  |  **Iterations**: ${w.iteration}/${w.maxIterations}`,
			`**Mode**: ${w.mode}  |  **Coverage threshold**: ${w.coverageThreshold}%`, "",
			"### Timeline",
		];
		w.history.forEach(h => lines.push(`- ${h.passed ? "✅" : "❌"} **${h.stage}**: ${h.detail}`));
		lines.push("", "### Root Cause");
		const lastFail = [...w.history].reverse().find(h => !h.passed);
		lines.push(lastFail ? `Last failure: **${lastFail.stage}** — ${lastFail.detail}` : "Hit iteration cap without convergence.");
		lines.push("", "### Spec", "```", w.spec, "```");
		return lines.join("\n");
	};

	// ---- Lifecycle ----

	pi.on("session_start", async (_e, ctx) => {
		workflow = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "context-workflow-state") workflow = entry.data as Workflow;
		}
		if (workflow?.active) updateStatus(ctx);
	});
	pi.on("session_shutdown", async () => { workflow = null; });

	// ---- Commands ----

	pi.registerCommand("workflow", {
		description: "/workflow [name] [quick|strict] <spec>",
		handler: async (args, ctx) => {
			let raw = (args || "").trim();
			ctx.ui.notify(`DEBUG raw args: "${raw}"`, "info");
			let mode: WorkflowMode = "default";
			let projectName = "";

			// Parse mode
			const modeMatch = raw.match(/^(quick|strict)\b/i);
			if (modeMatch) { mode = modeMatch[1].toLowerCase() as WorkflowMode; raw = raw.slice(modeMatch[0].length).trim(); }

			// Extract custom directory: "in <path>" or "at <path>"
			let customDir = "";
			const pathMatch = raw.match(/(?:in|at|to|into)\s+((?:@|\/|~\/)[a-zA-Z0-9_\/.-]+)/i);
			if (pathMatch) {
				customDir = pathMatch[1]; // @PI_EXTENSIONS/tests or /Users/.../PI_EXTENSIONS/tests
				raw = raw.replace(pathMatch[0], "").trim();
			}

			// Parse project name (skips prepositions/common verbs, requires 3+ chars)
			const skipWords = new Set(["a", "an", "the", "in", "at", "to", "for", "of",
				"create", "build", "make", "add", "implement", "write", "use"]);
			const nameMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9_-]{2,})\b/);
			if (nameMatch && !skipWords.has(nameMatch[1].toLowerCase())) {
				projectName = nameMatch[1];
				raw = raw.slice(nameMatch[0].length).trim();
			}

			let spec = raw;
			if (spec.endsWith(".md") || spec.endsWith(".txt")) {
				try { const fs = await import("node:fs/promises"); spec = await fs.readFile(spec, "utf-8"); }
				catch { ctx.ui.notify(`Could not read: ${spec}`, "error"); return; }
			}
			if (!spec) {
				const r = await ctx.ui.editor("Enter spec:", "# Feature\n\nCreate a module with tests.");
				if (!r) { ctx.ui.notify("Description required", "error"); return; }
				spec = r;
			}

			if (!projectName) projectName = generateName(spec);
			// Strip @ prefix — it's pi shorthand, not a real filesystem path
			const projectDir = customDir.replace(/^@/, "") || `projects/${projectName}`;

			// Create directory structure
			try {
				const { mkdir } = await import("node:fs/promises");
				await mkdir(`${projectDir}/src`, { recursive: true });
				await mkdir(`${projectDir}/tests`, { recursive: true });
			} catch { /* best-effort */ }

			workflow = {
				active: true, stage: "write", mode, projectName, projectDir, spec,
				iteration: 0, maxIterations: 10, coverageThreshold: mode === "strict" ? 90 : 80,
				testsPassed: false, reviewIssues: [],
				lintPassed: false, typeCheckPassed: false, coveragePct: null,
				history: [], startTime: new Date().toISOString(),
			};
			updateStatus(ctx);

			const skipReview = mode === "quick" ? " (review skipped)" : "";
			pi.sendMessage({ customType: "context-workflow", display: true, content: [
				"🚀 **Workflow Started**" + (mode !== "default" ? ` [${mode}]` : ""),
				"",
				`**Project**: \`${projectName}\` → \`${projectDir}/\``,
				"",
				"**Spec:**", "```", spec, "```", "",
				`**Pipeline:** Write → Test${mode !== "quick" ? " → Review → Fix" : ""} → Verify → Done${skipReview}`,
				mode === "strict" ? "**Gate:** 90% coverage required" : "",
				"",
				`**Stage 1: ${STAGE_DESCRIPTIONS.write}**`,
			].join("\n") });

			pi.sendUserMessage(
				[
					`Implement this feature. Create files in \`${projectDir}/\` with standard structure:`,
					`- \`${projectDir}/src/<module>.ts\` — implementation`,
					`- \`${projectDir}/tests/<module>.test.ts\` — vitest tests`,
					"",
					"Create comprehensive tests. When done, call workflow_next.",
				].join("\n"),
				{ deliverAs: "followUp" },
			);
		},
	});

	pi.registerCommand("workflow:status", {
		description: "Check workflow status",
		handler: async (_args, ctx) => {
			if (!workflow?.active) { ctx.ui.notify("No active workflow", "info"); return; }
			const tc = workflow.typeCheckPassed ? "✅" : "❌";
			const ln = workflow.lintPassed ? "✅" : "❌";
			const cv = workflow.coveragePct != null ? `${workflow.coveragePct}%` : "—";
			const modeLabel = workflow.mode !== "default" ? ` [${workflow.mode}]` : "";
			pi.sendMessage({ customType: "context-workflow", display: true, content: [
				`**Project**: \`${workflow.projectName}\`  |  **Stage**: ${STAGE_DESCRIPTIONS[workflow.stage]}${modeLabel}`,
				`**Iteration**: ${workflow.iteration}/${workflow.maxIterations}`,
				`**Tests**: ${workflow.testsPassed ? "✅" : "❌"}  |  TS: ${tc}  |  Lint: ${ln}  |  Cov: ${cv} (≥${workflow.coverageThreshold}%)`,
				`**Issues**: ${workflow.reviewIssues.length}`,
			].join("\n") });
		},
	});

	pi.registerCommand("workflow:cancel", {
		description: "Cancel workflow",
		handler: async (_args, ctx) => {
			if (!workflow?.active) { ctx.ui.notify("No active workflow to cancel", "info"); return; }
			workflow.active = false; updateStatus(ctx);
			ctx.ui.notify("Workflow cancelled", "info"); workflow = null;
		},
	});

	// ---- Tools ----

	pi.registerTool({
		name: "workflow_next", label: "Progress Workflow",
		description: "Move to next stage.",
		parameters: Type.Object({ notes: Type.Optional(Type.String()) }),
		async execute(_id, params, _sig, _up, ctx) {
			if (!workflow?.active) return { content: [{ type: "text", text: "No active workflow — start one with /workflow <spec>" }], details: {} };
			workflow.iteration++;

			if (workflow.iteration >= workflow.maxIterations) {
				workflow.active = false; updateStatus(ctx);
				const pm = buildPostMortem(workflow);
				try {
					const { writeFile } = await import("node:fs/promises");
					await writeFile(`${workflow.projectDir}/POSTMORTEM.md`, pm, "utf-8");
				} catch { /* best-effort */ }
				pi.sendMessage({ customType: "context-workflow", display: true, content: pm });
				return { content: [{ type: "text", text: "⚠️ Maximum iterations reached. Post-mortem generated." }], details: { workflow } };
			}

			let ns: WorkflowStage, msg: string, np: string | null = null, cm: string | null = null;
			const isQuick = workflow.mode === "quick";

			switch (workflow.stage) {
				case "write":
					ns = "test"; msg = "✅ Code written!\n\n**Stage 2: 🧪 Testing**";
					np = `Run the test suite: \`npx vitest run ${workflow.projectDir}/tests/\`. Call workflow_test_result with exit code.`;
					cm = `wip: ${workflow.projectName} — implementation + tests`;
					logStep("write", true, params.notes || "Implementation written");
					break;

				case "test":
					if (workflow.testsPassed) {
						logStep("test", true, "Tests passing");
						if (isQuick) {
							ns = "verify"; msg = "✅ Tests passed! (quick mode)\n\n**Stage 3: ✅ Verification**";
							np = "Run verification: tests → workflow_test_result, then `npx vitest run --coverage` → workflow_verify_result (coveragePct). Then call workflow_complete with summary.";
						} else {
							ns = "review"; msg = "✅ Tests passed!\n\n**Stage 3: 🔍 Review**";
							const checklist = buildChecklist(workflow.spec);
							np = "Review the code with fresh eyes. Read all created files and check for:\n" +
								"1) Code quality & readability\n2) Test coverage\n3) Edge cases\n4) Error handling\n5) Best practices\n" +
								(checklist.length > 0 ? `\n**Domain-specific checks:**\n${checklist.map(c => `- ${c}`).join("\n")}\n` : "") +
								"\nCall workflow_review_result with findings.";
						}
					} else {
						logStep("test", false, "Tests failing");
						ns = "fix"; msg = "❌ Tests failed!\n\n**Stage 4: 🔧 Fixing**";
						np = "Fix the test failures. Review output, fix code. Call workflow_next to re-test.";
					}
					cm = "test: all passing";
					break;

				case "review":
					if (workflow.reviewIssues.length === 0) {
						logStep("review", true, "No issues found");
						ns = "verify"; msg = "✅ Review passed!\n\n**Stage 5: ✅ Verification**";
						np = "Run verification: tests → workflow_test_result, then coverage → workflow_verify_result (coveragePct)." +
							(workflow.mode === "strict" ? " ⚠️ STRICT: coverage ≥90% required." : "") +
							"\n\nThen call workflow_complete with summary.";
					} else {
						logStep("review", false, `${workflow.reviewIssues.length} issues found`);
						ns = "fix"; msg = `📋 ${workflow.reviewIssues.length} issue(s) found\n\n**Stage 4: 🔧 Fixing**`;
						np = `Fix these review issues:\n${workflow.reviewIssues.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nCall workflow_next to re-test.`;
					}
					break;

				case "fix":
					logStep("fix", true, params.notes || "Fixes applied");
					ns = "test"; msg = "🔧 Fixes applied!\n\n**Stage 2: 🧪 Re-testing**";
					np = "Run tests again to verify fixes. Call workflow_test_result.";
					cm = `fix: ${workflow.projectName} — address review feedback`;
					break;

				case "verify":
					// Don't set active=false — let workflow_complete handle it
					ns = "done"; msg = "🎉 All gates passed!\n\nCall workflow_complete with summary to finalize.";
					break;

				default: ns = "done"; msg = "✅ Complete";
			}

			workflow.stage = ns; updateStatus(ctx);
			if (np) pi.sendUserMessage(np, { deliverAs: "followUp" });
			if (cm) gitCommit(cm);
			return { content: [{ type: "text", text: msg }], details: { workflow, stage: ns, notes: params.notes } };
		},
	});

	pi.registerTool({
		name: "workflow_test_result", label: "Report Test Result",
		description: "Report test exit code.",
		parameters: Type.Object({ exitCode: Type.Number(), output: Type.Optional(Type.String()) }),
		async execute(_id, p, _sig, _up, ctx) {
			if (!workflow?.active) return { content: [{ type: "text", text: "No active workflow — start one with /workflow <spec>" }], details: {} };
			workflow.testsPassed = p.exitCode === 0;
			let msg = workflow.testsPassed ? `✅ Tests passed (exit ${p.exitCode})` : `❌ Tests failed (exit ${p.exitCode})`;
			if (!workflow.testsPassed && p.output) msg += `\n\nOutput:\n${p.output.substring(0, 500)}`;
			updateStatus(ctx); pi.sendUserMessage("Call workflow_next to progress.", { deliverAs: "followUp" });
			return { content: [{ type: "text", text: msg }], details: { workflow, testsPassed: workflow.testsPassed } };
		},
	});

	pi.registerTool({
		name: "workflow_verify_result", label: "Report Verification",
		description: "Report type-check, lint, coverage results.",
		parameters: Type.Object({
			typeCheckPassed: Type.Optional(Type.Boolean()),
			lintPassed: Type.Optional(Type.Boolean()),
			coveragePct: Type.Optional(Type.Number()),
		}),
		async execute(_id, p, _sig, _up, ctx) {
			if (!workflow?.active) return { content: [{ type: "text", text: "No active workflow — start one with /workflow <spec>" }], details: {} };
			const r: string[] = [];
			if (p.typeCheckPassed !== undefined) { workflow.typeCheckPassed = p.typeCheckPassed; r.push(`Type-check: ${p.typeCheckPassed ? "✅" : "❌"}`); }
			if (p.lintPassed !== undefined) { workflow.lintPassed = p.lintPassed; r.push(`Lint: ${p.lintPassed ? "✅" : "❌"}`); }
			if (p.coveragePct !== undefined) {
				workflow.coveragePct = p.coveragePct;
				const met = p.coveragePct >= (workflow!.coverageThreshold);
				r.push(`Coverage: ${met ? "✅" : "❌"} ${p.coveragePct}%` + (met ? "" : ` (need ≥${workflow!.coverageThreshold}%)`));
			}
			updateStatus(ctx); pi.sendUserMessage("Call workflow_next to progress.", { deliverAs: "followUp" });
			return { content: [{ type: "text", text: r.join("\n") }], details: { workflow, ...p } };
		},
	});

	pi.registerTool({
		name: "workflow_review_result", label: "Report Review",
		description: "Report review findings.",
		parameters: Type.Object({ issues: Type.Array(Type.String()), summary: Type.Optional(Type.String()) }),
		async execute(_id, p, _sig, _up, ctx) {
			if (!workflow?.active) return { content: [{ type: "text", text: "No active workflow — start one with /workflow <spec>" }], details: {} };
			workflow.reviewIssues = p.issues;
			let msg = p.issues.length === 0
				? "✅ Review passed!"
				: `📋 ${p.issues.length} issue(s):\n${p.issues.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
			if (p.summary) msg += `\n\n**Summary**: ${p.summary}`;
			updateStatus(ctx); pi.sendUserMessage("Call workflow_next to progress.", { deliverAs: "followUp" });
			return { content: [{ type: "text", text: msg }], details: { workflow, issues: p.issues, summary: p.summary } };
		},
	});

	pi.registerTool({
		name: "workflow_complete", label: "Complete Workflow",
		description: "Mark workflow complete.",
		parameters: Type.Object({ summary: Type.String() }),
		async execute(_id, p, _sig, _up, ctx) {
			if (!workflow?.active) return { content: [{ type: "text", text: "No active workflow — start one with /workflow <spec>" }], details: {} };

			const w = workflow; // snapshot
			w.stage = "done"; w.active = false; updateStatus(ctx);

			const issues = extractIssues(w.spec);
			const tc = w.typeCheckPassed ? "✅" : "❌";
			const ln = w.lintPassed ? "✅" : "❌";
			const cv = w.coveragePct != null ? `${w.coveragePct}%` : "—";
			const covMet = w.coveragePct != null && w.coveragePct >= w.coverageThreshold;
			const allGates = w.testsPassed && covMet;

			// ---- Completion Banner (visible to user) ----
			pi.sendMessage({
				customType: "context-workflow", display: true, content: [
					"## " + (allGates ? "✅" : "⚠️") + ` Workflow Complete — \`${w.projectName}\``,
					"",
					`**${p.summary}**`,
					"",
					`**Mode**: ${w.mode}  |  **Iterations**: ${w.iteration}`,
					`**Tests**: ${w.testsPassed ? "Passed" : "Failed"}  |  **Coverage**: ${cv}${covMet ? "" : " ⚠️"}`,
					...(issues.length > 0 ? [`**Linked issues**: ${issues.join(", ")}`] : []),
				].join("\n"),
			});

			// ---- README.md ----
			try {
				const { writeFile } = await import("node:fs/promises");
				const readme = [
					`# ${w.projectName}`,
					"",
					"## Summary",
					p.summary,
					"",
					"## Spec",
					"```",
					w.spec,
					"```",
					"",
					"## Results",
					`| Gate | Status | Threshold |`,
					`|------|--------|-----------|`,
					`| Tests | ${w.testsPassed ? "✅ Pass" : "❌ Fail"} | — |`,
					`| Type-check | ${w.typeCheckPassed ? "✅ Pass" : "❌ Fail"} | — |`,
					`| Lint | ${w.lintPassed ? "✅ Pass" : "❌ Fail"} | — |`,
					`| Coverage | ${cv} | ≥${w.coverageThreshold}% |`,
					"",
					"## Stats",
					`- Mode: ${w.mode}  |  Iterations: ${w.iteration}`,
					`- Review issues: ${w.reviewIssues.length}`,
					...(issues.length > 0 ? [`- References: ${issues.join(", ")}`] : []),
				].join("\n");
				await writeFile(`${w.projectDir}/README.md`, readme, "utf-8");
			} catch { /* best-effort */ }

			// ---- Changelog ----
			try {
				const { appendFile } = await import("node:fs/promises");
				const date = new Date().toISOString().split("T")[0];
				const refs = issues.length > 0 ? ` (${issues.join(", ")})` : "";
				await appendFile("CHANGELOG.md", `## ${date} — ${w.projectName}: ${p.summary}${refs}\n`, "utf-8");
			} catch { /* best-effort */ }

			gitCommit(`chore: workflow complete — ${w.projectName}`);

			return { content: [{ type: "text", text: [
				(allGates ? "🎉" : "⚠️") + ` Workflow Complete — ${w.projectName}`,
				"",
				p.summary,
				"",
				"**Gates:**",
				`- Tests: ${w.testsPassed ? "✅" : "❌"}  |  Coverage: ${cv} (≥${w.coverageThreshold}%)`,
				`- Review issues: ${w.reviewIssues.length} resolved`,
				"",
				`📄 README: \`${w.projectDir}/README.md\``,
				...(issues.length > 0 ? [`🔗 Linked: ${issues.join(", ")}`] : []),
				"",
				"Start another with `/workflow [name] [quick|strict] <spec>`",
			].join("\n") }], details: { workflow: w, summary: p.summary } };
		},
	});

	// ---- Context injection ----

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!workflow?.active) return {};
		const strictNote = workflow.mode === "strict" ? `  ⚠️ STRICT: coverage ≥${workflow.coverageThreshold}% required` : "";
		return { systemPrompt: event.systemPrompt + [
			"", "---", "**🔄 WORKFLOW ACTIVE**",
			"",
			`**Project**: \`${workflow.projectName}\` → \`${workflow.projectDir}/\``,
			`**Stage**: ${STAGE_DESCRIPTIONS[workflow.stage]} (${workflow.iteration}/${workflow.maxIterations}) [${workflow.mode}]${strictNote}`,
			`**Spec**: ${workflow.spec.substring(0, 200)}...`,
			"",
			"Follow workflow instructions. Call the appropriate tool when done.",
			"---",
		].join("\n") };
	});

	// ---- Auto-detect test results ----

	pi.on("tool_result", async (event, ctx) => {
		if (!workflow?.active || workflow.stage !== "test") return;
		const input = event.input as Record<string, unknown> | undefined;
		const details = event.details as Record<string, unknown> | undefined;
		if (event.toolName === "bash" && typeof input?.command === "string") {
			const cmd = input.command.toLowerCase();
			if (/(pytest|npm test|cargo test|go test|mvn test|vitest)/.test(cmd) && typeof details?.exitCode === "number") {
				ctx.ui.notify(
					`Auto-detect: ${details.exitCode === 0 ? "✅ Passed" : "❌ Failed"}`,
					details.exitCode === 0 ? "info" : "error",
				);
			}
		}
	});
}
