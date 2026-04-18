/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INourlmsAuthService } from '../../../services/nourlms/common/nourlms.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ITerminalService, ITerminalInstance } from '../../terminal/browser/terminal.js';
import { ILogService } from '../../../../platform/log/common/log.js';

const BLOCKED_COMMANDS_FOR_STUDENTS = [
	'workbench.action.openSettings',
	'workbench.action.openSettings2',
	'workbench.action.openGlobalSettings',
	'workbench.action.openApplicationSettingsJson',
	'workbench.action.openSettingsJson',
	'workbench.action.openRawDefaultSettings',
	'workbench.action.openGlobalKeybindings',
	'workbench.action.openGlobalKeybindingsFile',
	'workbench.action.openSnippets',
	'workbench.action.openWorkspaceSettings',
	'workbench.action.openFolderSettingsFile',
	'workbench.action.settings',
	'workbench.view.extensions',
	'workbench.extensions.search',
	'workbench.extensions.installExtension',
	'workbench.extensions.uninstallExtension',
	'workbench.view.scm',
	'git.init',
	'git.clone',
	'git.publish',
	'workbench.action.terminal.new',
	'workbench.action.terminal.createNew',
	'workbench.action.terminal.newInActiveWorkspace',
	'workbench.action.terminal.newWithProfile',
	'workbench.action.terminal.newInNewWindow',
	'workbench.action.createTerminalEditor',
	'workbench.action.createTerminalEditorSide',
	'workbench.action.debug.start',
	'workbench.action.debug.run',
	'workbench.action.debug.configure',
	'workbench.action.openLaunchJson',
];

const HIDDEN_VIEW_CONTAINERS_FOR_STUDENTS = [
	'workbench.view.search',
	'workbench.view.scm',
	'workbench.view.debug',
	'workbench.view.extensions',
	'workbench.view.extension.test',
];

class NourlmsStudentRestrictions extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.nourlms.studentRestrictions';

	private readonly _terminalListener = this._register(new MutableDisposable());

	constructor(
		@INourlmsAuthService nourlmsAuthService: INourlmsAuthService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		if (!nourlmsAuthService.isAuthenticated || nourlmsAuthService.userInfo?.role !== 'student') {
			return;
		}

		this.logService.info('[NourLMS] Applying student restrictions');

		this._hideActivityBarIcons();
		this._blockCommands();
		this._applyStudentSettings();
		this._setupTerminalAutoClose();
	}

	private _hideActivityBarIcons(): void {
		for (const viewContainerId of HIDDEN_VIEW_CONTAINERS_FOR_STUDENTS) {
			const container = this.viewDescriptorService.getViewContainerById(viewContainerId);
			if (container) {
				const model = this.viewDescriptorService.getViewContainerModel(container);
				for (const viewDescriptor of model.allViewDescriptors) {
					model.setVisible(viewDescriptor.id, false);
				}
			}
		}
	}

	private _blockCommands(): void {
		const blocked = new Set(BLOCKED_COMMANDS_FOR_STUDENTS);
		const originalExecuteCommand = this.commandService.executeCommand.bind(this.commandService);

		(this.commandService as any).executeCommand = function (command: string, ...args: any[]) {
			if (blocked.has(command)) {
				return Promise.resolve();
			}
			return originalExecuteCommand(command, ...args);
		};
	}

	private _applyStudentSettings(): void {
		this.configurationService.updateValue('git.enabled', false);
		this.configurationService.updateValue('extensions.autoUpdate', false);
		this.configurationService.updateValue('extensions.autoCheckUpdates', false);
		this.configurationService.updateValue('workbench.localHistory.enabled', false);
	}

	private _setupTerminalAutoClose(): void {
		this._terminalListener.value = this.terminalService.onDidCreateInstance((instance: ITerminalInstance) => {
			const store = new DisposableStore();
			store.add(instance.onExit(() => {
				setTimeout(() => {
					instance.dispose();
				}, 500);
			}));
			this._register(store);
		});
	}
}

export function registerNourlmsStudentRestrictions(): void {
	registerWorkbenchContribution2(
		NourlmsStudentRestrictions.ID,
		NourlmsStudentRestrictions,
		WorkbenchPhase.AfterRestored
	);
}