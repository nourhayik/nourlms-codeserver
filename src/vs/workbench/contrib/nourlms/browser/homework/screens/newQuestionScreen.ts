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
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { INourlmsHomeworkApi, ApiError, CreateCodeQuestionPayload } from '../nourlmsHomeworkApi.js';
import { INourlmsHomeworkAiService, AiQuestionDraft } from '../nourlmsHomeworkAi.js';
import { INourlmsHomeworkTargetStudentService } from '../nourlmsHomeworkTargetStudent.js';
import { IHomeworkScreen, ScreenContext } from '../nourlmsHomeworkRouter.js';
import type { Course, Subject, DifficultyRate, QuestionTypeLookup } from '../types.js';
import { appendErrorRow, appendLoadingRow } from './screenUtils.js';

interface FormData {
	content: string;
	course_id: number | undefined;
	question_subject_id: number | undefined;
	suggested_subject_name: string | null;
	difficulty_rate_id: number | undefined;
	weight: number;
	is_homework: boolean;
	is_auto_correct: boolean;
	time_in_second: number;
	best_answer: string;
	pre_answer: string;
}

const CODE_TYPE_KEY = 'code';

function emptyForm(): FormData {
	return {
		content: '',
		course_id: undefined,
		question_subject_id: undefined,
		suggested_subject_name: null,
		difficulty_rate_id: undefined,
		weight: 1,
		is_homework: true,
		is_auto_correct: false,
		time_in_second: 0,
		best_answer: '',
		pre_answer: '',
	};
}

export class NewQuestionScreen extends Disposable implements IHomeworkScreen {

	private parent!: HTMLElement;
	private ctx!: ScreenContext;
	private cts = this._register(new CancellationTokenSource());

	private courses: Course[] = [];
	private subjects: Subject[] = [];
	private difficultyRates: DifficultyRate[] = [];
	private questionTypes: QuestionTypeLookup[] = [];
	private lookupsLoading = true;
	private lookupsError: ApiError | null = null;

	private form: FormData = emptyForm();
	private fieldErrors: Record<string, string[]> = {};
	private creating = false;
	private createError: ApiError | null = null;

	private aiPrompt = '';
	private aiBusy = false;
	private aiError: ApiError | null = null;

	private creatingSubject = false;
	private createSubjectError: ApiError | null = null;

	constructor(
		@INourlmsHomeworkApi private readonly api: INourlmsHomeworkApi,
		@INourlmsHomeworkAiService private readonly aiService: INourlmsHomeworkAiService,
		@INotificationService private readonly notificationService: INotificationService,
		@INourlmsHomeworkTargetStudentService private readonly targetStudentService: INourlmsHomeworkTargetStudentService,
	) {
		super();
	}

	mount(parent: HTMLElement, ctx: ScreenContext): void {
		this.parent = parent;
		this.ctx = ctx;
		parent.classList.add('nourlms-hw-screen', 'nourlms-hw-screen--scroll');
		this.refresh();
		this.fetchLookups();
	}

	private async fetchLookups(): Promise<void> {
		const target = this.targetStudentService.current;

		// When a student workspace is open we restrict the course dropdown to
		// the courses that student is enrolled in, so admins can't accidentally
		// pick an unrelated course. If `listAdminStudentCourses` 404s (endpoint
		// not deployed yet) we silently fall back to the full course list.
		const coursesPromise = target
			? this.api.listAdminStudentCourses(target.userId, this.cts.token)
				.catch(async () => this.api.listCourses({}, this.cts.token))
			: this.api.listCourses({}, this.cts.token);

		try {
			const [courses, subjects, diffs, types] = await Promise.all([
				coursesPromise,
				this.api.listSubjects({}, this.cts.token),
				this.api.listDifficultyRates(this.cts.token),
				this.api.listQuestionTypes(this.cts.token),
			]);
			this.courses = courses;
			this.subjects = subjects;
			this.difficultyRates = diffs;
			this.questionTypes = types;
			this.lookupsLoading = false;
			this.refresh();
		} catch (err) {
			this.lookupsLoading = false;
			this.lookupsError = err instanceof ApiError ? err : new ApiError({ status: 0, message: String(err) });
			this.refresh();
		}
	}

	private codeTypeId(): number | undefined {
		return this.questionTypes.find(t => t.key === CODE_TYPE_KEY)?.id;
	}

	private filteredSubjects(): Subject[] {
		if (this.form.course_id === undefined) { return this.subjects; }
		return this.subjects.filter(s => s.course_id === this.form.course_id);
	}

	private validate(): string | null {
		if (!this.form.content.trim()) { return 'content'; }
		if (this.form.course_id === undefined) { return 'course_id'; }
		// subject is required only if there's no suggested name to create
		if (this.form.question_subject_id === undefined && !this.form.suggested_subject_name) { return 'question_subject_id'; }
		if (this.form.difficulty_rate_id === undefined) { return 'difficulty_rate_id'; }
		if (this.form.weight <= 0) { return 'weight'; }
		return null;
	}

	private async generateFromAi(): Promise<void> {
		const prompt = this.aiPrompt.trim();
		if (!prompt) {
			this.aiError = new ApiError({ status: 0, message: localize('nourlms.homework.admin.bank.create.ai.emptyPrompt', "Enter a prompt first.") });
			this.refresh();
			return;
		}
		this.aiBusy = true;
		this.aiError = null;
		this.refresh();

		try {
			const draft = await this.aiService.generateQuestionDraft({
				prompt,
				courses: this.courses,
				subjects: this.subjects,
				difficultyRates: this.difficultyRates,
			}, this.cts.token);
			this.applyDraft(draft);
			this.aiBusy = false;
			this.refresh();
		} catch (err) {
			this.aiBusy = false;
			this.aiError = err instanceof ApiError ? err : new ApiError({ status: 0, message: String(err) });
			this.refresh();
		}
	}

	private applyDraft(d: AiQuestionDraft): void {
		if (typeof d.content === 'string') { this.form.content = d.content; }
		if (typeof d.course_id === 'number') { this.form.course_id = d.course_id; }
		if (typeof d.question_subject_id === 'number') {
			this.form.question_subject_id = d.question_subject_id;
			this.form.suggested_subject_name = null;
		} else if (typeof d.suggested_subject_name === 'string' && d.suggested_subject_name.length > 0) {
			this.form.question_subject_id = undefined;
			this.form.suggested_subject_name = d.suggested_subject_name;
		}
		if (typeof d.difficulty_rate_id === 'number') { this.form.difficulty_rate_id = d.difficulty_rate_id; }
		if (typeof d.weight === 'number') { this.form.weight = d.weight; }
		if (typeof d.is_auto_correct === 'boolean') { this.form.is_auto_correct = d.is_auto_correct; }
		if (typeof d.time_in_second === 'number') { this.form.time_in_second = d.time_in_second; }
		if (typeof d.best_answer === 'string') { this.form.best_answer = d.best_answer; }
		if (typeof d.pre_answer === 'string') { this.form.pre_answer = d.pre_answer; }
	}

	private async createSuggestedSubject(): Promise<void> {
		if (!this.form.suggested_subject_name || this.form.course_id === undefined) { return; }
		this.creatingSubject = true;
		this.createSubjectError = null;
		this.refresh();
		try {
			const subject = await this.api.createSubject({ name: this.form.suggested_subject_name, course_id: this.form.course_id }, this.cts.token);
			this.subjects = [...this.subjects, subject];
			this.form.question_subject_id = subject.id;
			this.form.suggested_subject_name = null;
			this.creatingSubject = false;
			this.notificationService.info(localize('nourlms.homework.admin.bank.create.subjectCreated', "Subject \"{0}\" created.", subject.name));
			this.refresh();
		} catch (err) {
			this.creatingSubject = false;
			this.createSubjectError = err instanceof ApiError ? err : new ApiError({ status: 0, message: String(err) });
			this.refresh();
		}
	}

	private async submit(): Promise<void> {
		const codeTypeId = this.codeTypeId();
		if (codeTypeId === undefined) {
			this.createError = new ApiError({ status: 0, message: localize('nourlms.homework.admin.bank.create.codeTypeMissing', "Code question type is not available yet.") });
			this.refresh();
			return;
		}

		const missing = this.validate();
		if (missing) {
			this.fieldErrors = { [missing]: [localize('nourlms.homework.admin.bank.create.required', "This field is required.")] };
			this.refresh();
			return;
		}

		// If there's a suggested subject not yet created, create it first
		if (this.form.suggested_subject_name && this.form.question_subject_id === undefined) {
			await this.createSuggestedSubject();
			if (this.form.question_subject_id === undefined) { return; }
		}

		const payload: CreateCodeQuestionPayload = {
			content: this.form.content,
			course_id: this.form.course_id!,
			question_subject_id: this.form.question_subject_id!,
			difficulty_rate_id: this.form.difficulty_rate_id!,
			weight: this.form.weight,
			is_homework: this.form.is_homework,
			is_auto_correct: this.form.is_auto_correct,
			time_in_second: this.form.time_in_second,
			question_type_id: codeTypeId,
		};
		if (this.form.best_answer) { payload.best_answer = this.form.best_answer; }
		if (this.form.pre_answer) { payload.pre_answer = this.form.pre_answer; }

		this.creating = true;
		this.createError = null;
		this.fieldErrors = {};
		this.refresh();

		try {
			const question = await this.api.createCodeQuestion(payload, this.cts.token);
			this.creating = false;
			this.notificationService.info(localize('nourlms.homework.admin.bank.create.success', "Question created successfully."));
			this.ctx.replace({ kind: 'adminQuestion', questionId: question.id }, localize('nourlms.homework.page.question', "Question #{0}", String(question.id)));
		} catch (err) {
			this.creating = false;
			if (err instanceof ApiError) {
				if (err.status === 422 && err.fieldErrors) {
					this.fieldErrors = err.fieldErrors;
					this.createError = null;
				} else {
					this.createError = err;
				}
			} else {
				this.createError = new ApiError({ status: 0, message: String(err) });
			}
			this.refresh();
		}
	}

	private refresh(): void {
		clearNode(this.parent);
		const inner = append(this.parent, $('.nourlms-hw-screen__inner'));

		const header = append(inner, $('.nourlms-hw-detail__header'));
		const title = append(header, $('.nourlms-hw-detail__title'));
		title.textContent = localize('nourlms.homework.admin.bank.create.title', "New code question");

		if (this.lookupsLoading) {
			appendLoadingRow(inner);
			return;
		}
		if (this.lookupsError) {
			appendErrorRow(inner, this.lookupsError.toString());
			return;
		}

		this.renderAiPanel(inner);
		this.renderForm(inner);
	}

	private renderAiPanel(parent: HTMLElement): void {
		const card = append(parent, $('.nourlms-hw-aicard'));
		const header = append(card, $('.nourlms-hw-aicard__header'));
		const headerIcon = append(header, $('span'));
		headerIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.sparkle));
		const headerLabel = append(header, $('span'));
		headerLabel.textContent = localize('nourlms.homework.admin.bank.create.ai.title', "Generate from prompt");

		const desc = append(card, $('p.nourlms-hw-aicard__desc'));
		desc.textContent = localize('nourlms.homework.admin.bank.create.ai.desc', "Describe the question you want and the AI will fill all fields below. You can edit anything before saving.");

		const ta = append(card, $<HTMLTextAreaElement>('textarea.nourlms-hw-textarea'));
		ta.placeholder = localize('nourlms.homework.admin.bank.create.ai.promptPlaceholder', "e.g. \"A medium-difficulty Python question about list comprehensions for a 5-minute timer.\"");
		ta.value = this.aiPrompt;
		ta.disabled = this.aiBusy;
		ta.addEventListener('input', () => { this.aiPrompt = ta.value; });

		const row = append(card, $('.nourlms-hw-aicard__actions'));
		const btn = append(row, $<HTMLButtonElement>('button.nourlms-hw-button'));
		btn.type = 'button';
		const btnIcon = append(btn, $('span'));
		btnIcon.classList.add(...ThemeIcon.asClassNameArray(this.aiBusy ? Codicon.loading : Codicon.sparkle));
		const btnLabel = append(btn, $('span'));
		btnLabel.textContent = this.aiBusy
			? localize('nourlms.homework.admin.bank.create.ai.generating', "Generating…")
			: localize('nourlms.homework.admin.bank.create.ai.generate', "Generate");
		btn.disabled = this.aiBusy;
		btn.addEventListener('click', () => this.generateFromAi());

		if (this.aiError) {
			appendErrorRow(card, this.aiError.toString());
		}
	}

	private renderForm(parent: HTMLElement): void {
		const form = append(parent, $('.nourlms-hw-form'));

		this.renderTextareaField(form, 'content',
			localize('nourlms.homework.admin.bank.create.content', "Content *"),
			localize('nourlms.homework.admin.bank.create.contentPlaceholder', "Question content (HTML allowed)"),
			this.form.content, '180px',
			v => { this.form.content = v; });

		// Course
		this.renderSelectField(form, 'course_id',
			localize('nourlms.homework.admin.bank.create.course', "Course *"),
			localize('nourlms.homework.admin.bank.create.coursePlaceholder', "Select course…"),
			this.courses.map(c => ({ id: c.id, label: c.name })),
			this.form.course_id,
			v => {
				this.form.course_id = v;
				// reset subject if it's no longer valid for the new course
				if (this.form.question_subject_id !== undefined) {
					const found = this.subjects.find(s => s.id === this.form.question_subject_id);
					if (!found || (this.form.course_id !== undefined && found.course_id !== this.form.course_id)) {
						this.form.question_subject_id = undefined;
					}
				}
				this.refresh();
			});

		// Subject (with suggested-subject support)
		this.renderSubjectField(form);

		// Difficulty
		this.renderSelectField(form, 'difficulty_rate_id',
			localize('nourlms.homework.admin.bank.create.difficulty', "Difficulty *"),
			localize('nourlms.homework.admin.bank.create.difficultyPlaceholder', "Select difficulty…"),
			this.difficultyRates.map(d => ({ id: d.id, label: d.name })),
			this.form.difficulty_rate_id,
			v => { this.form.difficulty_rate_id = v; });

		// Weight + time row
		const numbers = append(form, $('.nourlms-hw-form__row'));
		this.renderNumberField(numbers, 'weight',
			localize('nourlms.homework.admin.bank.create.weight', "Weight *"),
			this.form.weight, v => { this.form.weight = v; });
		this.renderNumberField(numbers, 'time_in_second',
			localize('nourlms.homework.admin.bank.create.timeInSecond', "Time (seconds)"),
			this.form.time_in_second, v => { this.form.time_in_second = v; });

		// Toggles
		const toggles = append(form, $('.nourlms-hw-form__row'));
		this.renderCheckbox(toggles,
			localize('nourlms.homework.admin.bank.create.isHomework', "Is homework"),
			this.form.is_homework, v => { this.form.is_homework = v; });
		this.renderCheckbox(toggles,
			localize('nourlms.homework.admin.bank.create.isAutoCorrect', "AI auto-grade"),
			this.form.is_auto_correct, v => { this.form.is_auto_correct = v; });

		// Best answer
		this.renderTextareaField(form, 'best_answer',
			localize('nourlms.homework.admin.bank.create.bestAnswer', "Best answer"),
			localize('nourlms.homework.admin.bank.create.bestAnswerPlaceholder', "Best answer (optional)"),
			this.form.best_answer, '120px',
			v => { this.form.best_answer = v; });

		// Pre-answer
		this.renderTextareaField(form, 'pre_answer',
			localize('nourlms.homework.admin.bank.create.preAnswer', "Pre-answer"),
			localize('nourlms.homework.admin.bank.create.preAnswerPlaceholder', "Starter code / pre-answer (optional)"),
			this.form.pre_answer, '120px',
			v => { this.form.pre_answer = v; });

		if (this.createError && Object.keys(this.fieldErrors).length === 0) {
			appendErrorRow(form, this.createError.toString());
		}

		const actions = append(form, $('.nourlms-hw-form__actions'));
		const submitBtn = append(actions, $<HTMLButtonElement>('button.nourlms-hw-button'));
		submitBtn.type = 'button';
		submitBtn.textContent = this.creating
			? localize('nourlms.homework.admin.bank.create.creating', "Creating…")
			: localize('nourlms.homework.admin.bank.create.submit', "Create");
		submitBtn.disabled = this.creating;
		submitBtn.addEventListener('click', () => this.submit());

		const cancelBtn = append(actions, $<HTMLButtonElement>('button.nourlms-hw-button.nourlms-hw-button--ghost'));
		cancelBtn.type = 'button';
		cancelBtn.textContent = localize('nourlms.homework.admin.bank.create.cancel', "Cancel");
		cancelBtn.addEventListener('click', () => this.ctx.pop());
	}

	private renderTextareaField(parent: HTMLElement, key: string, label: string, placeholder: string, value: string, minHeight: string, onInput: (v: string) => void): void {
		const wrap = append(parent, $('.nourlms-hw-form__field'));
		const lbl = append(wrap, $('label.nourlms-hw-form__label'));
		lbl.textContent = label;
		const ta = append(wrap, $<HTMLTextAreaElement>('textarea.nourlms-hw-form__textarea'));
		ta.placeholder = placeholder;
		ta.value = value;
		ta.style.minHeight = minHeight;
		ta.addEventListener('input', () => onInput(ta.value));
		const errs = this.fieldErrors[key];
		if (errs && errs.length) {
			const err = append(wrap, $('span.nourlms-hw-form__error'));
			err.textContent = errs.join(', ');
		}
	}

	private renderSelectField(parent: HTMLElement, key: string, label: string, placeholder: string, options: { id: number; label: string }[], current: number | undefined, onChange: (v: number | undefined) => void): void {
		const wrap = append(parent, $('.nourlms-hw-form__field'));
		const lbl = append(wrap, $('label.nourlms-hw-form__label'));
		lbl.textContent = label;
		const sel = append(wrap, $<HTMLSelectElement>('select.nourlms-hw-form__select'));
		const def = append(sel, $<HTMLOptionElement>('option'));
		def.value = '';
		def.textContent = placeholder;
		for (const o of options) {
			const opt = append(sel, $<HTMLOptionElement>('option'));
			opt.value = String(o.id);
			opt.textContent = o.label;
			if (o.id === current) { opt.selected = true; }
		}
		sel.addEventListener('change', () => {
			const v = sel.value;
			onChange(v ? Number(v) : undefined);
		});
		const errs = this.fieldErrors[key];
		if (errs && errs.length) {
			const err = append(wrap, $('span.nourlms-hw-form__error'));
			err.textContent = errs.join(', ');
		}
	}

	private renderSubjectField(parent: HTMLElement): void {
		const wrap = append(parent, $('.nourlms-hw-form__field'));
		const lbl = append(wrap, $('label.nourlms-hw-form__label'));
		lbl.textContent = localize('nourlms.homework.admin.bank.create.subject', "Subject *");

		if (this.form.suggested_subject_name && this.form.question_subject_id === undefined) {
			// AI suggested a new subject
			const banner = append(wrap, $('.nourlms-hw-suggested-subject'));
			const txt = append(banner, $('span'));
			txt.textContent = localize('nourlms.homework.admin.bank.create.suggestedSubject', "AI suggested a new subject: \"{0}\"", this.form.suggested_subject_name);
			const btn = append(banner, $<HTMLButtonElement>('button.nourlms-hw-button.nourlms-hw-button--small'));
			btn.type = 'button';
			btn.disabled = this.creatingSubject || this.form.course_id === undefined;
			btn.textContent = this.creatingSubject
				? localize('nourlms.homework.admin.bank.create.creatingSubject', "Creating…")
				: localize('nourlms.homework.admin.bank.create.createSubject', "Create subject");
			btn.addEventListener('click', () => this.createSuggestedSubject());

			const dismiss = append(banner, $<HTMLButtonElement>('button.nourlms-hw-button.nourlms-hw-button--ghost.nourlms-hw-button--small'));
			dismiss.type = 'button';
			dismiss.textContent = localize('nourlms.homework.admin.bank.create.dismissSuggested', "Use existing");
			dismiss.addEventListener('click', () => {
				this.form.suggested_subject_name = null;
				this.refresh();
			});

			if (this.createSubjectError) {
				appendErrorRow(wrap, this.createSubjectError.toString());
			}
		}

		const sel = append(wrap, $<HTMLSelectElement>('select.nourlms-hw-form__select'));
		const def = append(sel, $<HTMLOptionElement>('option'));
		def.value = '';
		def.textContent = localize('nourlms.homework.admin.bank.create.subjectPlaceholder', "Select subject…");
		for (const s of this.filteredSubjects()) {
			const opt = append(sel, $<HTMLOptionElement>('option'));
			opt.value = String(s.id);
			opt.textContent = s.name;
			if (s.id === this.form.question_subject_id) { opt.selected = true; }
		}
		sel.addEventListener('change', () => {
			this.form.question_subject_id = sel.value ? Number(sel.value) : undefined;
		});
		const errs = this.fieldErrors['question_subject_id'];
		if (errs && errs.length) {
			const err = append(wrap, $('span.nourlms-hw-form__error'));
			err.textContent = errs.join(', ');
		}
	}

	private renderNumberField(parent: HTMLElement, key: string, label: string, value: number, onInput: (v: number) => void): void {
		const wrap = append(parent, $('.nourlms-hw-form__field'));
		const lbl = append(wrap, $('label.nourlms-hw-form__label'));
		lbl.textContent = label;
		const input = append(wrap, $<HTMLInputElement>('input.nourlms-hw-form__input.nourlms-hw-form__input--small'));
		input.type = 'number';
		input.min = '0';
		input.value = String(value);
		input.addEventListener('input', () => onInput(Number(input.value) || 0));
		const errs = this.fieldErrors[key];
		if (errs && errs.length) {
			const err = append(wrap, $('span.nourlms-hw-form__error'));
			err.textContent = errs.join(', ');
		}
	}

	private renderCheckbox(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): void {
		const wrap = append(parent, $<HTMLLabelElement>('label.nourlms-hw-form__check'));
		const cb = append(wrap, $<HTMLInputElement>('input'));
		cb.type = 'checkbox';
		cb.checked = value;
		cb.addEventListener('change', () => onChange(cb.checked));
		const text = append(wrap, $('span'));
		text.textContent = label;
	}
}
