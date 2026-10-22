/**
 * One typed-judgment call, three vendors, one output shape.
 * Live-call guard: any non-loopback endpoint requires JUDGE_LIVE_OK=1 (explicit opt-in), so tests and
 * dry runs can never spend. Keys come from env only and are never printed or logged.
 */
import {
	fromZoomResponses,
	toZoomRequests,
	ZOOM_DECIDE_PATH,
	ZOOM_DEFAULT_BASE_URL,
	type DecisionAnswer,
	type ZoomDecideResponse,
} from "../../extension/zoom-ai/zoom-wire";
import { decodeAnswer, encodeInput, encodeQuestions } from "./decisions-codec";
import type { Answer, BackendId, JudgeResult, Questions, State } from "./types";

export const BACKENDS: Record<
	BackendId,
	{ base: string; model: string; keyEnv: string; usdPerMTokIn: number; maxQuestions?: number }
> = {
	jev: { base: "https://api.typesafe.ai", model: "jev-1.13.0", keyEnv: "TYPESAFE_API_KEY", usdPerMTokIn: 0.042 },
	"openai-decisions": {
		base: "https://api.openai.com",
		model: "gpt-6-luna",
		keyEnv: "OPENAI_API_KEY",
		usdPerMTokIn: 0.1,
		maxQuestions: 200,
	},
	"zoom-decisions": {
		base: ZOOM_DEFAULT_BASE_URL,
		model: "zoom-decisions",
		keyEnv: "ZOOM_AI_API_KEY",
		usdPerMTokIn: 0.042,
		maxQuestions: 10,
	},
	"zoom-decisions-pro": {
		base: ZOOM_DEFAULT_BASE_URL,
		model: "zoom-decisions-pro",
		keyEnv: "ZOOM_AI_API_KEY",
		usdPerMTokIn: 0.1,
		maxQuestions: 10,
	},
};

export class LiveCallBlocked extends Error {
	override name = "LiveCallBlocked";
}
export class JudgeHttpError extends Error {
	override name = "JudgeHttpError";
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const SECRET_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bsk-[A-Za-z0-9_-]{20,}/,
	/\bghp_[A-Za-z0-9]{30,}/,
	/\bgithub_pat_[A-Za-z0-9_]{30,}/,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bAIza[0-9A-Za-z_-]{35}\b/,
	/\b(api[_-]?key|secret|password|passwd|bearer)\b\s*[:=]\s*\S{12,}/i,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

export function assertNoSecrets(state: State): void {
	const s = typeof state === "string" ? state : JSON.stringify(state);
	for (const re of SECRET_PATTERNS) if (re.test(s)) throw new Error("state looks like it contains a credential; refusing");
}

export function isLoopback(url: string): boolean {
	const h = new URL(url).hostname;
	return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

export interface JudgeCallOptions {
	baseUrl?: string;
	model?: string;
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
}

async function post(doFetch: typeof fetch, url: string, headers: Record<string, string>, body: unknown) {
	const res = await doFetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json", ...headers },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await res.text();
	if (!res.ok) throw new JudgeHttpError(res.status, `HTTP ${res.status}: ${text.slice(0, 300)}`);
	return JSON.parse(text);
}

function decisionsAnswers(list: DecisionAnswer[]): Record<string, Answer> {
	return Object.fromEntries(list.map(a => [a.name, decodeAnswer(a)]));
}

export async function judge(
	backend: BackendId,
	state: State,
	questions: Questions,
	options: JudgeCallOptions = {},
): Promise<JudgeResult> {
	const spec = BACKENDS[backend];
	if (!spec) throw new Error(`unknown backend ${backend}`);
	const env = options.env ?? process.env;
	const base = (options.baseUrl ?? spec.base).replace(/\/+$/, "");
	if (!isLoopback(base) && env.JUDGE_LIVE_OK !== "1") {
		throw new LiveCallBlocked(`${backend}: live call to ${new URL(base).host} blocked (needs JUDGE_LIVE_OK=1 after approval)`);
	}
	assertNoSecrets(state);
	const key = env[spec.keyEnv];
	if (!key) throw new Error(`${backend}: ${spec.keyEnv} is not set`);
	const model = options.model ?? spec.model;
	const doFetch = options.fetch ?? fetch;
	const t0 = performance.now();
	let answers: Record<string, Answer>;
	let inputTokens = 0;
	let respModel = model;
	let requestIds: string[] = [];
	let synthesized: string[] = [];

	if (backend === "jev") {
		const r = await post(doFetch, `${base}/v1/systemone`, { authorization: `Bearer ${key}` }, { model, state, questions });
		answers = r.answers;
		inputTokens = r.usage?.input_tokens ?? 0;
		respModel = r.model ?? model;
	} else if (backend === "openai-decisions") {
		const r = await post(
			doFetch,
			`${base}/v1/decisions`,
			{ authorization: `Bearer ${key}` },
			{ model, input: encodeInput(state), questions: encodeQuestions(questions) },
		);
		answers = decisionsAnswers(r.answers);
		inputTokens = r.usage?.input_tokens ?? 0;
		respModel = r.model ?? model;
	} else {
		const chunks = toZoomRequests(
			{ model, input: encodeInput(state), questions: encodeQuestions(questions) },
			{ maxQuestions: spec.maxQuestions },
		);
		const auth = env.ZOOM_AI_AUTH === "bearer" ? { authorization: `Bearer ${key}` } : { "x-api-key": key };
		const responses: ZoomDecideResponse[] = [];
		for (const c of chunks) responses.push(await post(doFetch, `${base}${ZOOM_DECIDE_PATH}`, auth, c));
		const merged = fromZoomResponses(responses);
		answers = decisionsAnswers(merged.answers);
		inputTokens = merged.usage.input_tokens;
		respModel = merged.model ?? model;
		requestIds = merged.zoom.request_ids;
		synthesized = merged.zoom.confidence_synthesized;
	}
	for (const id of Object.keys(questions)) {
		if (!answers[id]) throw new Error(`${backend}: no answer for question "${id}"`);
	}
	return {
		backend,
		model: respModel,
		answers,
		usage: { input_tokens: inputTokens },
		cost_usd: (inputTokens * spec.usdPerMTokIn) / 1e6,
		latency_ms: Math.round(performance.now() - t0),
		request_ids: requestIds,
		confidence_synthesized: synthesized,
	};
}

/** Same gates as the team eval (noul 0.85/0.15; choice min confidence). Thresholds are per model: re-tune. */
export function gate(answer: Answer, opts: { yes?: number; no?: number; minConfidence?: number } = {}): string {
	if (answer.type === "refusal") return "abstain";
	if (answer.type === "noul") {
		if (answer.noul >= (opts.yes ?? 0.85)) return "yes";
		if (answer.noul <= (opts.no ?? 0.15)) return "no";
		return "abstain";
	}
	if (answer.type === "choice") return answer.confidence >= (opts.minConfidence ?? 0.55) ? answer.choice : "abstain";
	return answer.confidence >= (opts.minConfidence ?? 0.55) ? String(Math.round(answer.score)) : "abstain";
}
