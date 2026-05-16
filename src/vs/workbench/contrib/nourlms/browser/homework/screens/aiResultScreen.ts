/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../../nls.js';
import { append, $, clearNode } from '../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { INourlmsHomeworkApi, ApiError } from '../nourlmsHomeworkApi.js';
import { IHomeworkScreen, ScreenContext } from '../nourlmsHomeworkRouter.js';
import type { AiGradingResult } from '../types.js';
import { appendErrorRow, appendLoadingRow, formatDate, gradeClassForValue } from './screenUtils.js';

export class AiResultScreen extends Disposable implements IHomeworkScreen {

	private parent!: HTMLElement;
	private cts = this._register(new CancellationTokenSource());
	private result: AiGradingResult | null = null;
	private loading = true;
	private error: ApiError | null = null;

	constructor(
		private readonly resultId: number,
		@INourlmsHomeworkApi private readonly api: INourlmsHomeworkApi,
	) {
		super();
	}

	mount(parent: HTMLElement, _ctx: ScreenContext): void {
		this.parent = parent;
		void _ctx;
		parent.classList.add('nourlms-hw-screen', 'nourlms-hw-screen--scroll');
		this.refresh();
		this.fetch();
	}

	private async fetch(): Promise<void> {
		try {
			this.result = await this.api.getAiGradingResult(this.resultId, this.cts.token);
			this.loading = false;
			this.refresh();
		} catch (err) {
			this.loading = false;
			this.error = err instanceof ApiError ? err : new ApiError({ status: 0, message: String(err) });
			this.refresh();
		}
	}

	private refresh(): void {
		clearNode(this.parent);
		const inner = append(this.parent, $('.nourlms-hw-screen__inner'));

		if (this.loading) {
			appendLoadingRow(inner);
			return;
		}
		if (this.error) {
			appendErrorRow(inner, this.error.toString());
			return;
		}
		const r = this.result;
		if (!r) {
			appendErrorRow(inner, localize('nourlms.homework.aiResult.notFound', "AI result not found."));
			return;
		}

		const header = append(inner, $('.nourlms-hw-detail__header'));
		const title = append(header, $('.nourlms-hw-detail__title'));
		title.textContent = localize('nourlms.homework.page.aiResult', "AI Grading Result #{0}", String(r.id ?? '?'));
		const date = append(header, $('span.nourlms-hw-detail__date'));
		date.textContent = formatDate(r.graded_at);

		const grade = append(inner, $('div.nourlms-hw-grade'));
		grade.classList.add(gradeClassForValue(r.grade));
		const gradeLabel = append(grade, $('span.nourlms-hw-grade__label'));
		gradeLabel.textContent = localize('nourlms.homework.submission.grade', "Grade");
		const gradeValue = append(grade, $('span.nourlms-hw-grade__value'));
		gradeValue.textContent = String(r.grade ?? '—');

		this.renderField(inner, localize('nourlms.homework.result.syntaxError', "Syntax error"), r.syntax_error);
		this.renderField(inner, localize('nourlms.homework.result.hintSyntaxFix', "Syntax fix hint"), r.hint_syntax_fix);
		this.renderField(inner, localize('nourlms.homework.result.logicalError', "Logical error"), r.logical_error);
		this.renderField(inner, localize('nourlms.homework.result.hintLogicalFix', "Logical fix hint"), r.hint_logical_fix);
		this.renderField(inner, localize('nourlms.homework.result.explanation', "Explanation"), r.explanation);
		this.renderField(inner, localize('nourlms.homework.result.bestAnswerComparison', "Best answer comparison"), r.best_answer_comparison);
	}

	private renderField(parent: HTMLElement, label: string, value: string | null | undefined): void {
		if (!value) { return; }
		const row = append(parent, $('.nourlms-hw-result-row'));
		const lab = append(row, $('.nourlms-hw-result-row__label'));
		lab.textContent = label;
		const val = append(row, $('.nourlms-hw-result-row__value'));
		val.textContent = value;
	}
}
