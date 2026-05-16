/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../../nls.js';
import { append, $, clearNode } from '../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Delayer } from '../../../../../../base/common/async.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { INourlmsAuthService } from '../../../../../services/nourlms/common/nourlms.js';
import { INourlmsHomeworkApi, ApiError, StudentHomeworkListFilters } from '../nourlmsHomeworkApi.js';
import { IHomeworkScreen, ScreenContext } from '../nourlmsHomeworkRouter.js';
import type { Homework, Course } from '../types.js';
import { appendEmptyRow, appendErrorRow, appendLoadingRow, formatDate, shortQuestionPreview } from './screenUtils.js';

interface StudentState {
	homeworks: Homework[];
	currentPage: number;
	lastPage: number;
	loading: boolean;
	error: ApiError | null;
	filters: StudentHomeworkListFilters;
	courses: Course[];
}

export class HomeScreen extends Disposable implements IHomeworkScreen {

	private parent!: HTMLElement;
	private ctx!: ScreenContext;
	private cts = this._register(new CancellationTokenSource());
	private fetchNonce = 0;
	private readonly searchDelayer = this._register(new Delayer<void>(300));

	private studentState: StudentState = {
		homeworks: [],
		currentPage: 1,
		lastPage: 1,
		loading: false,
		error: null,
		filters: {},
		courses: [],
	};

	constructor(
		@INourlmsHomeworkApi private readonly api: INourlmsHomeworkApi,
		@INourlmsAuthService private readonly authService: INourlmsAuthService,
	) {
		super();
	}

	mount(parent: HTMLElement, ctx: ScreenContext): void {
		this.parent = parent;
		this.ctx = ctx;
		parent.classList.add('nourlms-hw-screen', 'nourlms-hw-screen--scroll');

		if (ctx.userInfo.role === 'admin') {
			this.renderAdminLanding();
		} else {
			this.fetchStudentCourses();
			this.fetchStudentHomeworks();
		}
		void this.authService;
	}

	private renderAdminLanding(): void {
		clearNode(this.parent);
		const wrap = append(this.parent, $('.nourlms-hw-home'));

		const title = append(wrap, $('h2.nourlms-hw-home__title'));
		title.textContent = localize('nourlms.homework.home.admin.title', "Homework");

		const sub = append(wrap, $('p.nourlms-hw-home__sub'));
		sub.textContent = localize('nourlms.homework.home.admin.sub', "Browse the question bank, assign questions, and review student submissions.");

		const grid = append(wrap, $('.nourlms-hw-home__grid'));

		this.makeAdminCard(grid, Codicon.book, localize('nourlms.homework.home.admin.bank.title', "Question Bank"),
			localize('nourlms.homework.home.admin.bank.desc', "Search, filter, create, and assign questions."),
			() => this.ctx.push({ kind: 'adminQuestionBank' }, localize('nourlms.homework.home.admin.bank.title', "Question Bank")));

		this.makeAdminCard(grid, Codicon.checklist, localize('nourlms.homework.home.admin.assigned.title', "Assigned to Current Student"),
			localize('nourlms.homework.home.admin.assigned.desc', "Review homeworks assigned to the student whose workspace is open."),
			() => this.ctx.push({ kind: 'adminAssigned' }, localize('nourlms.homework.home.admin.assigned.title', "Assigned to Current Student")));

		this.makeAdminCard(grid, Codicon.add, localize('nourlms.homework.home.admin.newQuestion.title', "New Question"),
			localize('nourlms.homework.home.admin.newQuestion.desc', "Create a new code question — manually or via an AI prompt."),
			() => this.ctx.push({ kind: 'newQuestion' }, localize('nourlms.homework.home.admin.newQuestion.title', "New Question")));
	}

	private makeAdminCard(parent: HTMLElement, icon: ThemeIcon, title: string, desc: string, onClick: () => void): void {
		const card = append(parent, $<HTMLButtonElement>('button.nourlms-hw-home__card'));
		card.type = 'button';
		const iconEl = append(card, $('.nourlms-hw-home__card-icon'));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(icon));
		const titleEl = append(card, $('.nourlms-hw-home__card-title'));
		titleEl.textContent = title;
		const descEl = append(card, $('.nourlms-hw-home__card-desc'));
		descEl.textContent = desc;
		card.addEventListener('click', onClick);
	}

	private async fetchStudentCourses(): Promise<void> {
		try {
			const courses = await this.api.listStudentHomeworkCourses(this.cts.token);
			this.studentState.courses = courses;
			this.renderStudent();
		} catch {
			// ignore - filter dropdown is optional
		}
	}

	private async fetchStudentHomeworks(): Promise<void> {
		const nonce = ++this.fetchNonce;
		this.studentState.loading = true;
		this.studentState.error = null;
		this.renderStudent();

		try {
			const result = await this.api.listStudentHomeworks(
				{ ...this.studentState.filters, page: this.studentState.currentPage },
				this.cts.token,
			);
			if (nonce !== this.fetchNonce) { return; }
			this.studentState.homeworks = result.data;
			this.studentState.currentPage = result.current_page;
			this.studentState.lastPage = result.last_page;
			this.studentState.loading = false;
			this.renderStudent();
		} catch (err) {
			if (nonce !== this.fetchNonce) { return; }
			this.studentState.error = err instanceof ApiError ? err : new ApiError({ status: 0, message: String(err) });
			this.studentState.loading = false;
			this.renderStudent();
		}
	}

	private renderStudent(): void {
		clearNode(this.parent);
		const wrap = append(this.parent, $('.nourlms-hw-screen__inner'));

		const heading = append(wrap, $('h2.nourlms-hw-screen__title'));
		heading.textContent = localize('nourlms.homework.home.student.title', "My Homework");

		this.renderStudentToolbar(wrap);

		const list = append(wrap, $('.nourlms-hw-list'));

		if (this.studentState.loading && this.studentState.homeworks.length === 0) {
			appendLoadingRow(list);
			return;
		}

		if (this.studentState.error && this.studentState.homeworks.length === 0) {
			appendErrorRow(list, this.studentState.error.toString());
			return;
		}

		if (this.studentState.homeworks.length === 0) {
			const isFiltered = Object.values(this.studentState.filters).some(v => v !== undefined);
			appendEmptyRow(list,
				isFiltered
					? localize('nourlms.homework.home.student.empty.filtered', "No matching homework")
					: localize('nourlms.homework.home.student.empty.none', "All caught up"),
				isFiltered
					? localize('nourlms.homework.home.student.empty.filtered.hint', "No homework matches the current filters.")
					: localize('nourlms.homework.home.student.empty.none.hint', "You have no assigned homework yet."),
				Codicon.book);
			return;
		}

		for (const hw of this.studentState.homeworks) {
			this.renderStudentHomeworkCard(list, hw);
		}

		if (this.studentState.currentPage < this.studentState.lastPage) {
			const more = append(list, $('.nourlms-hw-loadmore'));
			more.textContent = localize('nourlms.homework.loadMore', "Load more…");
			more.addEventListener('click', () => {
				this.studentState.currentPage++;
				this.fetchStudentHomeworks();
			});
		}
	}

	private renderStudentToolbar(parent: HTMLElement): void {
		const toolbar = append(parent, $('.nourlms-hw-toolbar'));
		const row = append(toolbar, $('.nourlms-hw-toolbar__row'));

		const search = append(row, $<HTMLInputElement>('input.nourlms-hw-search'));
		search.type = 'text';
		search.placeholder = localize('nourlms.homework.home.student.search', "Search homeworks…");
		search.addEventListener('input', () => {
			this.searchDelayer.trigger(() => {
				const q = search.value.trim().toLowerCase();
				if (q === '') {
					this.fetchStudentHomeworks();
				} else {
					// client-side filter: just filter the visible list
					this.renderStudent();
					const list = this.parent.querySelector('.nourlms-hw-list');
					if (list) {
						clearNode(list as HTMLElement);
						const filtered = this.studentState.homeworks.filter(hw =>
							(hw.question?.content ?? '').toLowerCase().includes(q),
						);
						if (filtered.length === 0) {
							appendEmptyRow(list as HTMLElement,
								localize('nourlms.homework.home.student.search.noMatch', "No matches"),
								localize('nourlms.homework.home.student.search.noMatch.hint', "Try a different search."),
								Codicon.search);
						} else {
							for (const hw of filtered) {
								this.renderStudentHomeworkCard(list as HTMLElement, hw);
							}
						}
					}
				}
			});
		});

		if (this.studentState.courses.length > 0) {
			const courseSelect = append(row, $<HTMLSelectElement>('select.nourlms-hw-select'));
			courseSelect.title = localize('nourlms.homework.filter.course', "Course");
			const def = append(courseSelect, $<HTMLOptionElement>('option'));
			def.value = '';
			def.textContent = localize('nourlms.homework.filter.course.all', "All courses");
			for (const course of this.studentState.courses) {
				const opt = append(courseSelect, $<HTMLOptionElement>('option'));
				opt.value = String(course.id);
				opt.textContent = course.name;
				if (this.studentState.filters.course_id === course.id) { opt.selected = true; }
			}
			courseSelect.addEventListener('change', () => {
				const v = courseSelect.value;
				this.studentState.filters.course_id = v ? Number(v) : undefined;
				this.studentState.currentPage = 1;
				this.fetchStudentHomeworks();
			});
		}

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
		if (this.studentState.filters.status) { statusSelect.value = this.studentState.filters.status; }
		statusSelect.addEventListener('change', () => {
			this.studentState.filters.status = (statusSelect.value || undefined) as 'pending' | 'corrected' | undefined;
			this.studentState.currentPage = 1;
			this.fetchStudentHomeworks();
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
		if (this.studentState.filters.is_ai_graded !== undefined) { aiSelect.value = String(this.studentState.filters.is_ai_graded); }
		aiSelect.addEventListener('change', () => {
			const v = aiSelect.value;
			this.studentState.filters.is_ai_graded = v === 'true' ? true : v === 'false' ? false : undefined;
			this.studentState.currentPage = 1;
			this.fetchStudentHomeworks();
		});
	}

	private renderStudentHomeworkCard(parent: HTMLElement, hw: Homework): void {
		const card = append(parent, $('.nourlms-hw-card'));
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
		const date = append(meta, $('span.nourlms-hw-card__date'));
		date.textContent = formatDate(hw.created_at);

		card.addEventListener('click', () => {
			const qid = hw.question?.id ?? hw.question_id;
			const title = qid !== undefined
				? localize('nourlms.homework.page.question', "Question #{0}", String(qid))
				: localize('nourlms.homework.page.questionUnknown', "Question");
			this.ctx.push({ kind: 'studentHomework', homeworkId: hw.id, preloaded: hw }, title);
		});
	}
}
