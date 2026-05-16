/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	CancellationToken,
	CancellationTokenSource,
} from "../../../../../base/common/cancellation.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import { localize } from "../../../../../nls.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import { createDecorator } from "../../../../../platform/instantiation/common/instantiation.js";
import { INourlmsAuthService } from "../../../../services/nourlms/common/nourlms.js";
import { SIDE_GROUP } from "../../../../services/editor/common/editorService.js";
import { IWebviewWorkbenchService } from "../../../webviewPanel/browser/webviewWorkbenchService.js";
import { WebviewInput } from "../../../webviewPanel/browser/webviewEditorInput.js";
import { INourlmsHomeworkApi } from "./nourlmsHomeworkApi.js";
import type { AiGradingResult, HomeworkSubmission, Question } from "./types.js";

export type PageKind = "question" | "submission" | "aiResult";

export interface OpenPageRequest {
	kind: PageKind;
	id: number;
	homeworkId?: number;
	title: string;
	/**
	 * Optional pre-loaded payload. When provided, the page manager renders
	 * from it directly and skips the API fetch — required for students
	 * opening a question (the question is nested inside the homework they
	 * already loaded; the question-bank endpoint is admin-only).
	 */
	question?: Question;
	submission?: HomeworkSubmission;
	aiResult?: AiGradingResult;
}

export const INourlmsHomeworkPageManager =
	createDecorator<INourlmsHomeworkPageManager>("nourlmsHomeworkPageManager");

export interface INourlmsHomeworkPageManager {
	readonly _serviceBrand: undefined;
	open(request: OpenPageRequest): Promise<void>;
	closeAll(): void;
}

export class NourlmsHomeworkPageManager
	extends Disposable
	implements INourlmsHomeworkPageManager
{
	declare readonly _serviceBrand: undefined;

	private readonly inputs = new Map<string, WebviewInput>();

	constructor(
		@IWebviewWorkbenchService
		private readonly webviewWorkbenchService: IWebviewWorkbenchService,
		@INourlmsHomeworkApi private readonly api: INourlmsHomeworkApi,
		@INourlmsAuthService private readonly authService: INourlmsAuthService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(authService.onDidLogout(() => this.closeAll()));
	}

	async open(request: OpenPageRequest): Promise<void> {
		const key = `${request.kind}:${request.id}`;
		const existing = this.inputs.get(key);
		if (existing && !existing.isDisposed()) {
			this.webviewWorkbenchService.revealWebview(existing, SIDE_GROUP, false);
			return;
		}

		const cts = new CancellationTokenSource();
		let htmlBody = "";
		try {
			switch (request.kind) {
				case "question": {
					const question =
						request.question ??
						(await this.api.getQuestion(request.id, cts.token));
					htmlBody = this.renderQuestion(question);
					break;
				}
				case "submission": {
					if (request.homeworkId === undefined) {
						throw new Error("homeworkId required for submission page");
					}
					const submission =
						request.submission ??
						(await this.fetchSubmission(
							request.homeworkId,
							request.id,
							cts.token,
						));
					htmlBody = await this.renderSubmissionWithResult(
						submission,
						request.homeworkId,
						cts.token,
					);
					break;
				}
				case "aiResult": {
					const result =
						request.aiResult ??
						(await this.api.getAiGradingResult(request.id, cts.token));
					htmlBody = this.renderAiResult(result);
					break;
				}
			}
		} catch (err) {
			this.logService.warn(
				`[NourlmsHomeworkPageManager] Failed to load page ${key}`,
				err,
			);
			const errMsg = err instanceof Error ? err.message : String(err);
			htmlBody =
				`<p style="color:var(--vscode-errorForeground)">${this.escapeHtml(localize("nourlms.homework.page.loadError", "Failed to load content."))}</p>` +
				`<p style="color:var(--vscode-descriptionForeground);font-size:11px;">${this.escapeHtml(errMsg)}</p>`;
		} finally {
			cts.dispose();
		}

		const html = `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); font-size: 13px; color: var(--vscode-foreground); padding: 12px 16px; margin: 0; }
h1 { font-size: 16px; margin: 0 0 12px; }
.field-label { font-weight: 600; color: var(--vscode-descriptionForeground); margin-top: 10px; }
.field-value { margin-top: 2px; }
.code-block { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>${htmlBody}</body>
</html>`;

		const input = this.webviewWorkbenchService.openWebview(
			{
				title: request.title,
				options: {
					enableFindWidget: true,
					disableServiceWorker: true,
					tryRestoreScrollPosition: true,
				},
				contentOptions: {
					allowScripts: false,
					allowForms: false,
					localResourceRoots: [],
					enableCommandUris: false,
				},
				extension: undefined,
			},
			`nourlms-homework-${key}`,
			request.title,
			undefined,
			{ group: SIDE_GROUP, preserveFocus: false },
		);

		input.webview.setHtml(html);

		this.inputs.set(key, input);
		const sub = input.onWillDispose(() => {
			this.inputs.delete(key);
			sub.dispose();
		});
	}

	private async fetchSubmission(
		homeworkId: number,
		submissionId: number,
		token: CancellationToken,
	): Promise<HomeworkSubmission> {
		const role = this.authService.userInfo?.role;
		if (role === "admin") {
			return this.api.getAdminSubmission(homeworkId, submissionId, token);
		}
		return this.api.getStudentSubmission(homeworkId, submissionId, token);
	}

	closeAll(): void {
		for (const input of this.inputs.values()) {
			input.dispose();
		}
		this.inputs.clear();
	}

	private renderQuestion(q: Question): string {
		return `<h1>${this.escapeHtml(localize("nourlms.homework.page.question", "Question #{0}", q.id))}</h1>
<div class="field-value">${q.content}</div>
${q.pre_answer ? `<div class="field-label">${this.escapeHtml(localize("nourlms.homework.page.starterCode", "Starter code"))}</div><div class="code-block">${this.escapeHtml(q.pre_answer)}</div>` : ""}`;
	}

	private async renderSubmissionWithResult(
		s: HomeworkSubmission,
		homeworkId: number,
		token: CancellationToken,
	): Promise<string> {
		void homeworkId;
		let aiResultHtml = "";
		if (s.latest_ai_result_id !== null) {
			try {
				const result = await this.api.getAiGradingResult(
					s.latest_ai_result_id,
					token,
				);
				aiResultHtml = `
<div style="border-top:1px solid var(--vscode-widget-border, #ccc);margin-top:16px;padding-top:12px;">
<h2>${this.escapeHtml(localize("nourlms.homework.page.aiGradingResult", "AI Grading Result"))}</h2>
${this.renderAiResultFields(result)}
</div>`;
			} catch {
				// If fetching the AI result fails, omit it silently
			}
		}
		return `<h1>${this.escapeHtml(localize("nourlms.homework.page.submission", "Submission #{0}", s.id))}</h1>
<div class="field-label">${this.escapeHtml(localize("nourlms.homework.page.submittedAt", "Submitted"))}</div>
<div class="field-value">${this.escapeHtml(s.submitted_at)}</div>
<div class="field-label">${this.escapeHtml(localize("nourlms.homework.page.answer", "Answer"))}</div>
<div class="code-block">${this.escapeHtml(s.content)}</div>
${aiResultHtml}`;
	}

	private renderAiResultFields(r: AiGradingResult): string {
		return `<div class="field-label">${this.escapeHtml(localize("nourlms.homework.page.grade", "Grade"))}</div>
<div class="field-value">${r.grade}</div>
${r.syntax_error ? `<div class="field-label">${this.escapeHtml(localize("nourlms.homework.page.syntaxError", "Syntax error"))}</div><div class="field-value">${this.escapeHtml(r.syntax_error)}</div>` : ""}
${r.hint_syntax_fix ? `<div class="field-label">${this.escapeHtml(localize("nourlms.homework.page.hintSyntaxFix", "Syntax fix hint"))}</div><div class="field-value">${this.escapeHtml(r.hint_syntax_fix)}</div>` : ""}
${r.logical_error ? `<div class="field-label">${this.escapeHtml(localize("nourlms.homework.page.logicalError", "Logical error"))}</div><div class="field-value">${this.escapeHtml(r.logical_error)}</div>` : ""}
${r.hint_logical_fix ? `<div class="field-label">${this.escapeHtml(localize("nourlms.homework.page.hintLogicalFix", "Logical fix hint"))}</div><div class="field-value">${this.escapeHtml(r.hint_logical_fix)}</div>` : ""}
<div class="field-label">${this.escapeHtml(localize("nourlms.homework.page.explanation", "Explanation"))}</div>
<div class="field-value">${r.explanation}</div>
${r.best_answer_comparison ? `<div class="field-label">${this.escapeHtml(localize("nourlms.homework.page.comparison", "Best answer comparison"))}</div><div class="field-value">${r.best_answer_comparison}</div>` : ""}`;
	}

	private renderAiResult(r: AiGradingResult): string {
		return `<h1>${this.escapeHtml(localize("nourlms.homework.page.aiResult", "AI Grading Result #{0}", r.id))}</h1>
${this.renderAiResultFields(r)}`;
	}

	private escapeHtml(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	override dispose(): void {
		this.closeAll();
		super.dispose();
	}
}
