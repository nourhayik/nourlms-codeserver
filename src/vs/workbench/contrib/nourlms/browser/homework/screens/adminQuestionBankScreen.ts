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
import { Delayer } from '../../../../../../base/common/async.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { INourlmsHomeworkApi, ApiError, QuestionListFilters } from '../nourlmsHomeworkApi.js';
import { INourlmsHomeworkTargetStudentService } from '../nourlmsHomeworkTargetStudent.js';
import { IHomeworkScreen, ScreenContext } from '../nourlmsHomeworkRouter.js';
import type { Question, Course, Subject, DifficultyRate, QuestionTypeLookup } from '../types.js';
import { appendEmptyRow, appendErrorRow, appendLoadingRow, getQuestionTypeKey, initials, isCodeQuestion, shortQuestionPreview } from './screenUtils.js';

interface State {
	questions: Question[];
	currentPage: number;
	lastPage: number;
	loading: boolean;
	error: ApiError | null;
	filters: QuestionListFilters;
	selectedIds: Set<number>;
	assigning: boolean;
	assignError: ApiError | null;
	courses: Course[];           // current student's courses (admin filter source)
	allCourses: Course[];        // full course list (fallback when student courses can't be resolved)
	subjects: Subject[];
	difficultyRates: DifficultyRate[];
	questionTypes: QuestionTypeLookup[];
	studentCoursesLoaded: boolean;
	studentCoursesError: ApiError | null;
	scopeToStudent: boolean;     // toggles the "limit by student courses" filter
}

export class AdminQuestionBankScreen extends Disposable implements IHomeworkScreen {

	private parent!: HTMLElement;
	private ctx!: ScreenContext;
	private cts = this._register(new CancellationTokenSource());
	private fetchNonce = 0;
	private readonly searchDelayer = this._register(new Delayer<void>(300));

	private state: State = {
		questions: [],
		currentPage: 1,
		lastPage: 1,
		loading: false,
		error: null,
		filters: {},
		selectedIds: new Set(),
		assigning: false,
		assignError: null,
		courses: [],
		allCourses: [],
		subjects: [],
		difficultyRates: [],
		questionTypes: [],
		studentCoursesLoaded: false,
		studentCoursesError: null,
		scopeToStudent: true,
	};

	constructor(
		@INourlmsHomeworkApi private readonly api: INourlmsHomeworkApi,
		@INourlmsHomeworkTargetStudentService private readonly targetStudentService: INourlmsHomeworkTargetStudentService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
	}

	mount(parent: HTMLElement, ctx: ScreenContext): void {
		this.parent = parent;
		this.ctx = ctx;
		parent.classList.add('nourlms-hw-screen', 'nourlms-hw-screen--scroll');

		this._register(this.targetStudentService.onDidChange(() => {
			this.state.studentCoursesLoaded = false;
			this.state.courses = [];
			this.state.filters.course_id = undefined;
			this.state.filters.subject_id = undefined;
			this.state.currentPage = 1;
			this.fetchStudentCourses();
		}));

		this.fetchLookupData();
		this.fetchStudentCourses();
		this.fetchQuestions();
	}

	private async fetchLookupData(): Promise<void> {
		try {
			const [allCourses, subjects, diffs, types] = await Promise.all([
				this.api.listCourses({}, this.cts.token),
				this.api.listSubjects({}, this.cts.token),
				this.api.listDifficultyRates(this.cts.token),
				this.api.listQuestionTypes(this.cts.token),
			]);
			this.state.allCourses = allCourses;
			this.state.subjects = subjects;
			this.state.difficultyRates = diffs;
			this.state.questionTypes = types;
			this.refresh();
		} catch { /* lookups optional */ }
	}

	private async fetchStudentCourses(): Promise<void> {
		const target = this.targetStudentService.current;
		if (!target) {
			this.state.studentCoursesLoaded = true;
			this.refresh();
			return;
		}
		this.state.studentCoursesError = null;
		try {
			const courses = await this.api.listAdminStudentCourses(target.userId, this.cts.token);
			this.state.courses = courses;
			this.state.studentCoursesLoaded = true;
			this.refresh();
		} catch (err) {
			this.state.studentCoursesLoaded = true;
			this.state.studentCoursesError = err instanceof ApiError ? err : new ApiError({ status: 0, message: String(err) });
			this.refresh();
		}
	}

	private effectiveCourseFilter(): number[] | undefined {
		if (!this.state.scopeToStudent) { return undefined; }
		const target = this.targetStudentService.current;
		if (!target) { return undefined; }
		if (this.state.courses.length === 0) { return undefined; }
		return this.state.courses.map(c => c.id);
	}

	private async fetchQuestions(): Promise<void> {
		const nonce = ++this.fetchNonce;
		this.state.loading = true;
		this.state.error = null;
		this.refresh();

		try {
			const result = await this.api.listQuestions(
				{ ...this.state.filters, page: this.state.currentPage },
				this.cts.token,
			);
			if (nonce !== this.fetchNonce) { return; }

			let data = result.data;
			const allowedCourses = this.effectiveCourseFilter();
			if (allowedCourses !== undefined && this.state.filters.course_id === undefined) {
				const set = new Set(allowedCourses);
				data = data.filter(q => set.has(q.course_id));
			}

			this.state.questions = data;
			this.state.currentPage = result.current_page;
			this.state.lastPage = result.last_page;
			this.state.loading = false;
			this.refresh();
		} catch (err) {
			if (nonce !== this.fetchNonce) { return; }
			this.state.error = err instanceof ApiError ? err : new ApiError({ status: 0, message: String(err) });
			this.state.loading = false;
			this.refresh();
		}
	}

	private canAssignSelected(): { enabled: boolean; tooltip: string } {
		if (this.state.selectedIds.size === 0) {
			return { enabled: false, tooltip: localize('nourlms.homework.admin.bank.assign.noSelection', "Select at least one question.") };
		}
		const target = this.targetStudentService.current;
		if (!target) {
			return { enabled: false, tooltip: localize('nourlms.homework.admin.bank.assign.disabled.noStudent', "Open a student workspace to assign homework.") };
		}
		const selected = this.state.questions.filter(q => this.state.selectedIds.has(q.id));
		const hasNonCode = selected.some(q => !isCodeQuestion(q));
		if (hasNonCode) {
			return { enabled: false, tooltip: localize('nourlms.homework.admin.bank.assign.disabled.notCode', "Only code questions can be assigned from this panel.") };
		}
		return { enabled: true, tooltip: localize('nourlms.homework.admin.bank.assign.tooltip', "Assign to current student") };
	}

	private async assignSelected(): Promise<void> {
		const target = this.targetStudentService.current;
		if (!target) { return; }
		const { enabled } = this.canAssignSelected();
		if (!enabled) { return; }

		this.state.assigning = true;
		this.state.assignError = null;
		this.refresh();
		try {
			const requested = this.state.selectedIds.size;
			const result = await this.api.assignHomework(
				{ user_ids: [target.userId], question_ids: Array.from(this.state.selectedIds) },
				this.cts.token,
			);
			this.state.assigning = false;
			this.state.selectedIds.clear();
			const created = result.created_count;
			if (created === 0) {
				this.notificationService.info(localize('nourlms.homework.admin.bank.assign.alreadyAssigned', "Already assigned."));
			} else {
				const already = requested - created;
				this.notificationService.info(localize('nourlms.homework.admin.bank.assign.success', "Assigned {0} ({1} already assigned)", created, already));
			}
			this.fetchQuestions();
		} catch (err) {
			this.state.assigning = false;
			this.state.assignError = err instanceof ApiError ? err : new ApiError({ status: 0, message: String(err) });
			this.refresh();
		}
	}

	private refresh(): void {
		clearNode(this.parent);
		const inner = append(this.parent, $('.nourlms-hw-screen__inner'));

		this.renderBanner(inner);
		this.renderToolbar(inner);
		this.renderActionBar(inner);

		if (this.state.assignError) {
			appendErrorRow(inner, this.state.assignError.toString());
		}

		if (this.state.loading && this.state.questions.length === 0) {
			appendLoadingRow(inner);
			return;
		}

		if (this.state.error && this.state.questions.length === 0) {
			appendErrorRow(inner, this.state.error.toString());
			return;
		}

		if (this.state.questions.length === 0) {
			const hasFilter = !!(this.state.filters.search || this.state.filters.course_id || this.state.filters.subject_id || this.state.filters.difficulty_id || this.state.filters.type_id) || this.state.scopeToStudent;
			appendEmptyRow(inner,
				hasFilter
					? localize('nourlms.homework.admin.bank.empty.filtered', "No matches")
					: localize('nourlms.homework.admin.bank.empty.none', "Question bank is empty"),
				hasFilter
					? localize('nourlms.homework.admin.bank.empty.filtered.hint', "Try clearing filters or unscope from the current student.")
					: localize('nourlms.homework.admin.bank.empty.none.hint', "Create your first code question to get started."),
				Codicon.search);
			return;
		}

		this.renderList(inner);
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
			label.textContent = localize('nourlms.homework.admin.bank.targetLabel', "Target student");
			name.textContent = target.name;
		} else {
			banner.classList.add('nourlms-hw-banner--muted');
			avatar.textContent = '?';
			label.textContent = localize('nourlms.homework.admin.bank.target.label', "No target");
			name.textContent = localize('nourlms.homework.admin.bank.noTarget', "Open a student workspace");
		}

		if (target) {
			const scope = append(banner, $<HTMLLabelElement>('label.nourlms-hw-banner__scope'));
			const cb = append(scope, $<HTMLInputElement>('input'));
			cb.type = 'checkbox';
			cb.checked = this.state.scopeToStudent;
			cb.addEventListener('change', () => {
				this.state.scopeToStudent = cb.checked;
				this.state.currentPage = 1;
				this.fetchQuestions();
			});
			const sLabel = append(scope, $('span'));
			sLabel.textContent = localize('nourlms.homework.admin.bank.scopeToStudent', "Limit to {0}'s courses", target.name);
		}
	}

	private renderToolbar(parent: HTMLElement): void {
		const toolbar = append(parent, $('.nourlms-hw-toolbar'));

		const row1 = append(toolbar, $('.nourlms-hw-toolbar__row'));
		const search = append(row1, $<HTMLInputElement>('input.nourlms-hw-search'));
		search.type = 'text';
		search.placeholder = localize('nourlms.homework.admin.bank.search', "Search questions…");
		search.value = this.state.filters.search ?? '';
		search.addEventListener('input', () => {
			this.state.filters.search = search.value || undefined;
			this.state.currentPage = 1;
			this.searchDelayer.trigger(() => this.fetchQuestions());
		});

		const row2 = append(toolbar, $('.nourlms-hw-toolbar__row'));

		const courseSource = this.state.scopeToStudent && this.state.courses.length > 0
			? this.state.courses
			: this.state.allCourses;
		this.appendSelect(row2, localize('nourlms.homework.filter.course', "Course"),
			[{ v: '', l: localize('nourlms.homework.filter.course.all', "All courses") }, ...courseSource.map(c => ({ v: String(c.id), l: c.name }))],
			this.state.filters.course_id !== undefined ? String(this.state.filters.course_id) : '',
			(v) => {
				this.state.filters.course_id = v ? Number(v) : undefined;
				this.state.currentPage = 1;
				this.fetchQuestions();
			});

		this.appendSelect(row2, localize('nourlms.homework.filter.subject', "Subject"),
			[{ v: '', l: localize('nourlms.homework.filter.subject.all', "All subjects") }, ...this.state.subjects
				.filter(s => this.state.filters.course_id === undefined || s.course_id === this.state.filters.course_id)
				.map(s => ({ v: String(s.id), l: s.name }))],
			this.state.filters.subject_id !== undefined ? String(this.state.filters.subject_id) : '',
			(v) => {
				this.state.filters.subject_id = v ? Number(v) : undefined;
				this.state.currentPage = 1;
				this.fetchQuestions();
			});

		this.appendSelect(row2, localize('nourlms.homework.filter.difficulty', "Difficulty"),
			[{ v: '', l: localize('nourlms.homework.filter.difficulty.all', "All difficulties") }, ...this.state.difficultyRates.map(d => ({ v: String(d.id), l: d.name }))],
			this.state.filters.difficulty_id !== undefined ? String(this.state.filters.difficulty_id) : '',
			(v) => {
				this.state.filters.difficulty_id = v ? Number(v) : undefined;
				this.state.currentPage = 1;
				this.fetchQuestions();
			});

		this.appendSelect(row2, localize('nourlms.homework.filter.type', "Question type"),
			[{ v: '', l: localize('nourlms.homework.filter.type.all', "All types") }, ...this.state.questionTypes.map(t => ({ v: String(t.id), l: t.key }))],
			this.state.filters.type_id !== undefined ? String(this.state.filters.type_id) : '',
			(v) => {
				this.state.filters.type_id = v ? Number(v) : undefined;
				this.state.currentPage = 1;
				this.fetchQuestions();
			});
	}

	private appendSelect(parent: HTMLElement, title: string, options: { v: string; l: string }[], value: string, onChange: (v: string) => void): void {
		const select = append(parent, $<HTMLSelectElement>('select.nourlms-hw-select'));
		select.title = title;
		for (const o of options) {
			const opt = append(select, $<HTMLOptionElement>('option'));
			opt.value = o.v;
			opt.textContent = o.l;
			if (o.v === value) { opt.selected = true; }
		}
		select.addEventListener('change', () => onChange(select.value));
	}

	private renderActionBar(parent: HTMLElement): void {
		const bar = append(parent, $('.nourlms-hw-actionbar'));

		const newBtn = append(bar, $<HTMLButtonElement>('button.nourlms-hw-button.nourlms-hw-button--ghost'));
		newBtn.type = 'button';
		const newIcon = append(newBtn, $('span'));
		newIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		const newLabel = append(newBtn, $('span'));
		newLabel.textContent = localize('nourlms.homework.admin.bank.newQuestion', "New question");
		newBtn.addEventListener('click', () => {
			this.ctx.push({ kind: 'newQuestion' }, localize('nourlms.homework.home.admin.newQuestion.title', "New Question"));
		});

		append(bar, $('.nourlms-hw-actionbar__spacer'));

		if (this.state.selectedIds.size > 0) {
			const count = append(bar, $('span.nourlms-hw-actionbar__count'));
			count.textContent = localize('nourlms.homework.admin.bank.selectedCount', "{0} selected", this.state.selectedIds.size);
		}

		const { enabled, tooltip } = this.canAssignSelected();
		const assignBtn = append(bar, $<HTMLButtonElement>('button.nourlms-hw-button'));
		assignBtn.type = 'button';
		const assignIcon = append(assignBtn, $('span'));
		assignIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.send));
		const assignLabel = append(assignBtn, $('span'));
		assignLabel.textContent = this.state.assigning
			? localize('nourlms.homework.admin.bank.assigning', "Assigning…")
			: localize('nourlms.homework.admin.bank.assign', "Assign to current student");
		assignBtn.disabled = !enabled || this.state.assigning;
		assignBtn.title = tooltip;
		assignBtn.addEventListener('click', () => this.assignSelected());
	}

	private renderList(parent: HTMLElement): void {
		const list = append(parent, $('.nourlms-hw-list'));

		for (const q of this.state.questions) {
			const card = append(list, $('.nourlms-hw-card'));
			if (this.state.selectedIds.has(q.id)) { card.classList.add('is-selected'); }

			const cb = append(card, $<HTMLInputElement>('input.nourlms-hw-card__check'));
			cb.type = 'checkbox';
			cb.checked = this.state.selectedIds.has(q.id);
			cb.addEventListener('click', e => e.stopPropagation());
			cb.addEventListener('change', () => {
				if (cb.checked) { this.state.selectedIds.add(q.id); }
				else { this.state.selectedIds.delete(q.id); }
				// Re-render only the action bar count + assign state
				this.refresh();
			});

			const body = append(card, $('.nourlms-hw-card__body'));
			body.addEventListener('click', () => {
				this.ctx.push({ kind: 'adminQuestion', questionId: q.id },
					localize('nourlms.homework.page.question', "Question #{0}", String(q.id)));
			});

			const title = append(body, $('.nourlms-hw-card__title'));
			title.textContent = shortQuestionPreview(q);

			const meta = append(body, $('.nourlms-hw-card__meta'));
			const typeBadge = append(meta, $('span.nourlms-hw-pill'));
			typeBadge.classList.add(isCodeQuestion(q) ? 'nourlms-hw-pill--code' : 'nourlms-hw-pill--type');
			typeBadge.textContent = getQuestionTypeKey(q) ?? localize('nourlms.homework.unknownType', "Question");

			const weight = append(meta, $('span'));
			weight.textContent = localize('nourlms.homework.weight', "Weight: {0}", String(q.weight ?? 0));

			if (q.is_auto_correct) {
				const ai = append(meta, $('span.nourlms-hw-pill.nourlms-hw-pill--ai'));
				ai.textContent = localize('nourlms.homework.aiAutoGrade', "AI");
			}
		}

		if (this.state.currentPage < this.state.lastPage) {
			const more = append(list, $('.nourlms-hw-loadmore'));
			more.textContent = localize('nourlms.homework.loadMore', "Load more…");
			more.addEventListener('click', () => {
				this.state.currentPage++;
				this.fetchQuestions();
			});
		}
	}
}
