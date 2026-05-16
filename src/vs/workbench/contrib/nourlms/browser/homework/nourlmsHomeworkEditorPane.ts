/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { append, $, clearNode } from '../../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { INourlmsAuthService } from '../../../../services/nourlms/common/nourlms.js';
import { NourlmsHomeworkEditorInput } from './nourlmsHomeworkEditorInput.js';
import { HomeworkRouter, HomeworkRoute, HomeworkRouteRecord, IHomeworkScreen, ScreenContext } from './nourlmsHomeworkRouter.js';
import { HomeScreen } from './screens/homeScreen.js';
import { StudentHomeworkDetailScreen } from './screens/studentHomeworkDetailScreen.js';
import { SubmissionDetailScreen } from './screens/submissionDetailScreen.js';
import { AiResultScreen } from './screens/aiResultScreen.js';
import { AdminQuestionBankScreen } from './screens/adminQuestionBankScreen.js';
import { AdminAssignedScreen } from './screens/adminAssignedScreen.js';
import { AdminQuestionDetailScreen } from './screens/adminQuestionDetailScreen.js';
import { NewQuestionScreen } from './screens/newQuestionScreen.js';

export class NourlmsHomeworkEditorPane extends EditorPane {

	public static readonly ID = 'workbench.editors.nourlmsHomeworkEditor';

	private rootContainer!: HTMLElement;
	private headerContainer!: HTMLElement;
	private bodyContainer!: HTMLElement;
	private breadcrumbsEl!: HTMLElement;
	private backButton!: HTMLButtonElement;
	private homeButton!: HTMLButtonElement;

	private readonly router: HomeworkRouter;
	private readonly screenStore = new DisposableStore();
	private currentScreen: IHomeworkScreen | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INourlmsAuthService private readonly authService: INourlmsAuthService,
	) {
		super(NourlmsHomeworkEditorPane.ID, group, telemetryService, themeService, storageService);
		this.router = this._register(new HomeworkRouter());
		this._register(this.screenStore);
		this._register(this.router.onDidChange(() => this.renderRoute()));
	}

	protected createEditor(parent: HTMLElement): void {
		this.rootContainer = append(parent, $('.nourlms-hw-editor'));

		this.headerContainer = append(this.rootContainer, $('.nourlms-hw-editor__header'));

		const navGroup = append(this.headerContainer, $('.nourlms-hw-editor__nav'));

		this.backButton = append(navGroup, $<HTMLButtonElement>('button.nourlms-hw-editor__back'));
		this.backButton.type = 'button';
		this.backButton.title = localize('nourlms.homework.editor.back', "Back");
		const backIcon = append(this.backButton, $('span'));
		backIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.arrowLeft));
		const backLabel = append(this.backButton, $('span'));
		backLabel.textContent = localize('nourlms.homework.editor.back', "Back");
		this.backButton.addEventListener('click', () => this.router.pop());

		this.homeButton = append(navGroup, $<HTMLButtonElement>('button.nourlms-hw-editor__home'));
		this.homeButton.type = 'button';
		this.homeButton.title = localize('nourlms.homework.editor.home', "Home");
		const homeIcon = append(this.homeButton, $('span'));
		homeIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.home));
		const homeLabel = append(this.homeButton, $('span'));
		homeLabel.textContent = localize('nourlms.homework.editor.home', "Home");
		this.homeButton.addEventListener('click', () => {
			this.router.resetTo({ kind: 'home' }, localize('nourlms.homework.editor.title', "Homework"));
		});

		this.breadcrumbsEl = append(this.headerContainer, $('.nourlms-hw-editor__crumbs'));

		this.bodyContainer = append(this.rootContainer, $('.nourlms-hw-editor__body'));
	}

	override async setInput(input: NourlmsHomeworkEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (this.router.stack.length === 0) {
			this.router.push({ kind: 'home' }, localize('nourlms.homework.editor.title', "Homework"));
		} else {
			this.renderRoute();
		}
	}

	override clearInput(): void {
		this.disposeCurrentScreen();
		this.router.clear();
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		if (this.rootContainer) {
			this.rootContainer.style.width = `${dimension.width}px`;
			this.rootContainer.style.height = `${dimension.height}px`;
		}
	}

	override focus(): void {
		super.focus();
		this.bodyContainer?.focus();
	}

	private renderRoute(): void {
		const top = this.router.current;
		if (!top) {
			this.disposeCurrentScreen();
			clearNode(this.bodyContainer);
			return;
		}

		this.renderBreadcrumbs();

		this.disposeCurrentScreen();
		clearNode(this.bodyContainer);

		// Create a FRESH scroll container as a child of the body — must NOT
		// share the DOM node with `.nourlms-hw-editor__body`, otherwise the
		// body's `display: flex; flex-direction: column` would squash the
		// screen's inner content (default `flex-shrink: 1`) so wheel scrolling
		// has nothing to scroll through.
		const screenHost = append(this.bodyContainer, $('.nourlms-hw-screen.nourlms-hw-screen--scroll'));

		const screen = this.createScreen(top.route);
		if (!screen) {
			const errEl = append(screenHost, $('.nourlms-hw-error'));
			errEl.textContent = localize('nourlms.homework.editor.unknownRoute', "Unknown route. Returning home.");
			this.router.resetTo({ kind: 'home' }, localize('nourlms.homework.editor.title', "Homework"));
			return;
		}

		this.currentScreen = screen;
		this.screenStore.add(screen);

		const role = this.authService.userInfo?.role ?? 'student';
		const userId = this.authService.userInfo?.userId;
		const ctx: ScreenContext = {
			userInfo: { role, userId },
			push: (route, title) => this.router.push(route, title),
			replace: (route, title) => this.router.replace(route, title),
			pop: () => this.router.pop(),
			popTo: predicate => this.router.popTo(predicate),
			resetTo: (route, title) => this.router.resetTo(route, title),
		};

		screen.mount(screenHost, ctx);
	}

	private renderBreadcrumbs(): void {
		clearNode(this.breadcrumbsEl);
		const stack = this.router.stack;
		this.backButton.disabled = !this.router.canGoBack;
		this.backButton.style.visibility = this.router.canGoBack ? 'visible' : 'hidden';

		stack.forEach((record, index) => {
			if (index > 0) {
				const sep = append(this.breadcrumbsEl, $('span.nourlms-hw-editor__crumb-sep'));
				sep.textContent = '/';
			}
			const isLast = index === stack.length - 1;
			const crumb = append(this.breadcrumbsEl, $(isLast ? 'span.nourlms-hw-editor__crumb.is-active' : 'button.nourlms-hw-editor__crumb'));
			crumb.textContent = record.title;
			if (!isLast) {
				crumb.addEventListener('click', () => this.popToIndex(index));
			}
		});
	}

	private popToIndex(index: number): void {
		const stack = this.router.stack;
		if (index < 0 || index >= stack.length) { return; }
		const targetRecord = stack[index];
		this.router.popTo(record => record === targetRecord);
	}

	private disposeCurrentScreen(): void {
		if (this.currentScreen) {
			this.screenStore.clear();
			this.currentScreen = undefined;
		}
	}

	private createScreen(route: HomeworkRoute): IHomeworkScreen | undefined {
		switch (route.kind) {
			case 'home':
				return this.instantiationService.createInstance(HomeScreen);
			case 'studentHomework':
				return this.instantiationService.createInstance(StudentHomeworkDetailScreen, route.homeworkId, route.preloaded);
			case 'submission':
				return this.instantiationService.createInstance(SubmissionDetailScreen, route.homeworkId, route.submissionId, route.isAdmin, route.preloaded);
			case 'aiResult':
				return this.instantiationService.createInstance(AiResultScreen, route.resultId);
			case 'adminQuestionBank':
				return this.instantiationService.createInstance(AdminQuestionBankScreen);
			case 'adminAssigned':
				return this.instantiationService.createInstance(AdminAssignedScreen);
			case 'adminQuestion':
				return this.instantiationService.createInstance(AdminQuestionDetailScreen, route.questionId);
			case 'newQuestion':
				return this.instantiationService.createInstance(NewQuestionScreen);
			default: {
				const _exhaustive: never = route;
				void _exhaustive;
				return undefined;
			}
		}
	}

	override dispose(): void {
		this.disposeCurrentScreen();
		super.dispose();
	}
}

export function _silenceUnused(_: HomeworkRouteRecord): void { /* keep import */ }
