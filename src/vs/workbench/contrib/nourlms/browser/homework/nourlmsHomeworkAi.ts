/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { IRequestService, asJson } from '../../../../../platform/request/common/request.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ApiError } from './nourlmsHomeworkApi.js';
import type { Course, Subject, DifficultyRate } from './types.js';

export const INourlmsHomeworkAiService = createDecorator<INourlmsHomeworkAiService>('nourlmsHomeworkAiService');

export interface AiQuestionDraft {
	content?: string;
	course_id?: number;
	question_subject_id?: number;
	suggested_subject_name?: string;
	difficulty_rate_id?: number;
	weight?: number;
	is_homework?: boolean;
	is_auto_correct?: boolean;
	time_in_second?: number;
	best_answer?: string;
	pre_answer?: string;
}

export interface GenerateQuestionContext {
	prompt: string;
	courses: Course[];
	subjects: Subject[];
	difficultyRates: DifficultyRate[];
}

export interface INourlmsHomeworkAiService {
	readonly _serviceBrand: undefined;
	generateQuestionDraft(ctx: GenerateQuestionContext, token: CancellationToken): Promise<AiQuestionDraft>;
}

// The default model name the gateway at https://ai.nourlms.com/v1 accepts.
// Per AI_API.md the canonical value is `openclaw/default` (the gateway also
// rejects `gpt-4o-mini` with HTTP 400). The gateway also requires the
// `x-openclaw-scopes` header — that's added server-side by `nourlmsAiProxy.ts`
// so the browser bundle never has to carry it.
//
// The server-side AI proxy can override this default by setting AI_API_MODEL
// in the server's `.env` (or a real env var), so a future model rename does
// not require a workbench rebuild — the client just sends the default as a
// hint and the server overwrites it before forwarding upstream.
const MODEL = 'openclaw/default';
const TEMPERATURE = 0.3;

export class NourlmsHomeworkAiService implements INourlmsHomeworkAiService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
	) { }

	async generateQuestionDraft(ctx: GenerateQuestionContext, token: CancellationToken): Promise<AiQuestionDraft> {
		const courseList = ctx.courses.map(c => `- id=${c.id} name="${c.name}"`).join('\n') || '(none available)';
		const subjectList = ctx.subjects.map(s => `- id=${s.id} name="${s.name}" course_id=${s.course_id}`).join('\n') || '(none available)';
		const difficultyList = ctx.difficultyRates.map(d => `- id=${d.id} name="${d.name}"`).join('\n') || '(none available)';

		const systemPrompt = `You are an assistant that drafts a single programming/code question for a learning management system. ` +
			`Reply with ONLY a JSON object matching this TypeScript shape (no prose, no markdown fences):

{
  "content": string,                       // The question prompt rendered as HTML. Use <p>, <code>, <pre>, <ul> if helpful.
  "course_id": number,                     // Pick the most relevant id from the available courses below.
  "question_subject_id": number | null,    // Pick the most relevant subject id whose course_id matches the chosen course. Null if no matching subject.
  "suggested_subject_name": string | null, // If question_subject_id is null, suggest a NEW subject name to create.
  "difficulty_rate_id": number,            // Pick from the available difficulty rates.
  "weight": number,                        // 1-100 integer score.
  "is_auto_correct": boolean,              // True if AI auto-grading is appropriate.
  "time_in_second": number,                // Suggested time limit, integer seconds.
  "best_answer": string,                   // Reference solution as plain text/code.
  "pre_answer": string                     // Starter code for the student, plain text/code (may be empty).
}

Available courses:
${courseList}

Available subjects (each is scoped to a course_id):
${subjectList}

Available difficulty rates:
${difficultyList}`;

		const requestBody = {
			model: MODEL,
			temperature: TEMPERATURE,
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: ctx.prompt },
			],
		};

		try {
			const context = await this.requestService.request({
				type: 'POST',
				// MUST match the upstream OpenAI-compatible path exactly: `/chat/completions`
				// (the server-side AI proxy strips the `/nourlms-ai` prefix and forwards
				// the rest verbatim, so this becomes `${AI_API_BASE_URL}/chat/completions`).
				url: '/nourlms-ai/chat/completions',
				data: JSON.stringify(requestBody),
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json',
				},
			}, token);

			if (context.res.statusCode === 503) {
				throw new ApiError({
					status: 503,
					message: localize('nourlms.homework.ai.notConfigured', "The AI service is not configured on this server. Set AI_API_KEY in the server .env file."),
				});
			}

			if (context.res.statusCode && context.res.statusCode >= 400) {
				let body: unknown;
				try { body = await asJson<unknown>(context); } catch { /* ignore */ }

				// Walk the most common error envelopes (OpenAI-compatible, plain
				// {error: "..."}, Laravel {message: "..."}, our own {error: "..."}
				// from the proxy itself) and fall back to a stringified body so the
				// admin can actually see what the upstream rejected — the previous
				// behaviour silently swallowed the message and showed only "(400)".
				let message: string | undefined;
				if (body && typeof body === 'object') {
					const b = body as { error?: unknown; message?: unknown };
					const errVal = b.error;
					if (errVal && typeof errVal === 'object') {
						const errMsg = (errVal as { message?: unknown }).message;
						if (typeof errMsg === 'string') { message = errMsg; }
					} else if (typeof errVal === 'string') {
						message = errVal;
					}
					if (!message && typeof b.message === 'string') {
						message = b.message;
					}
				}
				if (!message) {
					if (typeof body === 'string' && body.length > 0) {
						message = body;
					} else if (body !== undefined) {
						message = JSON.stringify(body);
					} else {
						message = localize('nourlms.homework.ai.error', "AI request failed.");
					}
				}
				this.logService.warn(`[nourlmsHomeworkAi] upstream ${context.res.statusCode}: ${message}`);
				throw new ApiError({
					status: context.res.statusCode,
					message,
					raw: body,
				});
			}

			const completion = await asJson<any>(context);
			const text: string | undefined = completion?.choices?.[0]?.message?.content;
			if (!text) {
				throw new ApiError({
					status: 502,
					message: localize('nourlms.homework.ai.emptyResponse', "AI service returned an empty response."),
				});
			}

			let parsed: AiQuestionDraft;
			try {
				parsed = JSON.parse(text);
			} catch (err) {
				this.logService.warn('[nourlmsHomeworkAi] Failed to parse AI JSON response', err);
				throw new ApiError({
					status: 502,
					message: localize('nourlms.homework.ai.parseError', "AI service returned an invalid response."),
				});
			}

			return parsed;
		} catch (err) {
			if (err instanceof ApiError) { throw err; }
			throw new ApiError({
				status: 502,
				message: localize('nourlms.homework.ai.unreachable', "Could not reach the AI service. Try again."),
				raw: err,
			});
		}
	}
}
