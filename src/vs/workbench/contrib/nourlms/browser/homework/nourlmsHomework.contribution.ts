/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/nourlmsHomework.css';
import { localize, localize2 } from '../../../../../nls.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer, EditorInputCapabilities } from '../../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { INourlmsAuthService, NourlmsContextKeys } from '../../../../services/nourlms/common/nourlms.js';
import { NourlmsHomeworkApi, INourlmsHomeworkApi } from './nourlmsHomeworkApi.js';
import { HomeworkPollingRegistry, IHomeworkPollingRegistry } from './nourlmsHomeworkPolling.js';
import { INourlmsHomeworkTargetStudentService, NourlmsHomeworkTargetStudentService } from './nourlmsHomeworkTargetStudent.js';
import { INourlmsHomeworkAiService, NourlmsHomeworkAiService } from './nourlmsHomeworkAi.js';
import { NourlmsHomeworkEditorInput, NOURLMS_HOMEWORK_EDITOR_RESOURCE } from './nourlmsHomeworkEditorInput.js';
import { NourlmsHomeworkEditorPane } from './nourlmsHomeworkEditorPane.js';

export const NOURLMS_HOMEWORK_OPEN_COMMAND_ID = 'nourlms.homework.open';

// === Singleton services ======================================================

registerSingleton(INourlmsHomeworkApi, NourlmsHomeworkApi, InstantiationType.Delayed);
registerSingleton(IHomeworkPollingRegistry, HomeworkPollingRegistry, InstantiationType.Delayed);
registerSingleton(INourlmsHomeworkTargetStudentService, NourlmsHomeworkTargetStudentService, InstantiationType.Delayed);
registerSingleton(INourlmsHomeworkAiService, NourlmsHomeworkAiService, InstantiationType.Delayed);

// === Editor pane =============================================================

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		NourlmsHomeworkEditorPane,
		NourlmsHomeworkEditorPane.ID,
		localize('nourlms.homework.editor.label', "Homework"),
	),
	[new SyncDescriptor(NourlmsHomeworkEditorInput)],
);

class NourlmsHomeworkInputSerializer implements IEditorSerializer {
	canSerialize(_editorInput: EditorInput): boolean {
		return true;
	}
	serialize(_editorInput: EditorInput): string {
		return '{}';
	}
	deserialize(instantiationService: IInstantiationService): NourlmsHomeworkEditorInput {
		return instantiationService.createInstance(NourlmsHomeworkEditorInput);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	NourlmsHomeworkEditorInput.ID,
	NourlmsHomeworkInputSerializer,
);

// === Open action =============================================================

const openContextWhen = ContextKeyExpr.or(
	ContextKeyExpr.equals(NourlmsContextKeys.IsStudent, true),
	ContextKeyExpr.equals(NourlmsContextKeys.IsAdmin, true),
);

registerAction2(class OpenNourlmsHomeworkAction extends Action2 {
	constructor() {
		super({
			id: NOURLMS_HOMEWORK_OPEN_COMMAND_ID,
			title: localize2('nourlms.homework.open', "Open Homework"),
			category: Categories.View,
			icon: Codicon.mortarBoard,
			f1: true,
			precondition: openContextWhen,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		// If a homework editor is already open in any group, reveal it instead of creating a new one.
		for (const editor of editorService.editors) {
			if (editor instanceof NourlmsHomeworkEditorInput) {
				await editorService.openEditor(editor, undefined);
				return;
			}
		}

		const input = instantiationService.createInstance(NourlmsHomeworkEditorInput);
		await editorService.openEditor(input, { pinned: true });
	}
});

// Register the "Homework" button in the Command Center next to the search field.
MenuRegistry.appendMenuItem(MenuId.CommandCenter, {
	command: {
		id: NOURLMS_HOMEWORK_OPEN_COMMAND_ID,
		title: localize('nourlms.homework.commandCenter', "Homework"),
		icon: Codicon.mortarBoard,
	},
	when: openContextWhen,
	group: 'navigation',
	order: 10003,
});

// Also surface in the global title bar (visible when the command center is hidden).
MenuRegistry.appendMenuItem(MenuId.TitleBar, {
	command: {
		id: NOURLMS_HOMEWORK_OPEN_COMMAND_ID,
		title: localize('nourlms.homework.titleBar', "Homework"),
		icon: Codicon.mortarBoard,
	},
	when: ContextKeyExpr.and(
		openContextWhen,
		ContextKeyExpr.has('config.window.commandCenter').negate(),
	),
	group: 'navigation',
	order: 5,
});

// === Auxiliary Bar (Secondary Side Bar) — kept hidden ========================
// The Homework feature now lives in a full-page editor pane, so the secondary
// side bar has no purpose here. Hide it on startup for any signed-in user
// (admin or student) and re-hide on every visibility change so a stray
// "Toggle Secondary Side Bar" command can't bring it back. The student-side
// restrictions also enforce the same; this contribution covers admins and the
// short window before student restrictions kick in.

class NourlmsHideAuxiliaryBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'nourlms.homework.hideAuxiliaryBar';

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@INourlmsAuthService authService: INourlmsAuthService,
	) {
		super();
		if (!authService.isAuthenticated) {
			return;
		}
		layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		this._register(layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.AUXILIARYBAR_PART && e.visible) {
				layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			}
		}));
	}
}

registerWorkbenchContribution2(
	NourlmsHideAuxiliaryBarContribution.ID,
	NourlmsHideAuxiliaryBarContribution,
	WorkbenchPhase.AfterRestored,
);

// (Re-export legacy IDs used elsewhere if present — kept as constants only.)
export const NOURLMS_HOMEWORK_EDITOR_RESOURCE_FOR_TESTS = NOURLMS_HOMEWORK_EDITOR_RESOURCE;
export { EditorInputCapabilities };
