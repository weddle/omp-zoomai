/**
 * System One <-> Decisions (OpenAI and Zoom share this body) codec. Mirrors omp v18.12.1
 * packages/ai/src/judgment/openai-decisions.ts so CLI and in-omp judgments ask identical questions.
 */
import type { DecisionAnswer, DecisionQuestion } from "../../extension/zoom-ai/zoom-wire";
import type { Answer, Question, Questions, State } from "./types";

export function predicateInstructions(instructions: string, criteria?: { true?: string; false?: string }): string {
	let s = instructions;
	if (criteria?.true) s += `\n\nTrue means: ${criteria.true}`;
	if (criteria?.false) s += `\n\nFalse means: ${criteria.false}`;
	return s;
}

export function encodeQuestion(name: string, q: Question): DecisionQuestion {
	switch (q.type) {
		case "noul":
			return { type: "predicate", name, instructions: predicateInstructions(q.instructions, q.criteria) };
		case "choice":
			return {
				type: "choice",
				name,
				instructions: q.instructions,
				choices: Object.entries(q.criteria).map(([value, d]) => (d === null ? { value } : { value, description: d })),
			};
		case "score":
			return { type: "score", name, instructions: q.instructions, levels: q.criteria.map(label => ({ label })) };
	}
}

export function encodeInput(state: State): string {
	return typeof state === "string" ? state : JSON.stringify(state);
}

export function encodeQuestions(questions: Questions): DecisionQuestion[] {
	return Object.entries(questions).map(([n, q]) => encodeQuestion(n, q));
}

export function decodeAnswer(a: DecisionAnswer): Answer {
	switch (a.type) {
		case "predicate":
			return { type: "noul", noul: a.probability };
		case "choice":
			return {
				type: "choice",
				choice: String(a.choice),
				probabilities: Object.fromEntries(a.probabilities.map(p => [String(p.value), p.probability])),
				confidence: a.confidence ?? Math.max(...a.probabilities.map(p => p.probability)),
			};
		case "score":
			return {
				type: "score",
				score: a.score,
				probabilities: Object.fromEntries(a.probabilities.map(p => [String(p.value), p.probability])),
				confidence: a.confidence ?? Math.max(...a.probabilities.map(p => p.probability)),
			};
		case "refusal":
			return { type: "refusal" };
	}
}
