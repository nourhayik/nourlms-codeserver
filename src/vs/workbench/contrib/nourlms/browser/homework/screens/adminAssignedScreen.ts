/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../../nls.js';
import { append, $, clearNode } from '../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { INourlmsHomeworkApi, ApiError, AdminHomeworkListFilters, SubmissionListFilters } from '../nourlmsHomeworkApi.js';
import { INourlmsHomeworkTargetStudentService } from '../nourlmsHomeworkTargetStudent.js';
import { IHomeworkScreen, ScreenContext } from '../nourlmsHomeworkRouter.js';
import type { Homework, HomeworkSubmission } from '../types.js';
import { appendEmptyRow, appendErrorRow, appendLoadingRow, formatDate, initials, shortQuestionPreview } from './screenUtils.js';

interface State {
	homeworks: Homework[];
	currentPage: number;
	lastPage: number;
	loading: boolean;
	error: ApiError | null;
	filters: AdminHomeworkListFilters;
	selectedHomework: Homework | null;
	submissions: HomeworkSubmission[];
	submissionsPage: number;
	submissionsLastPage: number;
	submissionsLoading: boolean;
	submissionsError: ApiError | null;
	submissionFilters: SubmissionListFilters;
}

export class AdminAssignedScreen extends Disposable implements IHomeworkScreen {

	private parent!: HTMLElement;
	private ctx!: ScreenContext;
	private cts = this._register(new CancellationTokenSource());
	private fetchNonce = 0;

	private state: State = {
		homeworks: [],
		currentPage: 1,
		lastPage: 1,
		loading: false,
		error: null,
		filters: {},
		selectedHomework: null,
		submissions: [],
		submissionsPage: 1,
		submissionsLastPage: 1,
		submissionsLoading: false,
		submissionsError: null,
		submissionFilters: {},
	};

	constructor(
		@INourlmsHomeworkApi private readonly api: INourlmsHomeworkApi,
		@INourlmsHomeworkTargetStudentService private readonly targetStudentService: INourlmsHomeworkTargetStudentService,
	) {
		super();
	}

	mount(parent: HTMLElement, ctx: ScreenContext): void {
		this.parent = parent;
		this.ctx = ctx;
		parent.classList.add('nourlms-hw-screen', 'nourlms-hw-screen--scroll');

		this._register(this.targetStudentService.onDidChange(() => {
			this.state.selectedHomework = null;
			this.state.submissions = [];
			this.state.homeworks = [];
			this.state.currentPage = 1;
			this.fetchHomeworks();
		}));

		this.fetchHomeworks();
	}

	private async fetchHomeworks(): Promise<void> {
		const target = this.targetStudentService.current;
		if (!target) {
			this.state.homeworks = [];
			this.state.loading = false;
			this.refresh();
			return;
		}
		const nonce = ++this.fetchNonce;
		this.state.loading = true;
		this.state.error = null;
		this.refresh();
		try {
			const result = await this.api.listAdminHomeworks(
				{ ...this.state.filters, student_id: target.userId, page: this.state.currentPage },
				this.cts.token,
			);
			if (nonce !== this.fetchNonce) { return; }
			this.state.homeworks = result.data;
			this.state.currentPage = result.current_page;
			this.state.lastPage = result.last_page;
			this.state.loading = false;
			this.refresh();
		} catch (err) {
			if (nonce !== this.fetchNonce) { return; }
			this.state.loading = false;
			this.state.error = err instanceof ApiError ? err : new ApiError({ status: 0, message: String(err) });
			this.refresh();
		}
	}

	private async fetchSubmissions(): Promise<void> {
		const hw = this.state.selectedHomework;
		if (!hw) { return; }
		const nonce = ++this.fetchNonce;
		this.state.submissionsLoading = true;
		this.state.submissionsError = null;
		this.refresh();
		try {
			const result = await this.api.listAdminSubmissions(hw.id, { ...this.state.submissionFilters, page: this.state.submissionsPage }, this.cts.token);
			if (nonce !== this.fetchNonce) { return; }
			this.state.submissions = result.data;
			this.state.submissionsPage = result.current_page;
			this.state.submissionsLastPage = result.last_page;
			this.state.submissionsLoading = false;
			this.refresh();
		} catch (err) {
			if (nonce !== this.fetchNonce) { return; }
			this.state.submissionsLoading = false;
			this.state.submissionsError = err instanceof ApiError ? err : new ApiError({ status: 0, message: String(err) });
			this.refresh();
		}
	}

	private refresh(): void {
		clearNode(this.parent);
		const inner = append(this.parent, $('.nourlms-hw-screen__inner'));

		this.renderBanner(inner);

		if (!this.targetStudentService.current) {
			appendEmptyRow(inner,
				localize('nourlms.homework.admin.assigned.noTarget.title', "Pick a student"),
				localize('nourlms.homework.admin.assigned.noTarget.detail', "Open a student workspace from the Student Workspaces sidebar to view their assigned homework."),
				Codicon.account);
			return;
		}

		this.renderToolbar(inner);

		if (this.state.loading && this.state.homeworks.length === 0) {
			appendLoadingRow(inner);
			return;
		}
		if (this.state.error && this.state.homeworks.length === 0) {
			appendErrorRow(inner, this.state.error.toString());
			return;
		}

		this.renderHomeworkList(inner);

		if (this.state.selectedHomework) {
			this.renderSubmissionsSection(inner);
		}
	}

	private renderBanner(parent: HTMLElement): void {
		const target = this.targetStudentService.current;
		const banner = append(parent, $('.nourlms-hw-banner'));
		const avatar = append(banner, $('.nourlms-hw-banner__avatar'));
		const meta = append(banner, $('div'));
		const label = append(meta, $('.nourlms-hw-banner__label'));
		const name = append(meta, $('.nourlms-hw-banner__name'));
		if (target) {
			avatar.textContent = initials(target.name);
			label.textContent = localize('nourlms.homework.admin.assigned.viewing', "Viewing homework for");
			name.textContent = target.name;
		} else {
			banner.classList.add('nourlms-hw-banner--muted');
			avatar.textContent = '?';
			label.textContent = localize('nourlms.homework.admin.assigned.noTarget.label', "No target");
			name.textContent = localize('nourlms.homework.admin.assigned.noTarget', "No student selected");
		}
	}

	private renderToolbar(parent: HTMLElement): void {
		const toolbar = append(parent, $('.nourlms-hw-toolbar'));
		const row = append(toolbar, $('.nourlms-hw-toolbar__row'));

		const statusSelect = append(row, $<HTMLSelectElement>('select.nourlms-hw-select'));
		statusSelect.title = localize('nourlms.homework.filter.status', "Status");
		[
			{ v: '', l: localize('nourlms.homework.filter.status.all', "All statuses") },
			{ v: 'pending', l: localize('nourlms.homework.filter.status.pending', "Pending") },
			{ v: 'corrected', l: localize('nourlms.homework.filter.status.corrected', "Corrected") },
		].forEach(o => {
			const opt = append(statusSelect, $<HTMLOptionElement>('option'));
			opt.value = o.v;
			opt.textContent = o.l;
		});
		if (this.state.filters.status) { statusSelect.value = this.state.filters.status; }
		statusSelect.addEventListener('change', () => {
			this.state.filters.status = (statusSelect.value || undefined) as 'pending' | 'corrected' | undefined;
			this.state.currentPage = 1;
			this.fetchHomeworks();
		});

		const aiSelect = append(row, $<HTMLSelectElement>('select.nourlms-hw-select'));
		aiSelect.title = localize('nourlms.homework.filter.aiGraded', "AI graded");
		[
			{ v: '', l: localize('nourlms.homework.filter.aiGraded.all', "Any") },
			{ v: 'true', l: localize('nourlms.homework.filter.aiGraded.yes', "AI graded") },
			{ v: 'false', l: localize('nourlms.homework.filter.aiGraded.no', "Not AI graded") },
		].forEach(o => {
			const opt = append(aiSelect, $<HTMLOptionElement>('option'));
			opt.value = o.v;
			opt.textContent = o.l;
		});
		if (this.state.filters.is_ai_graded !== undefined) { aiSelect.value = String(this.state.filters.is_ai_graded); }
		aiSelect.addEventListener('change', () => {
			const v = aiSelect.value;
			this.state.filters.is_ai_graded = v === 'true' ? true : v === 'false' ? false : undefined;
			this.state.currentPage = 1;
			this.fetchHomeworks();
		});
	}

	private renderHomeworkList(parent: HTMLElement): void {
		if (this.state.homeworks.length === 0 && !this.state.loading) {
			const isFiltered = !!(this.state.filters.status || this.state.filters.is_ai_graded !== undefined);
			appendEmptyRow(parent,
				isFiltered
					? localize('nourlms.homework.admin.assigned.empty.filtered', "No matches")
					: localize('nourlms.homework.admin.assigned.empty.none', "Nothing assigned yet"),
				isFiltered
					? localize('nourlms.homework.admin.assigned.empty.filtered.hint', "No homework matches the current filters.")
					: localize('nourlms.homework.admin.assigned.empty.none.hint', "Use the Question Bank to assign homework to this student."),
				Codicon.book);
			return;
		}

		const list = append(parent, $('.nourlms-hw-list'));
		for (const hw of this.state.homeworks) {
			const card = append(list, $('.nourlms-hw-card'));
			if (this.state.selectedHomework?.id === hw.id) { card.classList.add('is-selected'); }
			if (hw.is_corrected) { card.classList.add('is-corrected'); }

			const iconWrap = append(card, $('.nourlms-hw-card__icon'));
			const icon = append(iconWrap, $('span'));
			icon.classList.add(...ThemeIcon.asClassNameArray(hw.is_corrected ? Codicon.check : Codicon.book));

			const body = append(card, $('.nourlms-hw-card__body'));
			const title = append(body, $('.nourlms-hw-card__title'));
			title.textContent = shortQuestionPreview(hw.question, hw.question?.id ?? hw.question_id ?? hw.id);

			const meta = append(body, $('.nourlms-hw-card__meta'));
			const statusPill = append(meta, $('span.nourlms-hw-pill'));
			if (hw.is_corrected) {
				statusPill.classList.add('nourlms-hw-pill--corrected');
				statusPill.textContent = localize('nourlms.homework.status.corrected', "Corrected");
			} else {
				statusPill.classList.add('nourlms-hw-pill--pending');
				statusPill.textContent = localize('nourlms.homework.status.pending', "Pending");
			}
			if (hw.question?.is_auto_correct) {
				const ai = append(meta, $('span.nourlms-hw-pill.nourlms-hw-pill--ai'));
				ai.textContent = localize('nourlms.homework.aiAutoGrade', "AI");
			}
			const date = append(meta, $('span'));
			date.textContent = formatDate(hw.created_at);

			card.addEventListener('click', () => {
				this.state.selectedHomework = hw;
				this.state.submissions = [];
				this.state.submissionsPage = 1;
				this.refresh();
				this.fetchSubmissions();
			});
		}

		if (this.state.currentPage < this.state.lastPage) {
			const more = append(list, $('.nourlms-hw-loadmore'));
			more.textContent = localize('nourlms.homework.loadMore', "Load more…");
			more.addEventListener('click', () => {
				this.state.currentPage++;
				this.fetchHomeworks();
			});
		}
	}

	private renderSubmissionsSection(parent: HTMLElement): void {
		const hw = this.state.selectedHomework!;
		const section = append(parent, $('.nourlms-hw-section'));

		const heading = append(section, $('.nourlms-hw-section__title'));
		const headingTitle = append(heading, $('span'));
		headingTitle.textContent = localize('nourlms.homework.admin.assigned.submissions', "Submissions");

		this.renderSubmissionFilters(section);

		const body = append(section, $('.nourlms-hw-sublist'));

		if (this.state.submissionsLoading && this.state.submissions.length === 0) {
			appendLoadingRow(body);
			return;
		}
		if (this.state.submissionsError) {
			appendErrorRow(body, this.state.submissionsError.toString());
			return;
		}
		if (this.state.submissions.length === 0) {
			const empty = append(body, $('.nourlms-hw-empty'));
			const t = append(empty, $('.nourlms-hw-empty__title'));
			t.textContent = localize('nourlms.homework.admin.assigned.submissions.empty', "No submissions yet.");
			return;
		}

		for (const sub of this.state.submissions) {
			const row = append(body, $('.nourlms-hw-sub'));
			const main = append(row, $('.nourlms-hw-sub__main'));
			const id = append(main, $('.nourlms-hw-sub__id'));
			id.textContent = `#${sub.id}`;
			const date = append(main, $('.nourlms-hw-sub__date'));
			date.textContent = sub.is_corrected
				? `${formatDate(sub.submitted_at)} · ${localize('nourlms.homework.admin.submission.corrected', "Corrected")}`
				: formatDate(sub.submitted_at);

			const badges = append(row, $('.nourlms-hw-sub__badges'));
			if (sub.latest_ai_result_id !== null && sub.latest_ai_result_id !== undefined) {
				const badge = append(badges, $('span.nourlms-hw-pill.nourlms-hw-pill--ready'));
				badge.textContent = localize('nourlms.homework.admin.aiReady', "AI Ready");
			}

			const arrow = append(row, $('span.nourlms-hw-sub__arrow'));
			arrow.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));

			row.addEventListener('click', () => {
				this.ctx.push({
					kind: 'submission',
					homeworkId: hw.id,
					submissionId: sub.id,
					isAdmin: true,
					preloaded: sub,
				}, localize('nourlms.homework.page.submission', "Submission #{0}", String(sub.id)));
			});
		}

		if (this.state.submissionsPage < this.state.submissionsLastPage) {
			const more = append(body, $('.nourlms-hw-loadmore'));
			more.textContent = localize('nourlms.homework.loadMore', "Load more…");
			more.addEventListener('click', () => {
				this.state.submissionsPage++;
				this.fetchSubmissions();
			});
		}
	}

	private renderSubmissionFilters(parent: HTMLElement): void {
		const filterBar = append(parent, $('.nourlms-hw-toolbar__row'));
		filterBar.style.padding = '8px 0';

		const correctedSelect = append(filterBar, $<HTMLSelectElement>('select.nourlms-hw-select'));
		correctedSelect.title = localize('nourlms.homework.filter.corrected', "Corrected");
		[
			{ v: '', l: localize('nourlms.homework.filter.corrected.all', "All") },
			{ v: 'true', l: localize('nourlms.homework.filter.corrected.yes', "Corrected") },
			{ v: 'false', l: localize('nourlms.homework.filter.corrected.no', "Not corrected") },
		].forEach(o => {
			const opt = append(correctedSelect, $<HTMLOptionElement>('option'));
			opt.value = o.v;
			opt.textContent = o.l;
		});
		if (this.state.submissionFilters.is_corrected !== undefined) { correctedSelect.value = String(this.state.submissionFilters.is_corrected); }
		correctedSelect.addEventListener('change', () => {
			const v = correctedSelect.value;
			this.state.submissionFilters.is_corrected = v === 'true' ? true : v === 'false' ? false : undefined;
			this.state.submissionsPage = 1;
			this.fetchSubmissions();
		});

		const aiSelect = append(filterBar, $<HTMLSelectElement>('select.nourlms-hw-select'));
		aiSelect.title = localize('nourlms.homework.filter.hasAiResult', "Has AI result");
		[
			{ v: '', l: localize('nourlms.homework.filter.hasAiResult.all', "All") },
			{ v: 'true', l: localize('nourlms.homework.filter.hasAiResult.yes', "Has AI result") },
			{ v: 'false', l: localize('nourlms.homework.filter.hasAiResult.no', "No AI result") },
		].forEach(o => {
			const opt = append(aiSelect, $<HTMLOptionElement>('option'));
			opt.value = o.v;
			opt.textContent = o.l;
		});
		if (this.state.submissionFilters.has_ai_result !== undefined) { aiSelect.value = String(this.state.submissionFilters.has_ai_result); }
		aiSelect.addEventListener('change', () => {
			const v = aiSelect.value;
			this.state.submissionFilters.has_ai_result = v === 'true' ? true : v === 'false' ? false : undefined;
			this.state.submissionsPage = 1;
			this.fetchSubmissions();
		});
	}
}
