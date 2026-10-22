#!/usr/bin/env bun
/**
 * judge: one typed-judgment request against jev | openai-decisions | zoom-decisions | zoom-decisions-pro,
 * normalized to one output shape.
 *
 *   bun bin/judge.ts --backend zoom-decisions --state-file s.json --questions-file q.json [--base-url URL] [--model ID]
 *   bun bin/judge.ts --backend jev --state '"text"' --questions '{"q":{"type":"noul","instructions":"..."}}'
 *   bun bin/judge.ts --dry-run ...   prints the exact wire body/bodies, makes no request
 *
 * Non-loopback endpoints need JUDGE_LIVE_OK=1 (approval) and the backend's key env var.
 * Exit codes: 0 ok, 1 error, 2 any refusal, 3 live call blocked.
 */
import { BACKENDS, judge, LiveCallBlocked } from "../src/judge/backends";
import { encodeInput, encodeQuestions } from "../src/judge/decisions-codec";
import type { BackendId, Questions, State } from "../src/judge/types";
import { toZoomRequests } from "../extension/zoom-ai/zoom-wire";

const args = process.argv.slice(2);
const opt = (name: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);

async function readJson(inline?: string, file?: string): Promise<unknown> {
	if (file) return JSON.parse(await Bun.file(file).text());
	if (inline !== undefined) return JSON.parse(inline);
	return undefined;
}

const backend = (opt("backend") ?? "zoom-decisions") as BackendId;
if (!BACKENDS[backend]) {
	console.error(`unknown --backend; one of ${Object.keys(BACKENDS).join(", ")}`);
	process.exit(1);
}
const state = (await readJson(opt("state"), opt("state-file"))) as State | undefined;
const questions = (await readJson(opt("questions"), opt("questions-file"))) as Questions | undefined;
if (state === undefined || !questions) {
	console.error("need --state/--state-file and --questions/--questions-file");
	process.exit(1);
}
const model = opt("model") ?? BACKENDS[backend].model;

if (flag("dry-run")) {
	let wire: unknown;
	if (backend === "jev") wire = { model, state, questions };
	else if (backend === "openai-decisions") wire = { model, input: encodeInput(state), questions: encodeQuestions(questions) };
	else wire = toZoomRequests({ model, input: encodeInput(state), questions: encodeQuestions(questions) }, { maxQuestions: 10 });
	console.log(JSON.stringify({ backend, dry_run: true, wire }, null, 2));
	process.exit(0);
}

try {
	const r = await judge(backend, state, questions, { baseUrl: opt("base-url"), model });
	console.log(JSON.stringify(r, null, 2));
	process.exit(Object.values(r.answers).some(a => a.type === "refusal") ? 2 : 0);
} catch (e) {
	console.error(`judge: ${(e as Error).message}`);
	process.exit(e instanceof LiveCallBlocked ? 3 : 1);
}
