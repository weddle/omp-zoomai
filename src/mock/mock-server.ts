/**
 * Offline mock of three decision APIs, shaped from their public docs. Deterministic answers (hash of input +
 * instructions). Never contacts the network. Magic strings in `input` trigger error paths:
 *   "MOCK_RATE_LIMIT" -> 429 + Retry-After: 1        "MOCK_UNAVAILABLE" -> 503 + metadata.retry_after_seconds
 *   instructions containing "MOCK_REFUSE" -> that question returns { type: "refusal" }
 * Zoom validation mirrors https://developers.zoom.us/docs/api/ai-services/ and .../decisions/fast-mode/.
 */
export interface MockOptions {
	/** Omit choice/score `confidence` (the API-reference schema does not list it). */
	omitConfidence?: boolean;
	/** Zoom model ids accepted. */
	zoomModels?: string[];
}

export interface RecordedRequest {
	path: string;
	headers: Record<string, string>;
	body: any;
}

function hash01(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return ((h >>> 0) % 10_000) / 10_000;
}

function softmax(xs: number[]): number[] {
	const m = Math.max(...xs);
	const e = xs.map(x => Math.exp((x - m) * 6));
	const s = e.reduce((a, b) => a + b, 0);
	return e.map(x => x / s);
}

const tokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);
const j = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const bad = (message: string, reason = "INVALID_INPUT") => j(400, { code: 400, reason, message, metadata: {} });

function inputText(input: any): string {
	if (typeof input === "string") return input;
	return JSON.stringify(input);
}

function decisionAnswer(q: any, input: string, omitConfidence: boolean): any {
	const seed = `${input}|${q.instructions}`;
	if (String(q.instructions).includes("MOCK_REFUSE")) return { type: "refusal", name: q.name };
	if (q.type === "predicate") return { type: "predicate", name: q.name, probability: hash01(seed) };
	const items = q.type === "choice" ? q.choices : q.levels;
	const probs = softmax(items.map((it: any, i: number) => hash01(`${seed}|${i}|${it.value ?? it.label}`)));
	const best = probs.indexOf(Math.max(...probs));
	const conf = omitConfidence ? {} : { confidence: Math.round(probs[best] * 100) / 100 };
	if (q.type === "choice") {
		return {
			type: "choice",
			name: q.name,
			choice: q.choices[best].value,
			probabilities: q.choices.map((c: any, i: number) => ({ value: c.value, probability: probs[i] })),
			...conf,
		};
	}
	return {
		type: "score",
		name: q.name,
		score: probs.reduce((a: number, p: number, i: number) => a + p * i, 0),
		probabilities: q.levels.map((l: any, i: number) => ({ value: i, label: l.label, probability: probs[i] })),
		...conf,
	};
}

function validateZoom(body: any, models: string[]): Response | undefined {
	if (!body || body.input === undefined) return bad("input is required", "VALIDATION_MISSING_FIELD");
	if (!Array.isArray(body.questions) || body.questions.length < 1) return bad("questions is required", "VALIDATION_MISSING_FIELD");
	if (body.questions.length > 10) return bad("at most 10 questions per request");
	if (body.model !== undefined && !models.includes(body.model)) return bad(`unsupported model ${body.model}`);
	const names = new Set<string>();
	for (const q of body.questions) {
		if (!q.instructions) return bad("question instructions are required", "VALIDATION_MISSING_FIELD");
		if (!["predicate", "choice", "score"].includes(q.type)) return bad(`unsupported question type ${q.type}`);
		if (q.name !== undefined) {
			if (names.has(q.name)) return bad(`duplicate question name ${q.name}`);
			names.add(q.name);
		}
		if (q.type === "choice") {
			if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 255) return bad("choices must have 2-255 items");
			const vals = new Set(q.choices.map((c: any) => JSON.stringify(c.value)));
			if (vals.size !== q.choices.length) return bad("duplicate choice value");
		}
		if (q.type === "score" && (!Array.isArray(q.levels) || q.levels.length < 2 || q.levels.length > 10)) {
			return bad("levels must have 2-10 items");
		}
	}
	const hasImage =
		Array.isArray(body.input) && body.input.some((m: any) => m.content?.some((p: any) => p.type === "input_image"));
	if (Array.isArray(body.input) && body.input.some((m: any) => m.role !== "user")) return bad("only user messages are supported");
	if (hasImage && body.enable_image_input !== true) return bad('input_image requires "enable_image_input": true');
	return undefined;
}

export function createMockHandler(options: MockOptions = {}) {
	const recorded: RecordedRequest[] = [];
	const models = options.zoomModels ?? ["zoom-decisions", "zoom-decisions-standard", "zoom-decisions-pro"];
	let n = 0;
	const handler = async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const headers = Object.fromEntries(req.headers.entries());
		let body: any;
		try {
			body = await req.json();
		} catch {
			return bad("body is not JSON");
		}
		recorded.push({ path: url.pathname, headers, body });

		if (url.pathname === "/v2/aiservices/decisions/decide") {
			const key = headers["x-api-key"] ?? /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
			if (!key || key === "bad-key") return j(401, { code: 124, message: "Invalid access token." });
			const text = inputText(body?.input);
			if (text.includes("MOCK_RATE_LIMIT")) return j(429, { code: 429, message: "Too many requests" }, { "retry-after": "1" });
			if (text.includes("MOCK_UNAVAILABLE"))
				return j(503, { code: 503, reason: "UNAVAILABLE", message: "try later", metadata: { retry_after_seconds: 2 } });
			const err = validateZoom(body, models);
			if (err) return err;
			return j(200, {
				request_id: `req_mock_${++n}`,
				answers: body.questions.map((q: any) => decisionAnswer(q, text, options.omitConfidence === true)),
				model: body.model ?? "zoom-decisions-standard",
				usage: { input_units: tokens(body), output_units: body.questions.length, unit_type: "tokens", details: {} },
			});
		}
		if (url.pathname === "/v1/decisions") {
			// OpenAI Decisions (shape per OpenAI's public Decisions docs and omp's openai-decisions wire).
			const text = inputText(body.input);
			return j(200, {
				answers: body.questions.map((q: any) => decisionAnswer(q, text, false)),
				model: body.model,
				usage: { input_tokens: tokens(body), output_tokens: 0 },
			});
		}
		if (url.pathname === "/v1/systemone") {
			// TypeSafe System One: questions keyed by id; answers keyed by id.
			const text = inputText(body.state);
			const answers: Record<string, unknown> = {};
			for (const [id, q] of Object.entries<any>(body.questions)) {
				const dq =
					q.type === "noul"
						? { type: "predicate", name: id, instructions: q.instructions }
						: q.type === "choice"
							? { type: "choice", name: id, instructions: q.instructions, choices: Object.keys(q.criteria).map(value => ({ value })) }
							: { type: "score", name: id, instructions: q.instructions, levels: q.criteria.map((label: string) => ({ label })) };
				const a = decisionAnswer(dq, text, false);
				if (a.type === "predicate") answers[id] = { type: "noul", noul: a.probability };
				else
					answers[id] = {
						type: a.type,
						...(a.type === "choice" ? { choice: a.choice } : { score: a.score }),
						probabilities: Object.fromEntries(a.probabilities.map((p: any) => [String(p.value), p.probability])),
						confidence: a.confidence,
					};
			}
			return j(200, { model: body.model, answers, usage: { input_tokens: tokens(body), output_tokens: 0 } });
		}
		return j(404, { message: "mock: unknown route" });
	};
	return { handler, recorded };
}

export function startMock(options: MockOptions = {}, port = 0) {
	const { handler, recorded } = createMockHandler(options);
	const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handler });
	return { url: `http://127.0.0.1:${server.port}`, recorded, stop: () => server.stop(true) };
}

if (import.meta.main) {
	const port = Number(process.env.MOCK_PORT ?? 8799);
	const m = startMock({ omitConfidence: process.env.MOCK_OMIT_CONFIDENCE === "1" }, port);
	console.log(`mock decision APIs on ${m.url} (zoom: /v2/aiservices/decisions/decide, openai: /v1/decisions, jev: /v1/systemone)`);
}
