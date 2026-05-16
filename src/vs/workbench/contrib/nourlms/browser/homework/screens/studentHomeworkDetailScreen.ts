/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../../nls.js';
import { append, $, clearNode } from '../../../../../../base/browser/dom.js';
import { safeSetInnerHtml } from '../../../../../../base/browser/domSanitize.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { INourlmsHomeworkApi, ApiError } from '../nourlmsHomeworkApi.js';
import { IHomeworkPollingRegistry, PollState } from '../nourlmsHomeworkPolling.js';
import { IHomeworkScreen, ScreenContext } from '../nourlmsHomeworkRouter.js';
import type { Homework, HomeworkSubmission } from '../types.js';
import { appendErrorRow, appendLoadingRow, formatDate } from './screenUtils.js';

const MAX_FILE_SIZE_BYTES = 1024 * 1024;

interface DetailState {
	homework: Homework | null;
	loading: boolean;
	error: ApiError | null;
	submissions: HomeworkSubmission[];
	submissionsPage: number;
	submissionsLastPage: number;
	submissionsLoading: boolean;
	submissionsError: ApiError | null;
	answerText: string;
	submitting: boolean;
	submitError: ApiError | null;
}

export class StudentHomeworkDetailScreen extends Disposable implements IHomeworkScreen {

	private parent!: HTMLElement;
	private ctx!: ScreenContext;
	private cts = this._register(new CancellationTokenSource());
	private fetchNonce = 0;
	private readonly activePolls = new Set<string>();
	private readonly gaveUpPolls = new Set<string>();
	private readonly disposables: IDisposable[] = [];

	private state: DetailState;

	constructor(
		private readonly homeworkId: number,
		preloaded: Homework | undefined,
		@INourlmsHomeworkApi private readonly api: INourlmsHomeworkApi,
		@IHomeworkPollingRegistry private readonly pollingRegistry: IHomeworkPollingRegistry,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super();
		this.state = {
			homework: preloaded ?? null,
			loading: !preloaded,
			error: null,
			submissions: [],
			submissionsPage: 1,
			submissionsLastPage: 1,
			submissionsLoading: false,
			submissionsError: null,
			answerText: '',
			submitting: false,
			submitError: null,
		};
		this._register(toDisposable(() => {
			for (const d of this.disposables) { d.dispose(); }
			this.disposables.length = 0;
		}));
	}

	mount(parent: HTMLElement, ctx: ScreenContext): void {
		this.parent = parent;
		this.ctx = ctx;
		parent.classList.add('nourlms-hw-screen', 'nourlms-hw-screen--scroll');

		this.refresh();
		if (!this.state.homework || this.state.loading) {
			this.fetchHomework();
		}
		this.fetchSubmissions();
	}

	private async fetchHomework(): Promise<void> {
		const nonce = ++this.fetchNonce;
		this.state.loading = true;
		this.state.error = null;
		this.refresh();
		try {
			const hw = await this.api.getStudentHomework(this.homeworkId, this.cts.token);
			if (nonce !== this.fetchNonce) { return; }
			this.state.homework = hw;
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
		const nonce = ++this.fetchNonce;
		this.state.submissionsLoading = true;
		this.state.submissionsError = null;
		this.refresh();
		try {
			const result = await this.api.listStudentSubmissions(
				this.homeworkId,
				{ page: this.state.submissionsPage },
				this.cts.token,
			);
			if (nonce !== this.fetchNonce) { return; }
			this.state.submissions = result.data;
			this.state.submissionsPage = result.current_page;
			this.state.submissionsLastPage = result.last_page;
			this.state.submissionsLoading = false;
			this.setupSubmissionPolling();
			this.refresh();
		} catch (err) {
			if (nonce !== this.fetchNonce) { return; }
			this.state.submissionsLoading = false;
			this.state.submissionsError = err instanceof ApiError ? err : new ApiError({ status: 0, message: String(err) });
			this.refresh();
		}
	}

	private setupSubmissionPolling(): void {
		const hw = this.state.homework;
		if (!hw || !hw.question?.is_auto_correct) { return; }
		for (const sub of this.state.submissions) {
			if (sub.latest_ai_result_id === null) {
				const pollKey = `${this.homeworkId}:${sub.id}`;
				if (this.activePolls.has(pollKey)) { continue; }
				this.activePolls.add(pollKey);
				const { onState, cancel } = this.pollingRegistry.poll({ homeworkId: this.homeworkId, submissionId: sub.id });
				const d = onState((state: PollState) => {
					if (state.kind === 'ready' || state.kind === 'gave-up') {
						this.activePolls.delete(pollKey);
						if (state.kind === 'gave-up') { this.gaveUpPolls.add(pollKey); }
						this.fetchSubmissions();
					}
				});
				this.disposables.push(d, cancel);
			}
		}
	}

	private async submitAnswer(): Promise<void> {
		const hw = this.state.homework;
		if (!hw) { return; }

		const freshCts = new CancellationTokenSource();
		try {
			const fresh = await this.api.getStudentHomework(hw.id, freshCts.token);
			if (fresh.is_corrected) {
				this.state.submitError = new ApiError({
					status: 0,
					message: localize('nourlms.homework.student.submit.corrected', "This homework has been graded — no further submissions are accepted."),
				});
				this.refresh();
				return;
			}
		} catch { /* ignore */ } finally {
			freshCts.dispose();
		}

		this.state.submitting = true;
		this.state.submitError = null;
		this.refresh();
		try {
			await this.api.submitAnswer(hw.id, { content: this.state.answerText }, this.cts.token);
			this.state.answerText = '';
			this.state.submitting = false;
			this.fetchSubmissions();
		} catch (err) {
			this.state.submitError = err instanceof ApiError ? err : new ApiError({ status: 0, message: String(err) });
			this.state.submitting = false;
			this.refresh();
		}
	}

	private async submitFromFile(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return; }
		const folderUri = folders[0].uri;
		let stat;
		try { stat = await this.fileService.resolve(folderUri); } catch { return; }
		const fileEntries = (stat.children ?? []).filter(c => !c.isDirectory);
		if (fileEntries.length === 0) { return; }

		interface PickItem { label: string; detail: string; resource: URI }
		const items: PickItem[] = fileEntries.map(f => ({ label: f.name, detail: f.resource.path, resource: f.resource }));
		const picked = await this.quickInputService.pick(items, { placeHolder: localize('nourlms.homework.student.submit.fromFilePicker', "Select a file to submit") });
		if (!picked) { return; }
		try {
			const fileStat = await this.fileService.resolve(picked.resource, { resolveMetadata: true });
			if (fileStat.size !== undefined && fileStat.size > MAX_FILE_SIZE_BYTES) {
				this.state.submitError = new ApiError({ status: 0, message: localize('nourlms.homework.student.submit.fileTooLarge', "File exceeds the 1 MB limit.") });
				this.refresh();
				return;
			}
			const content = await this.fileService.readFile(picked.resource);
			let text: string;
			try { text = bufferToString(content.value); }
			catch {
				this.state.submitError = new ApiError({ status: 0, message: localize('nourlms.homework.student.submit.binary', "Selected file is not text-readable.") });
				this.refresh();
				return;
			}
			this.state.answerText = text;
			this.refresh();
			await this.submitAnswer();
		} catch (err) {
			this.state.submitError = new ApiError({ status: 0, message: String(err) });
			this.refresh();
		}
	}

	private refresh(): void {
		clearNode(this.parent);
		const inner = append(this.parent, $('.nourlms-hw-screen__inner'));

		if (this.state.loading && !this.state.homework) {
			appendLoadingRow(inner);
			return;
		}

		if (this.state.error && !this.state.homework) {
			appendErrorRow(inner, this.state.error.toString());
			return;
		}

		const hw = this.state.homework;
		if (!hw) {
			appendErrorRow(inner, localize('nourlms.homework.student.detail.noHomework', "Homework not found."));
			return;
		}

		const header = append(inner, $('.nourlms-hw-detail__header'));
		const title = append(header, $('.nourlms-hw-detail__title'));
		const qid = hw.question?.id ?? hw.question_id ?? '?';
		title.textContent = localize('nourlms.homework.page.question', "Question #{0}", String(qid));

		const dateLabel = append(header, $('span.nourlms-hw-detail__date'));
		dateLabel.textContent = formatDate(hw.created_at);

		const body = append(inner, $('.nourlms-hw-detail__body.nourlms-hw-prose'));
		safeSetInnerHtml(body, hw.question?.content ?? '');

		if (hw.question?.pre_answer) {
			const preLabel = append(inner, $('.nourlms-hw-section__title'));
			preLabel.textContent = localize('nourlms.homework.starterCode', "Starter code");
			const preBlock = append(inner, $('div.nourlms-hw-codeblock'));
			preBlock.textContent = hw.question.pre_answer;
		}

		if (hw.is_corrected) {
			const notice = append(inner, $('.nourlms-hw-notice.nourlms-hw-notice--success'));
			notice.textContent = localize('nourlms.homework.student.submit.corrected', "This homework has been graded — no further submissions are accepted.");
		} else {
			this.renderSubmitArea(inner);
		}

		this.renderSubmissions(inner);
	}

	private renderSubmitArea(parent: HTMLElement): void {
		const submit = append(parent, $('.nourlms-hw-submit'));
		const sectionTitle = append(submit, $('.nourlms-hw-section__title'));
		sectionTitle.textContent = localize('nourlms.homework.student.answer.title', "Your answer");

		if (this.state.submitError) {
			appendErrorRow(submit, this.state.submitError.toString());
		}

		const textarea = append(submit, $<HTMLTextAreaElement>('textarea.nourlms-hw-textarea'));
		textarea.value = this.state.answerText;
		textarea.placeholder = localize('nourlms.homework.student.answerPlaceholder', "Type your answer here…");
		textarea.disabled = this.state.submitting;
		textarea.addEventListener('input', () => { this.state.answerText = textarea.value; });

		const row = append(submit, $('.nourlms-hw-submit__row'));
		const submitBtn = append(row, $<HTMLButtonElement>('button.nourlms-hw-button'));
		submitBtn.type = 'button';
		submitBtn.textContent = this.state.submitting
			? localize('nourlms.homework.student.submitting', "Submitting…")
			: localize('nourlms.homework.student.submit.button', "Submit");
		submitBtn.disabled = this.state.submitting || !this.state.answerText.trim();
		submitBtn.addEventListener('click', () => this.submitAnswer());

		const fileBtn = append(row, $<HTMLButtonElement>('button.nourlms-hw-button.nourlms-hw-button--ghost'));
		fileBtn.type = 'button';
		fileBtn.textContent = localize('nourlms.homework.student.submit.fromFile', "Submit from file…");
		fileBtn.disabled = this.state.submitting;
		fileBtn.addEventListener('click', () => this.submitFromFile());
	}

	private renderSubmissions(parent: HTMLElement): void {
		const section = append(parent, $('.nourlms-hw-section'));
		const heading = append(section, $('.nourlms-hw-section__title'));
		const headingTitle = append(heading, $('span'));
		headingTitle.textContent = localize('nourlms.homework.student.submissions', "Submissions");
		if (this.state.submissions.length > 0) {
			const count = append(heading, $('span.nourlms-hw-section__count'));
			count.textContent = String(this.state.submissions.length);
		}

		const list = append(section, $('.nourlms-hw-sublist'));

		if (this.state.submissionsLoading && this.state.submissions.length === 0) {
			appendLoadingRow(list);
			return;
		}

		if (this.state.submissionsError) {
			appendErrorRow(list, this.state.submissionsError.toString());
			return;
		}

		if (this.state.submissions.length === 0) {
			const empty = append(list, $('.nourlms-hw-empty'));
			const t = append(empty, $('.nourlms-hw-empty__title'));
			t.textContent = localize('nourlms.homework.student.submissions.empty', "No submissions yet.");
			return;
		}

		const hw = this.state.homework!;
		for (const sub of this.state.submissions) {
			this.renderSubmissionRow(list, hw, sub);
		}

		if (this.state.submissionsPage < this.state.submissionsLastPage) {
			const more = append(list, $('.nourlms-hw-loadmore'));
			more.textContent = localize('nourlms.homework.loadMore', "Load more…");
			more.addEventListener('click', () => {
				this.state.submissionsPage++;
				this.fetchSubmissions();
			});
		}
	}

	private renderSubmissionRow(parent: HTMLElement, hw: Homework, sub: HomeworkSubmission): void {
		const pollKey = `${hw.id}:${sub.id}`;
		const row = append(parent, $('.nourlms-hw-sub'));
		const main = append(row, $('.nourlms-hw-sub__main'));
		const id = append(main, $('.nourlms-hw-sub__id'));
		id.textContent = `#${sub.id}`;
		const date = append(main, $('.nourlms-hw-sub__date'));
		date.textContent = formatDate(sub.submitted_at);

		const badges = append(row, $('.nourlms-hw-sub__badges'));
		const badge = append(badges, $('span.nourlms-hw-pill'));
		if (sub.latest_ai_result_id !== null && sub.latest_ai_result_id !== undefined) {
			badge.classList.add('nourlms-hw-pill--ready');
			badge.textContent = localize('nourlms.homework.student.submission.aiReady', "AI Ready");
		} else if (hw.question?.is_auto_correct) {
			if (this.gaveUpPolls.has(pollKey)) {
				badge.classList.add('nourlms-hw-pill--checkagain');
				badge.textContent = localize('nourlms.homework.polling.checkAgain', "Check again");
				badge.addEventListener('click', (e: Event) => {
					e.stopPropagation();
					this.gaveUpPolls.delete(pollKey);
					this.fetchSubmissions();
				});
			} else {
				badge.classList.add('nourlms-hw-pill--pending');
				badge.textContent = localize('nourlms.homework.student.submission.pending', "Pending");
			}
		} else {
			badge.classList.add('nourlms-hw-pill--awaiting');
			badge.textContent = localize('nourlms.homework.student.submission.awaitingAdmin', "Awaiting admin");
		}

		const arrow = append(row, $('span.nourlms-hw-sub__arrow'));
		arrow.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronRight));

		row.addEventListener('click', () => {
			this.ctx.push({
				kind: 'submission',
				homeworkId: hw.id,
				submissionId: sub.id,
				isAdmin: false,
				preloaded: sub,
			}, localize('nourlms.homework.page.submission', "Submission #{0}", String(sub.id)));
		});
	}
}

function bufferToString(buffer: VSBuffer): string {
	const bytes = buffer.buffer;
	if (bytes instanceof Uint8Array) {
		for (let i = 0; i < bytes.length; i++) {
			if (bytes[i] === 0) { throw new Error('Binary file detected'); }
		}
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	}
	return buffer.toString();
}
