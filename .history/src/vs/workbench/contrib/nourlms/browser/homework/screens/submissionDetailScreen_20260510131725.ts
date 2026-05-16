/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from "../../../../../../nls.js";
import { append, $, clearNode } from "../../../../../../base/browser/dom.js";
import { safeSetInnerHtml } from "../../../../../../base/browser/domSanitize.js";
import { Disposable } from "../../../../../../base/common/lifecycle.js";
import { CancellationTokenSource } from "../../../../../../base/common/cancellation.js";
import { Codicon } from "../../../../../../base/common/codicons.js";
import { ThemeIcon } from "../../../../../../base/common/themables.js";
import { IDialogService } from "../../../../../../platform/dialogs/common/dialogs.js";
import { ILogService } from "../../../../../../platform/log/common/log.js";
import {
	INourlmsHomeworkApi,
	ApiError,
	CorrectionPayload,
} from "../nourlmsHomeworkApi.js";
import { IHomeworkScreen, ScreenContext } from "../nourlmsHomeworkRouter.js";
import type {
	HomeworkSubmission,
	AiGradingResult,
	Homework,
} from "../types.js";
import {
	appendErrorRow,
	appendLoadingRow,
	formatDate,
	gradeClassForValue,
	safeText,
} from "./screenUtils.js";

interface State {
	submission: HomeworkSubmission | null;
	submissionLoading: boolean;
	submissionError: ApiError | null;
	homework: Homework | null;
	aiResult: AiGradingResult | null;
	aiLoading: boolean;
	aiError: ApiError | null;
	grading: boolean;
	gradingError: ApiError | null;
	correcting: boolean;
	correctError: ApiError | null;
	/** Set to the raw upstream JSON when the answer is empty after normalization,
	 *  so the user can see exactly what shape the upstream returned without
	 *  opening DevTools. */
	rawDebug: unknown;
}

export class SubmissionDetailScreen
	extends Disposable
	implements IHomeworkScreen
{
	private parent!: HTMLElement;
	private ctx!: ScreenContext;
	private cts = this._register(new CancellationTokenSource());

	private state: State;

	constructor(
		private readonly homeworkId: number,
		private readonly submissionId: number,
		private readonly isAdmin: boolean,
		preloaded: HomeworkSubmission | undefined,
		@INourlmsHomeworkApi private readonly api: INourlmsHomeworkApi,
		@IDialogService private readonly dialogService: IDialogService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.state = {
			submission: preloaded ?? null,
			submissionLoading: !preloaded,
			submissionError: null,
			homework: null,
			aiResult: null,
			aiLoading: false,
			aiError: null,
			grading: false,
			gradingError: null,
			correcting: false,
			correctError: null,
			rawDebug: undefined,
		};
	}

	mount(parent: HTMLElement, ctx: ScreenContext): void {
		this.parent = parent;
		this.ctx = ctx;
		parent.classList.add("nourlms-hw-screen", "nourlms-hw-screen--scroll");
		void this.ctx;

		this.refresh();
		// ALWAYS refetch the full submission detail. The list endpoint usually
		// returns a lighter row without `content` and without `latest_ai_result_id`,
		// so relying on the preloaded value alone leaves the answer block empty
		// and never triggers the AI-result auto-load.
		this.fetchSubmission();
		// Kick off the homework fetch in parallel so the question content shows
		// up as soon as either request completes.
		this.fetchHomework();
	}

	private async fetchSubmission(): Promise<void> {
		const hadPreload = !!this.state.submission;
		if (!hadPreload) {
			this.state.submissionLoading = true;
			this.state.submissionError = null;
			this.refresh();
		}
		try {
			const sub = this.isAdmin
				? await this.api.getAdminSubmission(
						this.homeworkId,
						this.submissionId,
						this.cts.token,
					)
				: await this.api.getStudentSubmission(
						this.homeworkId,
						this.submissionId,
						this.cts.token,
					);
			// Smart-merge: take the fresh response as the base, but for every
			// field that came back empty (`null`, `undefined`, or empty string)
			// fall back to whatever the preloaded list-row had. This is what
			// fixes the admin-side "(empty submission)" — the admin endpoint
			// occasionally returns a row WITHOUT `content` while the list-row
			// preload had it.
			const prev = this.state.submission;
			const merged: HomeworkSubmission = {
				...(prev ?? ({} as HomeworkSubmission)),
				...sub,
			};
			if (prev) {
				const keys: (keyof HomeworkSubmission)[] = [
					"content",
					"submitted_at",
					"latest_ai_result_id",
				];
				for (const k of keys) {
					const fresh = (sub as HomeworkSubmission)[k];
					const old = prev[k];
					if (
						(fresh === null || fresh === undefined || fresh === "") &&
						old !== null &&
						old !== undefined &&
						old !== ""
					) {
						(merged as Record<keyof HomeworkSubmission, unknown>)[k] = old;
					}
				}
			}
			this.state.submission = merged;
			this.state.submissionLoading = false;
			if (!merged.content || merged.content.length === 0) {
				// Diagnostic for the "(empty submission)" case. The normalizer in
				// nourlmsHomeworkApi.ts already searches a long list of common
				// field names AND one level of common wrapper keys. If the answer
				// is STILL missing after that, log the full raw JSON so the user
				// (or me) can paste it back and add the actual field name to the
				// normalizer in seconds.
				const raw = (sub as HomeworkSubmission & { __raw?: unknown }).__raw;
				this.state.rawDebug = raw;
				let rawString: string;
				try {
					rawString = JSON.stringify(raw, null, 2);
				} catch {
					rawString = String(raw);
				}
				this.logService.warn(
					`[NourlmsHomework] submission #${this.submissionId} for homework #${this.homeworkId} ` +
						`(${this.isAdmin ? "admin" : "student"} endpoint) returned no answer text after normalization.\n` +
						`Raw upstream JSON:\n${rawString}`,
				);
			} else {
				this.state.rawDebug = undefined;
			}
			this.refresh();
			this.maybeLoadAiResult();
		} catch (err) {
			this.state.submissionLoading = false;
			if (!hadPreload) {
				this.state.submissionError =
					err instanceof ApiError
						? err
						: new ApiError({ status: 0, message: String(err) });
			}
			// If we have preloaded data, keep showing it and stay silent — fall
			// back to whatever we had so the user isn't blocked by a transient
			// fetch failure.
			this.refresh();
		}
	}

	private async fetchHomework(): Promise<void> {
		try {
			const hw = this.isAdmin
				? await this.api.getAdminHomework(this.homeworkId, this.cts.token)
				: await this.api.getStudentHomework(this.homeworkId, this.cts.token);
			if (hw) {
				this.state.homework = hw;
				this.refresh();
			}
		} catch {
			/* non-fatal */
		}
	}

	private maybeLoadAiResult(): void {
		const sub = this.state.submission;
		if (!sub) {
			return;
		}
		// Always try /ai-result, even when `latest_ai_result_id` is missing.
		// Some upstream variants don't include that field on submission rows,
		// which used to silently hide the AI grade for the student.
		this.loadAiResult();
	}

	private async loadAiResult(): Promise<void> {
		const sub = this.state.submission;
		if (!sub) {
			return;
		}
		this.state.aiLoading = true;
		this.state.aiError = null;
		this.refresh();
		try {
			const result = await this.api.getLatestAiResult(
				this.homeworkId,
				sub.id,
				this.cts.token,
			);
			this.state.aiResult = result;
			this.state.aiLoading = false;
			this.refresh();
		} catch (err) {
			// 404 from the latest-AI-result endpoint means "no AI result yet"
			// — render the empty state silently instead of an error.
			if (err instanceof ApiError && err.status === 404) {
				this.state.aiResult = null;
				this.state.aiLoading = false;
				this.state.aiError = null;
			} else {
				this.state.aiLoading = false;
				this.state.aiError =
					err instanceof ApiError
						? err
						: new ApiError({ status: 0, message: String(err) });
			}
			this.refresh();
		}
	}

	private async triggerAiGrade(mode: "queued" | "sync"): Promise<void> {
		const sub = this.state.submission;
		if (!sub) {
			return;
		}
		this.state.grading = true;
		this.state.gradingError = null;
		this.refresh();
		try {
			const result = await this.api.triggerAiGrade(
				this.homeworkId,
				{ submission_id: sub.id, mode },
				this.cts.token,
			);
			this.state.grading = false;
			if (result.mode === "sync") {
				this.state.aiResult = result.result;
			} else {
				// queued — do a manual reload after a short delay
				setTimeout(() => this.loadAiResult(), 2000);
			}
			this.refresh();
		} catch (err) {
			this.state.grading = false;
			this.state.gradingError =
				err instanceof ApiError
					? err
					: new ApiError({ status: 0, message: String(err) });
			this.refresh();
		}
	}

	private async triggerRegrade(): Promise<void> {
		const sub = this.state.submission;
		if (!sub) {
			return;
		}
		this.state.grading = true;
		this.state.gradingError = null;
		this.refresh();
		try {
			await this.api.triggerRegrade(
				this.homeworkId,
				{ submission_id: sub.id },
				this.cts.token,
			);
			this.state.grading = false;
			setTimeout(() => this.loadAiResult(), 2000);
			this.refresh();
		} catch (err) {
			this.state.grading = false;
			this.state.gradingError =
				err instanceof ApiError
					? err
					: new ApiError({ status: 0, message: String(err) });
			this.refresh();
		}
	}

	private async showCorrectModal(): Promise<void> {
		const sub = this.state.submission;
		if (!sub) {
			return;
		}

		const result = await this.dialogService.input({
			title: localize(
				"nourlms.homework.admin.correct.title",
				"Correct Submission #{0}",
				String(sub.id),
			),
			message: localize(
				"nourlms.homework.admin.correct.message",
				"Enter the mark and/or feedback for this submission.",
			),
			inputs: [
				{
					placeholder: localize(
						"nourlms.homework.admin.correct.mark",
						"Mark (optional)",
					),
				},
				{
					placeholder: localize(
						"nourlms.homework.admin.correct.feedback",
						"Feedback (optional)",
					),
				},
			],
		});
		if (!result.confirmed) {
			return;
		}
		const values = result.values ?? [];
		const payload: CorrectionPayload = { is_corrected: true };
		const markRaw = values[0];
		if (markRaw !== undefined && markRaw !== "") {
			const mark = Number(markRaw);
			if (!isNaN(mark)) {
				payload.mark = mark;
			}
		}
		const feedback = values[1];
		if (feedback !== undefined && feedback !== "") {
			payload.correct_the_answer = feedback;
		}

		this.state.correcting = true;
		this.state.correctError = null;
		this.refresh();
		try {
			await this.api.correctSubmission(
				this.homeworkId,
				sub.id,
				payload,
				this.cts.token,
			);
			this.state.correcting = false;
			this.refresh();
		} catch (err) {
			this.state.correcting = false;
			this.state.correctError =
				err instanceof ApiError
					? err
					: new ApiError({ status: 0, message: String(err) });
			this.refresh();
		}
	}

	private refresh(): void {
		clearNode(this.parent);
		const inner = append(this.parent, $(".nourlms-hw-screen__inner"));

		if (this.state.submissionLoading && !this.state.submission) {
			appendLoadingRow(inner);
			return;
		}

		if (this.state.submissionError && !this.state.submission) {
			appendErrorRow(inner, this.state.submissionError.toString());
			return;
		}

		const sub = this.state.submission;
		if (!sub) {
			appendErrorRow(
				inner,
				localize(
					"nourlms.homework.submission.notFound",
					"Submission not found.",
				),
			);
			return;
		}

		const header = append(inner, $(".nourlms-hw-detail__header"));
		const title = append(header, $(".nourlms-hw-detail__title"));
		title.textContent = localize(
			"nourlms.homework.page.submission",
			"Submission #{0}",
			String(sub.id ?? "?"),
		);

		const dateLabel = append(header, $("span.nourlms-hw-detail__date"));
		dateLabel.textContent = formatDate(sub.submitted_at);

		// Question content (when we have homework)
		if (this.state.homework?.question) {
			const qSection = append(inner, $(".nourlms-hw-section"));
			const qTitle = append(qSection, $(".nourlms-hw-section__title"));
			qTitle.textContent = localize(
				"nourlms.homework.submission.question",
				"Question",
			);
			const body = append(qSection, $(".nourlms-hw-prose"));
			safeSetInnerHtml(body, this.state.homework.question.content ?? "");
		}

		// Answer section — ALWAYS rendered, even if content is empty
		const answerSection = append(inner, $(".nourlms-hw-section"));
		const answerTitle = append(answerSection, $(".nourlms-hw-section__title"));
		answerTitle.textContent = localize(
			"nourlms.homework.submission.answer",
			"Answer",
		);
		const answerBlock = append(answerSection, $("div.nourlms-hw-codeblock"));
		const answerText = safeText(sub.content, "");
		console.log("answerText", sub);
		if (answerText.trim().length > 0) {
			answerBlock.textContent = answerText;
		} else {
			answerBlock.classList.add("nourlms-hw-codeblock--empty");
			answerBlock.textContent = localize(
				"nourlms.homework.submission.answerEmpty",
				"(empty submission)",
			);

			// If we recorded the raw upstream JSON because normalization
			// couldn't find an answer field, render it inline as a collapsible
			// debug block. The user (or me, on the next chat round) can copy
			// it and tell which field name actually carries the answer text.
			if (this.state.rawDebug !== undefined) {
				let rawString: string;
				try {
					rawString = JSON.stringify(this.state.rawDebug, null, 2);
				} catch {
					rawString = String(this.state.rawDebug);
				}
				const details = append(
					answerSection,
					$<HTMLDetailsElement>("details.nourlms-hw-debug"),
				);
				const summary = append(details, $("summary"));
				summary.textContent = localize(
					"nourlms.homework.submission.answerEmpty.debug",
					"Show raw API response (debug)",
				);
				const pre = append(details, $("pre.nourlms-hw-debug__pre"));
				pre.textContent = rawString;
			}
		}

		// AI grading result
		this.renderAiResultSection(inner);

		// Admin grading actions
		if (this.isAdmin) {
			this.renderAdminActions(inner);
		}
	}

	private renderAiResultSection(parent: HTMLElement): void {
		const section = append(parent, $(".nourlms-hw-section"));
		const title = append(section, $(".nourlms-hw-section__title"));
		title.textContent = localize(
			"nourlms.homework.submission.aiResult",
			"AI Grading Result",
		);

		if (this.state.aiLoading) {
			appendLoadingRow(
				section,
				localize(
					"nourlms.homework.submission.aiResultLoading",
					"Loading AI result…",
				),
			);
			return;
		}

		if (this.state.aiError) {
			appendErrorRow(section, this.state.aiError.toString());
			return;
		}

		const r = this.state.aiResult;
		if (!r) {
			const note = append(
				section,
				$(".nourlms-hw-notice.nourlms-hw-notice--info"),
			);
			note.textContent = localize(
				"nourlms.homework.submission.aiResult.none",
				"No AI grading result yet.",
			);
			return;
		}

		const grade = append(section, $("div.nourlms-hw-grade"));
		grade.classList.add(gradeClassForValue(r.grade));
		const gradeLabel = append(grade, $("span.nourlms-hw-grade__label"));
		gradeLabel.textContent = localize(
			"nourlms.homework.submission.grade",
			"Grade",
		);
		const gradeValue = append(grade, $("span.nourlms-hw-grade__value"));
		gradeValue.textContent = String(r.grade ?? "—");

		this.renderResultField(
			section,
			localize("nourlms.homework.result.syntaxError", "Syntax error"),
			r.syntax_error,
		);
		this.renderResultField(
			section,
			localize("nourlms.homework.result.hintSyntaxFix", "Syntax fix hint"),
			r.hint_syntax_fix,
		);
		this.renderResultField(
			section,
			localize("nourlms.homework.result.logicalError", "Logical error"),
			r.logical_error,
		);
		this.renderResultField(
			section,
			localize("nourlms.homework.result.hintLogicalFix", "Logical fix hint"),
			r.hint_logical_fix,
		);
		this.renderResultField(
			section,
			localize("nourlms.homework.result.explanation", "Explanation"),
			r.explanation,
		);
		this.renderResultField(
			section,
			localize(
				"nourlms.homework.result.bestAnswerComparison",
				"Best answer comparison",
			),
			r.best_answer_comparison,
		);

		if (r.id !== undefined) {
			const openBtn = append(
				section,
				$<HTMLButtonElement>(
					"button.nourlms-hw-button.nourlms-hw-button--ghost.nourlms-hw-button--small",
				),
			);
			openBtn.type = "button";
			openBtn.textContent = localize(
				"nourlms.homework.result.openAsPage",
				"Open as Page",
			);
			openBtn.addEventListener("click", () => {
				this.ctx.push(
					{ kind: "aiResult", resultId: r.id },
					localize(
						"nourlms.homework.page.aiResult",
						"AI Grading Result #{0}",
						String(r.id),
					),
				);
			});
		}
	}

	private renderResultField(
		parent: HTMLElement,
		label: string,
		value: string | null | undefined,
	): void {
		if (!value) {
			return;
		}
		const row = append(parent, $(".nourlms-hw-result-row"));
		const lab = append(row, $(".nourlms-hw-result-row__label"));
		lab.textContent = label;
		const val = append(row, $(".nourlms-hw-result-row__value"));
		val.textContent = value;
	}

	private renderAdminActions(parent: HTMLElement): void {
		const actions = append(parent, $(".nourlms-hw-actionbar"));

		if (this.state.grading) {
			const busy = append(actions, $("span.nourlms-hw-actionbar__busy"));
			busy.textContent = localize("nourlms.homework.admin.grading", "Grading…");
		}

		if (this.state.gradingError) {
			appendErrorRow(parent, this.state.gradingError.toString());
		}

		const queuedBtn = append(
			actions,
			$<HTMLButtonElement>("button.nourlms-hw-button"),
		);
		queuedBtn.type = "button";
		const queuedIcon = append(queuedBtn, $("span"));
		queuedIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.sparkle));
		const queuedLabel = append(queuedBtn, $("span"));
		queuedLabel.textContent = localize(
			"nourlms.homework.admin.aiGrade.queued",
			"Run AI grade (queued)",
		);
		queuedBtn.disabled = this.state.grading;
		queuedBtn.addEventListener("click", () => this.triggerAiGrade("queued"));

		const syncBtn = append(
			actions,
			$<HTMLButtonElement>("button.nourlms-hw-button.nourlms-hw-button--ghost"),
		);
		syncBtn.type = "button";
		syncBtn.textContent = localize(
			"nourlms.homework.admin.aiGrade.sync",
			"Sync grade",
		);
		syncBtn.disabled = this.state.grading;
		syncBtn.addEventListener("click", () => this.triggerAiGrade("sync"));

		if (this.state.aiResult) {
			const regradeBtn = append(
				actions,
				$<HTMLButtonElement>(
					"button.nourlms-hw-button.nourlms-hw-button--ghost",
				),
			);
			regradeBtn.type = "button";
			const regradeIcon = append(regradeBtn, $("span"));
			regradeIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.refresh));
			const regradeLabel = append(regradeBtn, $("span"));
			regradeLabel.textContent = localize(
				"nourlms.homework.admin.aiGrade.regrade",
				"Re-grade",
			);
			regradeBtn.disabled = this.state.grading;
			regradeBtn.addEventListener("click", () => this.triggerRegrade());
		}

		const correctBtn = append(
			actions,
			$<HTMLButtonElement>(
				"button.nourlms-hw-button.nourlms-hw-button--secondary",
			),
		);
		correctBtn.type = "button";
		const correctIcon = append(correctBtn, $("span"));
		correctIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.check));
		const correctLabel = append(correctBtn, $("span"));
		correctLabel.textContent = localize(
			"nourlms.homework.admin.correct",
			"Mark as corrected",
		);
		correctBtn.disabled = this.state.correcting;
		correctBtn.addEventListener("click", () => this.showCorrectModal());

		if (this.state.correctError) {
			appendErrorRow(parent, this.state.correctError.toString());
		}
	}
}
