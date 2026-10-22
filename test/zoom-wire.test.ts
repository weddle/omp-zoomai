import { describe, expect, test } from "bun:test";
import {
	fromZoomResponses,
	hasImageInput,
	retryAfterSeconds,
	synthesizeConfidence,
	toZoomRequests,
	wireModel,
	ZOOM_MAX_QUESTIONS,
} from "../extension/zoom-ai/zoom-wire";

const q = (i: number) => ({ type: "predicate" as const, name: `q${i}`, instructions: `question ${i}` });

describe("toZoomRequests", () => {
	test("caps at 10 questions per request, preserving order", () => {
		const chunks = toZoomRequests({ model: "zoom-decisions-pro", input: "x", questions: Array.from({ length: 23 }, (_, i) => q(i)) });
		expect(ZOOM_MAX_QUESTIONS).toBe(10);
		expect(chunks.map(c => c.questions.length)).toEqual([10, 10, 3]);
		expect(chunks.flatMap(c => c.questions.map(x => x.name))).toEqual(Array.from({ length: 23 }, (_, i) => `q${i}`));
		expect(chunks.every(c => c.model === "zoom-decisions-pro")).toBe(true);
	});
	test("standard tier omits model (default under either documented name)", () => {
		for (const id of ["zoom-decisions", "zoom-decisions-standard", "", undefined]) {
			expect(toZoomRequests({ model: id, input: "x", questions: [q(0)] })[0].model).toBeUndefined();
		}
		expect(wireModel("zoom-decisions-pro")).toBe("zoom-decisions-pro");
	});
	test("sets enable_image_input only when an input_image is present", () => {
		const text = toZoomRequests({ input: "x", questions: [q(0)] })[0];
		expect(text.enable_image_input).toBeUndefined();
		const input = [
			{ role: "user" as const, content: [{ type: "input_text" as const, text: "t" }, { type: "input_image" as const, image_url: "data:image/png;base64,AA" }] },
		];
		expect(hasImageInput(input)).toBe(true);
		expect(toZoomRequests({ input, questions: [q(0)] })[0].enable_image_input).toBe(true);
	});
	test("rejects empty question lists and bad caps", () => {
		expect(() => toZoomRequests({ input: "x", questions: [] })).toThrow();
		expect(() => toZoomRequests({ input: "x", questions: [q(0)] }, { maxQuestions: 0 })).toThrow();
	});
});

describe("fromZoomResponses", () => {
	test("maps input_units to input_tokens, sums chunks, keeps order, keeps refusals", () => {
		const merged = fromZoomResponses([
			{
				request_id: "r1",
				model: "zoom-decisions-standard",
				answers: [
					{ type: "predicate", name: "a", probability: 0.9 },
					{ type: "refusal", name: "b" },
				],
				usage: { input_units: 100, output_units: 2, unit_type: "tokens" },
			},
			{
				request_id: "r2",
				model: "zoom-decisions-standard",
				answers: [{ type: "choice", name: "c", choice: true, probabilities: [{ value: true, probability: 0.7 }, { value: false, probability: 0.3 }], confidence: 0.4 }],
				usage: { input_units: 50, output_units: 1, unit_type: "tokens" },
			},
		]);
		expect(merged.usage).toEqual({ input_tokens: 150, output_tokens: 0 });
		expect(merged.answers.map(a => a.name)).toEqual(["a", "b", "c"]);
		expect(merged.zoom.request_ids).toEqual(["r1", "r2"]);
		expect(merged.zoom.confidence_synthesized).toEqual([]);
		expect((merged.answers[2] as any).choice).toBe(true); // boolean preserved, as the guide requires
	});
	test("synthesizes missing confidence (omp's decoder requires it) and reports it", () => {
		const merged = fromZoomResponses([
			{
				answers: [
					{ type: "score", name: "s", score: 1.2, probabilities: [{ value: 0, probability: 0.1 }, { value: 1, probability: 0.6 }, { value: 2, probability: 0.3 }] },
				],
			},
		]);
		expect((merged.answers[0] as any).confidence).toBe(0.6);
		expect(merged.zoom.confidence_synthesized).toEqual(["s"]);
		expect(synthesizeConfidence([])).toBe(0);
	});
	test("throws on a malformed envelope", () => {
		expect(() => fromZoomResponses([{} as any])).toThrow();
	});
});

test("retryAfterSeconds reads Retry-After or 503 metadata", () => {
	expect(retryAfterSeconds(429, new Headers({ "retry-after": "3" }), {})).toBe(3);
	expect(retryAfterSeconds(503, new Headers(), { metadata: { retry_after_seconds: 7 } })).toBe(7);
	expect(retryAfterSeconds(500, new Headers(), {})).toBeUndefined();
});
