import { afterAll, beforeAll, expect, test } from "bun:test";
import { gate, judge, LiveCallBlocked } from "../src/judge/backends";
import type { BackendId, Questions } from "../src/judge/types";
import { startMock } from "../src/mock/mock-server";

let mock: ReturnType<typeof startMock>;
beforeAll(() => (mock = startMock()));
afterAll(() => mock.stop());

const env = { TYPESAFE_API_KEY: "m1", OPENAI_API_KEY: "m2", ZOOM_AI_API_KEY: "m3" };
const questions: Questions = {
	supported: { type: "noul", instructions: "Does the evidence support the claim?", criteria: { true: "yes", false: "no" } },
	pick: { type: "choice", instructions: "Which option?", criteria: { alpha: "first", beta: "second", gamma: null } },
	urgency: { type: "score", instructions: "How urgent?", criteria: ["later", "this week", "now"] },
};
const base = (b: BackendId) => (b.startsWith("zoom") ? `${mock.url}/v2/aiservices` : mock.url);

test("same typed questions -> same output shape on every backend", async () => {
	const shapes = new Set<string>();
	for (const b of ["jev", "openai-decisions", "zoom-decisions", "zoom-decisions-pro"] as BackendId[]) {
		const r = await judge(b, { claim: "c", evidence: "e" }, questions, { baseUrl: base(b), env });
		expect(r.backend).toBe(b);
		expect(r.usage.input_tokens).toBeGreaterThan(0);
		expect(r.cost_usd).toBeGreaterThan(0);
		const shape = Object.entries(r.answers)
			.map(([id, a]) => `${id}:${a.type}:${Object.keys(a).sort().join(",")}`)
			.sort()
			.join("|");
		shapes.add(shape);
		expect(["yes", "no", "abstain"]).toContain(gate(r.answers.supported));
	}
	expect(shapes.size).toBe(1);
});

test("zoom backend splits >10 questions and reports request ids", async () => {
	const many: Questions = {};
	for (let i = 0; i < 14; i++) many[`q${i}`] = { type: "noul", instructions: `q${i}?` };
	const r = await judge("zoom-decisions", "text", many, { baseUrl: base("zoom-decisions"), env });
	expect(Object.keys(r.answers).length).toBe(14);
	expect(r.request_ids.length).toBe(2);
});

test("live endpoints are blocked without JUDGE_LIVE_OK=1, before any key or network use", async () => {
	let called = false;
	const spy = (async () => {
		called = true;
		throw new Error("no network in tests");
	}) as unknown as typeof fetch;
	for (const b of ["jev", "openai-decisions", "zoom-decisions"] as BackendId[]) {
		await expect(judge(b, "x", questions, { env, fetch: spy })).rejects.toBeInstanceOf(LiveCallBlocked);
	}
	expect(called).toBe(false);
});

test("secret tripwire refuses credential-looking state", async () => {
	await expect(
		judge("zoom-decisions", { note: "api_key = xxxxxxxxxxxxxxxxxxxx" }, questions, { baseUrl: base("zoom-decisions"), env }),
	).rejects.toThrow(/credential/);
});

test("CLI --dry-run prints the wire body without a request", async () => {
	const p = Bun.spawn(
		["bun", "bin/judge.ts", "--backend", "zoom-decisions-pro", "--dry-run", "--state", '"hello"', "--questions", JSON.stringify(questions)],
		{ cwd: `${import.meta.dir}/..`, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe" },
	);
	const out = JSON.parse(await new Response(p.stdout).text());
	expect(await p.exited).toBe(0);
	expect(out.wire[0].model).toBe("zoom-decisions-pro");
	expect(out.wire[0].questions.map((q: any) => q.type)).toEqual(["predicate", "choice", "score"]);
});

test("CLI exits 3 when a live call is blocked", async () => {
	const p = Bun.spawn(["bun", "bin/judge.ts", "--backend", "zoom-decisions", "--state", '"x"', "--questions", JSON.stringify(questions)], {
		cwd: `${import.meta.dir}/..`,
		env: { PATH: process.env.PATH ?? "", ZOOM_AI_API_KEY: "m3" },
		stderr: "pipe",
	});
	expect(await p.exited).toBe(3);
});
