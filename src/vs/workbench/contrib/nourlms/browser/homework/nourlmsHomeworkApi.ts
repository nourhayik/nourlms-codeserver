/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { asJson } from '../../../../../platform/request/common/request.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { INourlmsAuthService } from '../../../../services/nourlms/common/nourlms.js';
import type { ApiErrorShape, AiGradingResult, Course, DifficultyRate, Homework, HomeworkSubmission, Paginated, Question, QuestionTypeLookup, Subject } from './types.js';

export const INourlmsHomeworkApi = createDecorator<INourlmsHomeworkApi>('nourlmsHomeworkApi');

export interface INourlmsHomeworkApi {
	readonly _serviceBrand: undefined;
	listStudentHomeworks(filters: StudentHomeworkListFilters, token: CancellationToken): Promise<Paginated<Homework>>;
	getStudentHomework(id: number, token: CancellationToken): Promise<Homework>;
	listStudentHomeworkCourses(token: CancellationToken): Promise<Course[]>;
	submitAnswer(homeworkId: number, payload: SubmitAnswerPayload, token: CancellationToken): Promise<{ submission_id: number; message: string }>;
	listStudentSubmissions(homeworkId: number, filters: SubmissionListFilters, token: CancellationToken): Promise<Paginated<HomeworkSubmission>>;
	getStudentSubmission(homeworkId: number, submissionId: number, token: CancellationToken): Promise<HomeworkSubmission>;
	listQuestions(filters: QuestionListFilters, token: CancellationToken): Promise<Paginated<Question>>;
	listCourses(filters: { search?: string; university_id?: number }, token: CancellationToken): Promise<Course[]>;
	listSubjects(filters: { search?: string; course_id?: number }, token: CancellationToken): Promise<Subject[]>;
	listDifficultyRates(token: CancellationToken): Promise<DifficultyRate[]>;
	listQuestionTypes(token: CancellationToken): Promise<QuestionTypeLookup[]>;
	assignHomework(payload: AssignHomeworkPayload, token: CancellationToken): Promise<{ created_count: number; items: Homework[] }>;
	getQuestion(id: number, token: CancellationToken): Promise<Question>;
	createCodeQuestion(payload: CreateCodeQuestionPayload, token: CancellationToken): Promise<Question>;
	getAiGradingResult(resultId: number, token: CancellationToken): Promise<AiGradingResult>;
	getLatestAiResult(homeworkId: number, submissionId: number, token: CancellationToken): Promise<AiGradingResult>;
	pollAiResultStatus(homeworkId: number, submissionId: number, token: CancellationToken): Promise<AiResultStatus>;
	listAdminHomeworks(filters: AdminHomeworkListFilters, token: CancellationToken): Promise<Paginated<Homework>>;
	listAdminSubmissions(homeworkId: number, filters: SubmissionListFilters, token: CancellationToken): Promise<Paginated<HomeworkSubmission>>;
	getAdminSubmission(homeworkId: number, submissionId: number, token: CancellationToken): Promise<HomeworkSubmission>;
	correctSubmission(homeworkId: number, submissionId: number, payload: CorrectionPayload, token: CancellationToken): Promise<Homework>;
	triggerAiGrade(homeworkId: number, payload: AiGradePayload, token: CancellationToken): Promise<{ mode: 'queued'; message: string } | { mode: 'sync'; result: AiGradingResult }>;
	triggerRegrade(homeworkId: number, payload: RegradePayload, token: CancellationToken): Promise<{ message: string; grading_result_id: number }>;
	listAdminStudentCourses(studentId: number, token: CancellationToken): Promise<Course[]>;
	createSubject(payload: CreateSubjectPayload, token: CancellationToken): Promise<Subject>;
	getAdminHomework(id: number, token: CancellationToken): Promise<Homework>;
}

export interface CreateSubjectPayload {
	name: string;
	course_id: number;
}

export interface QuestionListFilters {
	search?: string;
	course_id?: number;
	subject_id?: number;
	difficulty_id?: number;
	type_id?: number;
	per_page?: number;
	page?: number;
}

export interface AssignHomeworkPayload {
	user_ids: number[];
	question_ids: number[];
}

export interface StudentHomeworkListFilters {
	course_id?: number;
	subject_id?: number;
	status?: 'pending' | 'corrected';
	is_ai_graded?: boolean;
	date_from?: string;
	date_to?: string;
	per_page?: number;
	page?: number;
}

export interface SubmissionListFilters {
	is_corrected?: boolean;
	has_ai_result?: boolean;
	date_from?: string;
	date_to?: string;
	per_page?: number;
	page?: number;
}

export interface AdminHomeworkListFilters {
	student_id?: number;
	course_id?: number;
	subject_id?: number;
	question_type_id?: number;
	status?: 'pending' | 'corrected';
	is_ai_graded?: boolean;
	date_from?: string;
	date_to?: string;
	search?: string;
	per_page?: number;
	page?: number;
}

export interface CorrectionPayload {
	mark?: number;
	correct_the_answer?: string;
	is_corrected?: boolean;
}

export interface AiGradePayload {
	submission_id: number;
	mode?: 'sync' | 'queued';
}

export interface RegradePayload {
	submission_id: number;
}

export interface SubmitAnswerPayload {
	content: string;
}

export interface CreateCodeQuestionPayload {
	content: string;
	course_id: number;
	question_subject_id: number;
	difficulty_rate_id: number;
	weight: number;
	is_homework: boolean;
	is_auto_correct: boolean;
	time_in_second: number;
	best_answer?: string;
	pre_answer?: string;
	question_type_id: number;
}

export class ApiError extends Error {
	readonly status: number;
	readonly fieldErrors?: Record<string, string[]>;
	readonly raw?: unknown;

	constructor(shape: ApiErrorShape) {
		const msg = shape.message ?? ApiError.defaultMessage(shape.status);
		super(msg);
		this.name = 'ApiError';
		this.status = shape.status;
		this.fieldErrors = shape.fieldErrors;
		this.raw = shape.raw;
	}

	private static defaultMessage(status: number): string {
		switch (status) {
			case 401: return localize('nourlms.homework.errors.sessionExpired', "Your session has expired. Sign in again.");
			case 429: return localize('nourlms.homework.errors.tooManyRequests', "Too many requests, retrying\u2026");
			case 502: return localize('nourlms.homework.errors.unreachable', "The LMS is unreachable. Please retry.");
			default: return localize('nourlms.homework.errors.generic', "An error occurred.");
		}
	}

	override toString(): string {
		return `${this.message} (${this.status})`;
	}
}

export interface AiResultStatus {
	state: 'pending' | 'ready';
	result_id?: number;
	graded_at?: string;
}

export class NourlmsHomeworkApi implements INourlmsHomeworkApi {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@INourlmsAuthService private readonly authService: INourlmsAuthService,
		@ILogService _logService: ILogService,
	) {
		void _logService;
	}

	protected async request<T>(method: string, path: string, opts: { data?: unknown } | undefined, token: CancellationToken): Promise<T> {
		const startMark = `nourlms.homework.api.${method}.${path}.start`;
		const endMark = `nourlms.homework.api.${method}.${path}.end`;
		performance.mark(startMark);

		try {
			const requestInit: Parameters<IRequestService['request']>[0] = {
				type: method,
				url: `/nourlms-api${path}`,
			};
			if (opts?.data !== undefined) {
				requestInit.data = JSON.stringify(opts.data);
				requestInit.headers = {
					'Content-Type': 'application/json',
					'Accept': 'application/json',
				};
			} else {
				requestInit.headers = {
					'Accept': 'application/json',
				};
			}

			const context = await this.requestService.request(requestInit, token);
			performance.mark(endMark);
			performance.measure(`nourlms.homework.api.${method}.${path}`, startMark, endMark);

			if (context.res.statusCode === 401) {
				await this.authService.logout();
				throw new ApiError({ status: 401, message: localize('nourlms.homework.errors.sessionExpired', "Your session has expired. Sign in again.") });
			}

			if (context.res.statusCode && context.res.statusCode >= 400) {
				let body: any;
				try {
					body = await asJson<any>(context);
				} catch { /* ignore parse failure */ }

				let message: string | undefined;
				let fieldErrors: Record<string, string[]> | undefined;
				if (body) {
					if (typeof body.message === 'string') {
						message = body.message;
					}
					if (body.errors && typeof body.errors === 'object') {
						fieldErrors = body.errors;
						if (!message) {
							const firstKey = Object.keys(body.errors)[0];
							if (firstKey && Array.isArray(body.errors[firstKey]) && body.errors[firstKey].length > 0) {
								message = body.errors[firstKey][0];
							}
						}
					}
					if (body.error && typeof body.error === 'string' && !message) {
						message = body.error;
					}
				}

				throw new ApiError({ status: context.res.statusCode, message, fieldErrors, raw: body });
			}

			const parsed = await asJson<T>(context);
			if (parsed === null) {
				throw new ApiError({ status: context.res.statusCode ?? 502, message: localize('nourlms.homework.errors.emptyBody', "The LMS returned an empty response.") });
			}
			return parsed;
		} catch (err) {
			performance.mark(endMark);
			performance.measure(`nourlms.homework.api.${method}.${path}`, startMark, endMark);
			if (err instanceof ApiError) {
				throw err;
			}
			throw new ApiError({ status: 502, message: localize('nourlms.homework.errors.unreachable', "The LMS is unreachable. Please retry."), raw: err });
		}
	}

	/**
	 * Defensively coerces a raw JSON list response into `T[]`. Handles all of:
	 *  - raw array: `[...]`
	 *  - Laravel API Resource collection: `{ data: [...] }`
	 *  - nested envelope: `{ data: { data: [...] } }` (some `->resource()` chains)
	 *  - error: returns `[]` instead of throwing on non-array shapes.
	 *
	 * Without this, a single API endpoint that returns `{data:[...]}` instead of
	 * `[...]` causes `.map`/`.filter`/`for-of` calls in the UI to throw and the
	 * whole screen to disappear — the dropdown lookup endpoints (courses,
	 * subjects, difficulty rates, question types) routinely come back wrapped
	 * from Laravel `ApiResource::collection`.
	 */
	private async listJson<T>(method: string, path: string, opts: { data?: unknown } | undefined, token: CancellationToken): Promise<T[]> {
		const result = await this.request<unknown>(method, path, opts, token);
		return NourlmsHomeworkApi.unwrapArray<T>(result);
	}

	/**
	 * Same idea but for a single-object response. Handles:
	 *  - raw object: `{...}`
	 *  - Laravel API Resource: `{ data: {...} }`
	 *  - nested envelope: `{ data: { data: {...} } }` (rare)
	 */
	private async objectJson<T>(method: string, path: string, opts: { data?: unknown } | undefined, token: CancellationToken): Promise<T> {
		const result = await this.request<unknown>(method, path, opts, token);
		return NourlmsHomeworkApi.unwrapObject<T>(result);
	}

	/**
	 * Same idea for paginators. Handles:
	 *  - native Laravel paginator: `{ data: [...], current_page: ..., last_page: ..., per_page: ..., total: ... }`
	 *  - resource-wrapped paginator: `{ data: { data: [...], current_page: ..., ... } }`
	 *  - and falls back to a single-page synthetic envelope when the API returns
	 *    a raw array.
	 */
	private async paginatedJson<T>(method: string, path: string, opts: { data?: unknown } | undefined, token: CancellationToken): Promise<Paginated<T>> {
		const result = await this.request<unknown>(method, path, opts, token);
		return NourlmsHomeworkApi.unwrapPaginated<T>(result);
	}

	private static unwrapArray<T>(value: unknown): T[] {
		if (Array.isArray(value)) {
			return value as T[];
		}
		if (value && typeof value === 'object') {
			const v = value as { data?: unknown };
			if (Array.isArray(v.data)) {
				return v.data as T[];
			}
			if (v.data && typeof v.data === 'object' && Array.isArray((v.data as { data?: unknown }).data)) {
				return (v.data as { data: unknown[] }).data as T[];
			}
		}
		return [];
	}

	private static unwrapObject<T>(value: unknown): T {
		if (value && typeof value === 'object') {
			const v = value as { data?: unknown };
			if (v.data && typeof v.data === 'object' && !Array.isArray(v.data)) {
				const inner = v.data as { data?: unknown };
				if (inner.data && typeof inner.data === 'object' && !Array.isArray(inner.data)) {
					return inner.data as T;
				}
				return v.data as T;
			}
		}
		return value as T;
	}

	/**
	 * Defensively pulls the student's submitted answer out of a submission row.
	 * The upstream `GET /admin/homeworks/:id/submissions/:sid` endpoint has
	 * been observed to use any of these field names — we accept all of them
	 * and fall back through the list in order.
	 *
	 * Also recursively walks one level of nested objects (e.g. `submission`,
	 * `homework_submission`, `latest_submission`) because some Laravel API
	 * resources nest the row inside a wrapper key.
	 *
	 * The previous code assumed `content` only, which is why opening a
	 * submission as admin showed "(empty submission)" even when the student
	 * had clearly answered.
	 *
	 * The normalized object also carries a non-typed `__raw` reference to the
	 * original parsed JSON so the screen can dump it to DevTools for
	 * diagnostics if the answer is STILL missing after normalization.
	 */
	static normalizeSubmission(raw: unknown): HomeworkSubmission & { readonly __raw?: unknown } {
		const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};

		// `answer_content` is what the upstream NourLMS REST API actually uses
		// for `/admin/homeworks/:id/submissions/:sid` — kept first because that
		// is the production endpoint the workbench hits most. The remaining
		// names are observed-in-the-wild fallbacks for older / divergent
		// resource shapes.
		const ANSWER_KEYS = [
			'answer_content', 'content', 'answer', 'submitted_answer',
			'submission_content', 'body', 'text', 'submitted_text',
			'student_answer', 'student_response', 'solution', 'code',
			'submission', 'response',
		];
		const SUBMITTED_AT_KEYS = ['submitted_at', 'submittedAt', 'created_at', 'createdAt', 'timestamp'];
		const ID_KEYS = ['id', 'submission_id', 'submissionId'];
		const HW_KEYS = ['homework_id', 'homeworkId'];

		const pickStringIn = (obj: Record<string, unknown>, keys: string[]): string => {
			for (const k of keys) {
				const v = obj[k];
				if (typeof v === 'string' && v.length > 0) { return v; }
				if (typeof v === 'number') { return String(v); }
			}
			return '';
		};
		const pickNumberIn = (obj: Record<string, unknown>, keys: string[]): number => {
			for (const k of keys) {
				const v = obj[k];
				if (typeof v === 'number') { return v; }
				if (typeof v === 'string' && v.length > 0 && !isNaN(Number(v))) { return Number(v); }
			}
			return 0;
		};

		// Try the row itself first. If the answer still isn't there, peek into
		// common wrapper keys (some upstreams nest the row inside `submission`,
		// `homework_submission`, etc.).
		let content = pickStringIn(r, ANSWER_KEYS);
		let nested: Record<string, unknown> | undefined;
		if (!content) {
			for (const wrapKey of ['submission', 'homework_submission', 'latest_submission', 'last_submission']) {
				const candidate = r[wrapKey];
				if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
					nested = candidate as Record<string, unknown>;
					content = pickStringIn(nested, ANSWER_KEYS);
					if (content) { break; }
				}
			}
		}

		const pickAiId = (): number | null => {
			const sources: Record<string, unknown>[] = [r];
			if (nested) { sources.push(nested); }
			for (const src of sources) {
				for (const k of ['latest_ai_result_id', 'ai_result_id', 'last_ai_result_id', 'grading_result_id']) {
					const v = src[k];
					if (typeof v === 'number') { return v; }
					if (typeof v === 'string' && v.length > 0 && !isNaN(Number(v))) { return Number(v); }
				}
				const eager = src['latest_ai_result'] ?? src['ai_result'] ?? src['grading_result'];
				if (eager && typeof eager === 'object') {
					const id = (eager as { id?: unknown }).id;
					if (typeof id === 'number') { return id; }
				}
			}
			return null;
		};

		const submittedAt = pickStringIn(r, SUBMITTED_AT_KEYS) || (nested ? pickStringIn(nested, SUBMITTED_AT_KEYS) : '');

		return {
			id: pickNumberIn(r, ID_KEYS) || (nested ? pickNumberIn(nested, ID_KEYS) : 0),
			homework_id: pickNumberIn(r, HW_KEYS) || (nested ? pickNumberIn(nested, HW_KEYS) : 0),
			content,
			submitted_at: submittedAt,
			is_corrected: r['is_corrected'] === true || r['isCorrected'] === true ||
				(nested ? (nested['is_corrected'] === true || nested['isCorrected'] === true) : false),
			latest_ai_result_id: pickAiId(),
			__raw: raw,
		};
	}

	private async submissionJson(method: string, path: string, opts: { data?: unknown } | undefined, token: CancellationToken): Promise<HomeworkSubmission> {
		const result = await this.request<unknown>(method, path, opts, token);
		const unwrapped = NourlmsHomeworkApi.unwrapObject<unknown>(result);
		return NourlmsHomeworkApi.normalizeSubmission(unwrapped);
	}

	private async submissionListJson(method: string, path: string, opts: { data?: unknown } | undefined, token: CancellationToken): Promise<Paginated<HomeworkSubmission>> {
		const result = await this.request<unknown>(method, path, opts, token);
		const page = NourlmsHomeworkApi.unwrapPaginated<unknown>(result);
		return {
			data: page.data.map(item => NourlmsHomeworkApi.normalizeSubmission(item)),
			current_page: page.current_page,
			last_page: page.last_page,
			per_page: page.per_page,
			total: page.total,
		};
	}

	private static unwrapPaginated<T>(value: unknown): Paginated<T> {
		const empty: Paginated<T> = { data: [], current_page: 1, last_page: 1, per_page: 0, total: 0 };
		if (!value || typeof value !== 'object') {
			if (Array.isArray(value)) {
				return { data: value as T[], current_page: 1, last_page: 1, per_page: (value as unknown[]).length, total: (value as unknown[]).length };
			}
			return empty;
		}
		const v = value as { data?: unknown; current_page?: number; last_page?: number; per_page?: number; total?: number };
		if (Array.isArray(v.data)) {
			return {
				data: v.data as T[],
				current_page: typeof v.current_page === 'number' ? v.current_page : 1,
				last_page: typeof v.last_page === 'number' ? v.last_page : 1,
				per_page: typeof v.per_page === 'number' ? v.per_page : v.data.length,
				total: typeof v.total === 'number' ? v.total : v.data.length,
			};
		}
		// Resource-wrapped paginator: { data: { data: [...], current_page: ..., ... } }
		if (v.data && typeof v.data === 'object') {
			const inner = v.data as { data?: unknown; current_page?: number; last_page?: number; per_page?: number; total?: number };
			if (Array.isArray(inner.data)) {
				return {
					data: inner.data as T[],
					current_page: typeof inner.current_page === 'number' ? inner.current_page : 1,
					last_page: typeof inner.last_page === 'number' ? inner.last_page : 1,
					per_page: typeof inner.per_page === 'number' ? inner.per_page : inner.data.length,
					total: typeof inner.total === 'number' ? inner.total : inner.data.length,
				};
			}
		}
		return empty;
	}

	async listStudentHomeworks(filters: StudentHomeworkListFilters, token: CancellationToken): Promise<Paginated<Homework>> {
		const params = new URLSearchParams();
		if (filters.course_id !== undefined) { params.set('course_id', String(filters.course_id)); }
		if (filters.subject_id !== undefined) { params.set('subject_id', String(filters.subject_id)); }
		if (filters.status !== undefined) { params.set('status', filters.status); }
		if (filters.is_ai_graded !== undefined) { params.set('is_ai_graded', String(filters.is_ai_graded)); }
		if (filters.date_from !== undefined) { params.set('date_from', filters.date_from); }
		if (filters.date_to !== undefined) { params.set('date_to', filters.date_to); }
		if (filters.per_page !== undefined) { params.set('per_page', String(filters.per_page)); }
		if (filters.page !== undefined) { params.set('page', String(filters.page)); }
		const qs = params.toString();
		return this.paginatedJson<Homework>('GET', `/student/homeworks${qs ? '?' + qs : ''}`, undefined, token);
	}

	async getStudentHomework(id: number, token: CancellationToken): Promise<Homework> {
		return this.objectJson<Homework>('GET', `/student/homeworks/${id}`, undefined, token);
	}

	async listStudentHomeworkCourses(token: CancellationToken): Promise<Course[]> {
		return this.listJson<Course>('GET', '/student/homeworks/courses', undefined, token);
	}

	async submitAnswer(homeworkId: number, payload: SubmitAnswerPayload, token: CancellationToken): Promise<{ submission_id: number; message: string }> {
		return this.objectJson<{ submission_id: number; message: string }>('POST', `/student/homeworks/${homeworkId}/submit`, { data: payload }, token);
	}

	async listStudentSubmissions(homeworkId: number, filters: SubmissionListFilters, token: CancellationToken): Promise<Paginated<HomeworkSubmission>> {
		const params = new URLSearchParams();
		if (filters.is_corrected !== undefined) { params.set('is_corrected', String(filters.is_corrected)); }
		if (filters.has_ai_result !== undefined) { params.set('has_ai_result', String(filters.has_ai_result)); }
		if (filters.date_from !== undefined) { params.set('date_from', filters.date_from); }
		if (filters.date_to !== undefined) { params.set('date_to', filters.date_to); }
		if (filters.per_page !== undefined) { params.set('per_page', String(filters.per_page)); }
		if (filters.page !== undefined) { params.set('page', String(filters.page)); }
		const qs = params.toString();
		return this.submissionListJson('GET', `/student/homeworks/${homeworkId}/submissions${qs ? '?' + qs : ''}`, undefined, token);
	}

	async getStudentSubmission(homeworkId: number, submissionId: number, token: CancellationToken): Promise<HomeworkSubmission> {
		return this.submissionJson('GET', `/student/homeworks/${homeworkId}/submissions/${submissionId}`, undefined, token);
	}

	async listQuestions(filters: QuestionListFilters, token: CancellationToken): Promise<Paginated<Question>> {
		const params = new URLSearchParams();
		if (filters.search !== undefined) { params.set('search', filters.search); }
		if (filters.course_id !== undefined) { params.set('course_id', String(filters.course_id)); }
		if (filters.subject_id !== undefined) { params.set('subject_id', String(filters.subject_id)); }
		if (filters.difficulty_id !== undefined) { params.set('difficulty_id', String(filters.difficulty_id)); }
		if (filters.type_id !== undefined) { params.set('type_id', String(filters.type_id)); }
		if (filters.per_page !== undefined) { params.set('per_page', String(filters.per_page)); }
		if (filters.page !== undefined) { params.set('page', String(filters.page)); }
		const qs = params.toString();
		return this.paginatedJson<Question>('GET', `/question-bank/questions${qs ? '?' + qs : ''}`, undefined, token);
	}

	async listCourses(filters: { search?: string; university_id?: number }, token: CancellationToken): Promise<Course[]> {
		const params = new URLSearchParams();
		if (filters.search !== undefined) { params.set('search', filters.search); }
		if (filters.university_id !== undefined) { params.set('university_id', String(filters.university_id)); }
		const qs = params.toString();
		return this.listJson<Course>('GET', `/question-bank/courses${qs ? '?' + qs : ''}`, undefined, token);
	}

	async listSubjects(filters: { search?: string; course_id?: number }, token: CancellationToken): Promise<Subject[]> {
		const params = new URLSearchParams();
		if (filters.search !== undefined) { params.set('search', filters.search); }
		if (filters.course_id !== undefined) { params.set('course_id', String(filters.course_id)); }
		const qs = params.toString();
		return this.listJson<Subject>('GET', `/question-bank/subjects${qs ? '?' + qs : ''}`, undefined, token);
	}

	async listDifficultyRates(token: CancellationToken): Promise<DifficultyRate[]> {
		return this.listJson<DifficultyRate>('GET', '/question-bank/difficulty-rates', undefined, token);
	}

	async listQuestionTypes(token: CancellationToken): Promise<QuestionTypeLookup[]> {
		return this.listJson<QuestionTypeLookup>('GET', '/question-bank/question-types', undefined, token);
	}

	async assignHomework(payload: AssignHomeworkPayload, token: CancellationToken): Promise<{ created_count: number; items: Homework[] }> {
		return this.objectJson<{ created_count: number; items: Homework[] }>('POST', '/admin/homeworks/assign', { data: payload }, token);
	}

	async getQuestion(id: number, token: CancellationToken): Promise<Question> {
		return this.objectJson<Question>('GET', `/question-bank/questions/${id}`, undefined, token);
	}

	async createCodeQuestion(payload: CreateCodeQuestionPayload, token: CancellationToken): Promise<Question> {
		return this.objectJson<Question>('POST', '/question-bank/questions', { data: payload }, token);
	}

	async getAiGradingResult(resultId: number, token: CancellationToken): Promise<AiGradingResult> {
		return this.objectJson<AiGradingResult>('GET', `/ai-grading/results/${resultId}`, undefined, token);
	}

	async getLatestAiResult(homeworkId: number, submissionId: number, token: CancellationToken): Promise<AiGradingResult> {
		return this.objectJson<AiGradingResult>('GET', `/homeworks/${homeworkId}/submissions/${submissionId}/ai-result`, undefined, token);
	}

	async pollAiResultStatus(homeworkId: number, submissionId: number, token: CancellationToken): Promise<AiResultStatus> {
		return this.objectJson<AiResultStatus>('GET', `/homeworks/${homeworkId}/submissions/${submissionId}/ai-result/status`, undefined, token);
	}

	async listAdminHomeworks(filters: AdminHomeworkListFilters, token: CancellationToken): Promise<Paginated<Homework>> {
		const params = new URLSearchParams();
		if (filters.student_id !== undefined) { params.set('student_id', String(filters.student_id)); }
		if (filters.course_id !== undefined) { params.set('course_id', String(filters.course_id)); }
		if (filters.subject_id !== undefined) { params.set('subject_id', String(filters.subject_id)); }
		if (filters.question_type_id !== undefined) { params.set('question_type_id', String(filters.question_type_id)); }
		if (filters.status !== undefined) { params.set('status', filters.status); }
		if (filters.is_ai_graded !== undefined) { params.set('is_ai_graded', String(filters.is_ai_graded)); }
		if (filters.date_from !== undefined) { params.set('date_from', filters.date_from); }
		if (filters.date_to !== undefined) { params.set('date_to', filters.date_to); }
		if (filters.search !== undefined) { params.set('search', filters.search); }
		if (filters.per_page !== undefined) { params.set('per_page', String(filters.per_page)); }
		if (filters.page !== undefined) { params.set('page', String(filters.page)); }
		const qs = params.toString();
		return this.paginatedJson<Homework>('GET', `/admin/homeworks${qs ? '?' + qs : ''}`, undefined, token);
	}

	async listAdminSubmissions(homeworkId: number, filters: SubmissionListFilters, token: CancellationToken): Promise<Paginated<HomeworkSubmission>> {
		const params = new URLSearchParams();
		if (filters.is_corrected !== undefined) { params.set('is_corrected', String(filters.is_corrected)); }
		if (filters.has_ai_result !== undefined) { params.set('has_ai_result', String(filters.has_ai_result)); }
		if (filters.date_from !== undefined) { params.set('date_from', filters.date_from); }
		if (filters.date_to !== undefined) { params.set('date_to', filters.date_to); }
		if (filters.per_page !== undefined) { params.set('per_page', String(filters.per_page)); }
		if (filters.page !== undefined) { params.set('page', String(filters.page)); }
		const qs = params.toString();
		return this.submissionListJson('GET', `/admin/homeworks/${homeworkId}/submissions${qs ? '?' + qs : ''}`, undefined, token);
	}

	async getAdminSubmission(homeworkId: number, submissionId: number, token: CancellationToken): Promise<HomeworkSubmission> {
		return this.submissionJson('GET', `/admin/homeworks/${homeworkId}/submissions/${submissionId}`, undefined, token);
	}

	async correctSubmission(homeworkId: number, submissionId: number, payload: CorrectionPayload, token: CancellationToken): Promise<Homework> {
		return this.objectJson<Homework>('PATCH', `/admin/homeworks/${homeworkId}/submissions/${submissionId}/correct`, { data: payload }, token);
	}

	async triggerAiGrade(homeworkId: number, payload: AiGradePayload, token: CancellationToken): Promise<{ mode: 'queued'; message: string } | { mode: 'sync'; result: AiGradingResult }> {
		return this.objectJson<{ mode: 'queued'; message: string } | { mode: 'sync'; result: AiGradingResult }>('POST', `/admin/homeworks/${homeworkId}/ai-grade`, { data: payload }, token);
	}

	async triggerRegrade(homeworkId: number, payload: RegradePayload, token: CancellationToken): Promise<{ message: string; grading_result_id: number }> {
		return this.objectJson<{ message: string; grading_result_id: number }>('POST', `/admin/homeworks/${homeworkId}/ai-grade/regrade`, { data: payload }, token);
	}

	async listAdminStudentCourses(studentId: number, token: CancellationToken): Promise<Course[]> {
		return this.listJson<Course>('GET', `/admin/students/${studentId}/courses`, undefined, token);
	}

	async createSubject(payload: CreateSubjectPayload, token: CancellationToken): Promise<Subject> {
		return this.objectJson<Subject>('POST', '/question-bank/subjects', { data: payload }, token);
	}

	async getAdminHomework(id: number, token: CancellationToken): Promise<Homework> {
		return this.objectJson<Homework>('GET', `/admin/homeworks/${id}`, undefined, token);
	}
}
