import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startShim } from "../extension/zoom-ai/shim";
import { startMock } from "../src/mock/mock-server";

const KEY = "mock-key-not-real-123";
let mock: ReturnType<typeof startMock>;
let mockNoConf: ReturnType<typeof startMock>;
let shim: ReturnType<typeof startShim>;
let shimBearer: ReturnType<typeof startShim>;
let shimNoConf: ReturnType<typeof startShim>;

beforeAll(() => {
	mock = startMock();
	mockNoConf = startMock({ omitConfidence: true });
	shim = startShim({ upstreamBase: `${mock.url}/v2/aiservices` });
	shimBearer = startShim({ upstreamBase: `${mock.url}/v2/aiservices`, auth: "bearer" });
	shimNoConf = startShim({ upstreamBase: `${mockNoConf.url}/v2/aiservices` });
});
afterAll(() => [mock, mockNoConf, shim, shimBearer, shimNoConf].forEach(s => s.stop()));

const post = (base: string, body: unknown, key: string | undefined = KEY) =>
	fetch(`${base}/v1/decisions`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
		body: JSON.stringify(body),
	});

const questions = (n: number) =>
	Array.from({ length: n }, (_, i) =>
		i % 3 === 0
			? { type: "predicate", name: `p${i}`, instructions: `Is ${i} relevant?` }
			: i % 3 === 1
				? { type: "choice", name: `c${i}`, instructions: "route", choices: [{ value: "a" }, { value: "b", description: "bee" }] }
				: { type: "score", name: `s${i}`, instructions: "rate", levels: [{ label: "low" }, { label: "mid" }, { label: "high" }] },
	);

describe("shim -> mock Zoom", () => {
	test("forwards x-api-key only, to /v2/aiservices/decisions/decide, splitting 25 questions into 3 requests", async () => {
		const before = mock.recorded.length;
		const res = await post(shim.url, { model: "zoom-decisions", input: "ticket text", questions: questions(25) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.answers.map((a: any) => a.name)).toEqual(questions(25).map(q => q.name));
		expect(body.usage.input_tokens).toBeGreaterThan(0);
		expect(body.usage.output_tokens).toBe(0);
		const sent = mock.recorded.slice(before);
		expect(sent.length).toBe(3);
		for (const r of sent) {
			expect(r.path).toBe("/v2/aiservices/decisions/decide");
			expect(r.headers["x-api-key"]).toBe(KEY);
			expect(r.headers.authorization).toBeUndefined();
			expect(r.body.model).toBeUndefined(); // standard tier: server default
			expect(r.body.questions.length).toBeLessThanOrEqual(10);
		}
	});
	test("bearer mode sends Authorization only", async () => {
		const before = mock.recorded.length;
		expect((await post(shimBearer.url, { model: "zoom-decisions-pro", input: "x", questions: questions(1) })).status).toBe(200);
		const r = mock.recorded[before];
		expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(r.headers["x-api-key"]).toBeUndefined();
		expect(r.body.model).toBe("zoom-decisions-pro");
	});
	test("refuses missing key and the unset-env-var placeholder omp would send", async () => {
		expect((await post(shim.url, { input: "x", questions: questions(1) }, "")).status).toBe(401);
		expect((await post(shim.url, { input: "x", questions: questions(1) }, "ZOOM_AI_API_KEY")).status).toBe(401);
	});
	test("passes upstream 401/400 through", async () => {
		expect((await post(shim.url, { input: "x", questions: questions(1) }, "bad-key")).status).toBe(401);
		const r = await post(shim.url, { input: "x", questions: [{ type: "predicate", name: "a", instructions: "" }] });
		expect(r.status).toBe(400);
		expect((await r.json()).reason).toBe("VALIDATION_MISSING_FIELD");
	});
	test("429 keeps Retry-After; 503 metadata becomes Retry-After", async () => {
		const r1 = await post(shim.url, { input: "MOCK_RATE_LIMIT", questions: questions(1) });
		expect(r1.status).toBe(429);
		expect(r1.headers.get("retry-after")).toBe("1");
		const r2 = await post(shim.url, { input: "MOCK_UNAVAILABLE", questions: questions(1) });
		expect(r2.status).toBe(503);
		expect(r2.headers.get("retry-after")).toBe("2");
	});
	test("image input gets enable_image_input", async () => {
		const before = mock.recorded.length;
		const input = [{ role: "user", content: [{ type: "input_text", text: "pkg" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] }];
		expect((await post(shim.url, { input, questions: questions(1) })).status).toBe(200);
		expect(mock.recorded[before].body.enable_image_input).toBe(true);
	});
	test("synthesizes confidence when Zoom omits it", async () => {
		const res = await post(shimNoConf.url, { input: "x", questions: questions(3) });
		const body = await res.json();
		expect(body.answers[1].confidence).toBeGreaterThan(0);
		expect(body.zoom.confidence_synthesized).toEqual(["c1", "s2"]);
	});
	test("404 for anything but POST */decisions", async () => {
		expect((await fetch(`${shim.url}/v1/chat/completions`, { method: "POST", body: "{}" })).status).toBe(404);
	});
});
