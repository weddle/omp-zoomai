/** Canonical judge shapes: TypeSafe System One (Jev) questions in, one normalized answer map out. */
export type Question =
	| { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string | null> }
	| { type: "score"; instructions: string; criteria: string[] };
export type Questions = Record<string, Question>;
export type State = string | Record<string, unknown> | unknown[];

export type Answer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; probabilities: Record<string, number>; confidence: number }
	| { type: "refusal" };

export interface JudgeResult {
	backend: BackendId;
	model: string;
	answers: Record<string, Answer>;
	usage: { input_tokens: number };
	cost_usd: number;
	latency_ms: number;
	request_ids: string[];
	/** Question ids whose confidence was synthesized from the distribution (Zoom only). */
	confidence_synthesized: string[];
}

export type BackendId = "jev" | "openai-decisions" | "zoom-decisions" | "zoom-decisions-pro";
