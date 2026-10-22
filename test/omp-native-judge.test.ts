/**
 * End-to-end with omp's own code: omp v18.12.1 NativeJudge (api "openai-decisions", the exact wire omp uses
 * for the judge role) -> our loopback shim -> mock Zoom. Proves the extension point works without a fork.
 * Skips when the vendored omp checkout (vendor/oh-my-pi @ v18.12.1, gitignored) is absent.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { startShim } from "../extension/zoom-ai/shim";
import { startMock } from "../src/mock/mock-server";

const NATIVE = `${import.meta.dir}/../vendor/oh-my-pi/packages/ai/src/judgment/native.ts`;
const have = existsSync(NATIVE);
let mock: ReturnType<typeof startMock>;
let shim: ReturnType<typeof startShim>;
beforeAll(() => {
	mock = startMock();
	shim = startShim({ upstreamBase: `${mock.url}/v2/aiservices` });
});
afterAll(() => {
	shim.stop();
	mock.stop();
});

const model = (id: string, baseUrl: string) => ({
	id,
	name: id,
	api: "openai-decisions",
	provider: "zoom-ai",
	baseUrl,
	reasoning: false,
	input: ["text"],
	cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 64000,
	maxTokens: 1,
});

test.skipIf(!have)("omp NativeJudge answers 12 typed questions through the shim (split 10+2 upstream)", async () => {
	const { createNativeJudge, isJudgmentApi } = await import(NATIVE);
	expect(isJudgmentApi("openai-decisions")).toBe(true);
	expect(isJudgmentApi("zoom-decisions")).toBe(false); // no native Zoom wire in omp 18.12.1
	const judge = createNativeJudge(model("zoom-decisions", `${shim.url}/v1`), { apiKey: "mock-key-not-real-123" });
	const questions: Record<string, any> = {};
	for (let i = 0; i < 10; i++) questions[`n${i}`] = { type: "noul", instructions: `fact ${i}?`, criteria: { true: "yes", false: "no" } };
	questions.route = { type: "choice", instructions: "Which team?", criteria: { billing: "money", support: null } };
	questions.sev = { type: "score", instructions: "Severity", criteria: ["cosmetic", "workaround", "blocked"] };
	const before = mock.recorded.length;
	const r = await judge.judge({ state: { ticket: "charged twice" }, questions });
	expect(r.api).toBe("openai-decisions");
	expect(r.provider).toBe("zoom-ai");
	expect(Object.keys(r.answers).sort()).toEqual(Object.keys(questions).sort());
	expect(r.answers.n0.type).toBe("noul");
	expect(["billing", "support"]).toContain(r.answers.route.choice);
	expect(typeof r.answers.sev.score).toBe("number");
	expect(r.usage.input).toBeGreaterThan(0); // input_units mapped, so omp's session ledger sees tokens
	const sent = mock.recorded.slice(before);
	expect(sent.map(s => s.body.questions.length)).toEqual([10, 2]);
	// noul criteria folded into predicate instructions exactly as omp does for OpenAI
	expect(sent[0].body.questions[0].instructions).toContain("True means: yes");
});

test.skipIf(!have)("omp surfaces a Zoom refusal as content-blocked", async () => {
	const { createNativeJudge } = await import(NATIVE);
	const judge = createNativeJudge(model("zoom-decisions-pro", `${shim.url}/v1`), { apiKey: "mock-key-not-real-123" });
	await expect(judge.judge({ state: "x", questions: { a: { type: "noul", instructions: "MOCK_REFUSE" } } })).rejects.toThrow(/refused/);
});

test.skipIf(!have)("without the shim, omp's openai-decisions wire cannot reach Zoom's route (proves the shim is needed)", async () => {
	const { createNativeJudge } = await import(NATIVE);
	// baseUrl as if pointed at Zoom directly: omp appends /decisions, Zoom needs /decisions/decide.
	const judge = createNativeJudge(model("zoom-decisions", `${mock.url}/v2/aiservices`), { apiKey: "mock-key-not-real-123" });
	await expect(judge.judge({ state: "x", questions: { a: { type: "noul", instructions: "q" } } })).rejects.toThrow(/404/);
});
