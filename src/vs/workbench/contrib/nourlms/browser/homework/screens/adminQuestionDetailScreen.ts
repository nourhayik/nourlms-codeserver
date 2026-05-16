/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../../nls.js';
import { append, $, clearNode } from '../../../../../../base/browser/dom.js';
import { safeSetInnerHtml } from '../../../../../../base/browser/domSanitize.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { INourlmsHomeworkApi, ApiError } from '../nourlmsHomeworkApi.js';
import { IHomeworkScreen, ScreenContext } from '../nourlmsHomeworkRouter.js';
import type { Question } from '../types.js';
import { appendErrorRow, appendLoadingRow, getQuestionTypeKey, isCodeQuestion } from './screenUtils.js';

export class AdminQuestionDetailScreen extends Disposable implements IHomeworkScreen {

	private parent!: HTMLElement;
	private cts = this._register(new CancellationTokenSource());
	private question: Question | null = null;
	private loading = true;
	private error: ApiError | null = null;

	constructor(
		private readonly questionId: number,
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
			this.question = await this.api.getQuestion(this.questionId, this.cts.token);
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
		const q = this.question;
		if (!q) {
			appendErrorRow(inner, localize('nourlms.homework.question.notFound', "Question not found."));
			return;
		}

		const header = append(inner, $('.nourlms-hw-detail__header'));
		const title = append(header, $('.nourlms-hw-detail__title'));
		title.textContent = localize('nourlms.homework.page.question', "Question #{0}", String(q.id ?? '?'));

		const meta = append(inner, $('.nourlms-hw-detail__meta'));
		const typePill = append(meta, $('span.nourlms-hw-pill'));
		typePill.classList.add(isCodeQuestion(q) ? 'nourlms-hw-pill--code' : 'nourlms-hw-pill--type');
		typePill.textContent = getQuestionTypeKey(q) ?? localize('nourlms.homework.unknownType', "Question");
		const weight = append(meta, $('span'));
		weight.textContent = localize('nourlms.homework.weight', "Weight: {0}", String(q.weight ?? 0));

		const body = append(inner, $('.nourlms-hw-prose'));
		safeSetInnerHtml(body, q.content ?? '');

		if (q.pre_answer) {
			const t = append(inner, $('.nourlms-hw-section__title'));
			t.textContent = localize('nourlms.homework.starterCode', "Starter code");
			const block = append(inner, $('div.nourlms-hw-codeblock'));
			block.textContent = q.pre_answer;
		}

		if (q.best_answer) {
			const t = append(inner, $('.nourlms-hw-section__title'));
			t.textContent = localize('nourlms.homework.bestAnswer', "Best answer");
			const block = append(inner, $('div.nourlms-hw-codeblock'));
			block.textContent = q.best_answer;
		}
	}
}
