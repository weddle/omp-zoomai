/**
 * Translation between omp's `openai-decisions` judgment dialect and Zoom AI Services Decisions.
 *
 * omp (v18.12.1) has no Zoom judgment wire, and its wire table is a closed const map
 * (packages/ai/src/judgment/native.ts: JUDGMENT_WIRES). Zoom's Decisions body is close to
 * OpenAI's (`input` + ordered typed `questions`, `predicate|choice|score`, `refusal` answers),
 * so omp's existing `openai-decisions` wire is reused and this module patches the gaps:
 *
 * | gap                          | OpenAI Decisions (omp wire)       | Zoom Decisions (public docs)                         |
 * | ---------------------------- | --------------------------------- | ---------------------------------------------------- |
 * | route                        | POST {base}/decisions             | POST https://api.zoom.us/v2/aiservices/decisions/decide |
 * | auth                         | Authorization: Bearer             | x-api-key (API ref) or Bearer API key/JWT (auth guide) |
 * | questions per request        | no cap documented                 | 1-10 (API ref)                                       |
 * | usage                        | usage.input_tokens                | usage.input_units (+ unit_type "tokens")             |
 * | image opt-in                 | none                              | enable_image_input: true required                    |
 * | choice/score `confidence`    | required by omp's decoder         | in guide examples, absent from API-ref schema        |
 * | default model id             | gpt-6-luna                        | `zoom-decisions` (ref) vs `zoom-decisions-standard` (guide) |
 *
 * Sources: https://developers.zoom.us/docs/api/ai-services/ (Evaluate decision questions),
 * https://developers.zoom.us/docs/ai-services/decisions/fast-mode/, https://developers.zoom.us/docs/ai-services/auth/
 * Pure functions only: no I/O, no credentials.
 */

/** Documented cap (API reference: "One to ten independent typed questions"). */
export const ZOOM_MAX_QUESTIONS = 10;

/** Path under the AI Services root. */
export const ZOOM_DECIDE_PATH = "/decisions/decide";
export const ZOOM_DEFAULT_BASE_URL = "https://api.zoom.us/v2/aiservices";

export type ChoiceValue = string | boolean;

export interface DecisionQuestion {
	type: "predicate" | "choice" | "score";
	name: string;
	instructions: string;
	choices?: { value: ChoiceValue; description?: string }[];
	levels?: { label: string; description?: string }[];
}

export interface InputTextPart {
	type: "input_text";
	text: string;
}
export interface InputImagePart {
	type: "input_image";
	image_url: string;
	detail?: "auto" | "low" | "high" | "original";
}
export interface UserMessage {
	role: "user";
	content: (InputTextPart | InputImagePart)[];
}

/** Body omp's `openai-decisions` wire sends (packages/ai/src/judgment/openai-decisions.ts `encode`). */
export interface OpenAIDecisionsRequest {
	model?: string;
	input: string | UserMessage[];
	questions: DecisionQuestion[];
}

export interface ZoomDecideRequest {
	input: string | UserMessage[];
	questions: DecisionQuestion[];
	model?: string;
	enable_image_input?: boolean;
	reference_id?: string;
}

export type DecisionAnswer =
	| { type: "predicate"; name: string; probability: number }
	| {
			type: "choice";
			name: string;
			choice: ChoiceValue;
			probabilities: { value: ChoiceValue; probability: number }[];
			confidence?: number;
	  }
	| {
			type: "score";
			name: string;
			score: number;
			probabilities: { value: number; label?: string; probability: number }[];
			confidence?: number;
	  }
	| { type: "refusal"; name: string };

export interface ZoomDecideResponse {
	answers: DecisionAnswer[];
	model?: string;
	request_id?: string;
	usage?: { input_units?: number; output_units?: number; unit_type?: string; details?: Record<string, unknown> };
}

/** Response in the shape omp's `openai-decisions` decoder accepts. */
export interface OpenAIDecisionsResponse {
	answers: DecisionAnswer[];
	model?: string;
	usage: { input_tokens: number; output_tokens: number };
	/** Extra, ignored by omp: provenance for logs. */
	zoom: { request_ids: string[]; chunks: number; confidence_synthesized: string[]; unit_type?: string };
}

/**
 * Model id to send. The API reference names the default `zoom-decisions`; the Decisions guide names it
 * `zoom-decisions-standard`. Both say omitting `model` selects the default, so the standard tier is sent
 * with no `model` field (works under either name). `zoom-decisions-pro` is consistent in both docs.
 */
export function wireModel(ompModelId: string | undefined): string | undefined {
	if (ompModelId === undefined) return undefined;
	const id = ompModelId.trim();
	if (id === "" || id === "zoom-decisions" || id === "zoom-decisions-standard") return undefined;
	return id;
}

export function hasImageInput(input: ZoomDecideRequest["input"]): boolean {
	return Array.isArray(input) && input.some(m => m.content.some(p => p.type === "input_image"));
}

/** Split into requests of at most `max` questions, preserving order. Questions are independent per both docs. */
export function toZoomRequests(
	request: OpenAIDecisionsRequest,
	options: { maxQuestions?: number; referenceId?: string } = {},
): ZoomDecideRequest[] {
	const max = options.maxQuestions ?? ZOOM_MAX_QUESTIONS;
	if (!Number.isInteger(max) || max < 1) throw new RangeError(`maxQuestions must be a positive integer, got ${max}`);
	if (!Array.isArray(request.questions) || request.questions.length === 0) {
		throw new TypeError("at least one question is required");
	}
	const model = wireModel(request.model);
	const images = hasImageInput(request.input);
	const out: ZoomDecideRequest[] = [];
	for (let i = 0; i < request.questions.length; i += max) {
		const body: ZoomDecideRequest = { input: request.input, questions: request.questions.slice(i, i + max) };
		if (model !== undefined) body.model = model;
		if (images) body.enable_image_input = true;
		if (options.referenceId) body.reference_id = `${options.referenceId}#${out.length}`;
		out.push(body);
	}
	return out;
}

/**
 * Fallback confidence when Zoom omits the field: the top probability. omp's decoder rejects choice/score
 * answers without a numeric `confidence`; Jev documents confidence as "concentration of the distribution",
 * which the max probability approximates but does not equal. Every synthesized value is reported.
 */
export function synthesizeConfidence(probabilities: { probability: number }[]): number {
	let max = 0;
	for (const p of probabilities) if (typeof p.probability === "number" && p.probability > max) max = p.probability;
	return Math.min(1, Math.max(0, max));
}

function finite(n: unknown): number {
	return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** Merge chunk responses (in chunk order) into one OpenAI-Decisions-shaped response. */
export function fromZoomResponses(responses: ZoomDecideResponse[]): OpenAIDecisionsResponse {
	const answers: DecisionAnswer[] = [];
	const synthesized: string[] = [];
	const requestIds: string[] = [];
	let input = 0;
	let model: string | undefined;
	let unitType: string | undefined;
	for (const r of responses) {
		if (!r || !Array.isArray(r.answers)) throw new TypeError("malformed Zoom Decisions response: no answers array");
		if (model === undefined && typeof r.model === "string") model = r.model;
		if (typeof r.request_id === "string") requestIds.push(r.request_id);
		input += finite(r.usage?.input_units);
		if (r.usage?.unit_type) unitType = r.usage.unit_type;
		for (const a of r.answers) {
			if ((a.type === "choice" || a.type === "score") && typeof a.confidence !== "number") {
				answers.push({ ...a, confidence: synthesizeConfidence(a.probabilities ?? []) });
				synthesized.push(a.name);
			} else {
				answers.push(a);
			}
		}
	}
	return {
		answers,
		model,
		// output_units is the question count, not tokens; Decisions billing is input-only.
		usage: { input_tokens: input, output_tokens: 0 },
		zoom: { request_ids: requestIds, chunks: responses.length, confidence_synthesized: synthesized, unit_type: unitType },
	};
}

/** Retry hint in seconds from a Zoom error: `Retry-After` header (429) or `metadata.retry_after_seconds` (503). */
export function retryAfterSeconds(status: number, headers: Headers, body: unknown): number | undefined {
	const h = headers.get("retry-after");
	if (h && /^\d+(\.\d+)?$/.test(h.trim())) return Number(h.trim());
	if (status === 503 && body && typeof body === "object") {
		const md = (body as { metadata?: { retry_after_seconds?: unknown } }).metadata;
		if (md && typeof md.retry_after_seconds === "number") return md.retry_after_seconds;
	}
	return undefined;
}
