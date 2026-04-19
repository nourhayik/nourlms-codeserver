/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INourlmsAuthService } from '../../../services/nourlms/common/nourlms.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ITerminalService, ITerminalInstance } from '../../terminal/browser/terminal.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IContextKeyService, RawContextKey, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { mainWindow } from '../../../../base/browser/window.js';

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
	'workbench.action.debug.configure',
	'workbench.action.openLaunchJson',
	'workbench.action.toggleSidebarVisibility',
	'workbench.action.openActivityBar',
	'workbench.action.openContextMenu',
	'workbench.action.quickOpenView',
	'workbench.action.showAllEditors',
	'workbench.action.showEditorsInActiveGroup',
	'workbench.action.openRemoteWindow',
	'workbench.action.remote.showMenu',
	'workbench.action.toggleMenuBar',
];

const HIDDEN_ACTIVITY_BAR_IDS = [
	'workbench.view.search',
	'workbench.view.scm',
	'workbench.view.debug',
	'workbench.view.extensions',
];

const PINNED_VIEW_CONTAINERS_KEY = 'workbench.activity.pinnedViewlets2';
const VIEW_CONTAINERS_WORKSPACE_STATE_KEY = 'workbench.activity.viewletsWorkspaceState';

const NourlmsStudentRestricted = new RawContextKey<boolean>('nourlmsStudentRestricted', false);

class NourlmsStudentRestrictions extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.nourlms.studentRestrictions';

	private readonly _terminalListener = this._register(new MutableDisposable());
	private readonly _studentRestrictedKey;

	constructor(
		@INourlmsAuthService nourlmsAuthService: INourlmsAuthService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ILogService private readonly logService: ILogService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IPaneCompositePartService private readonly paneCompositePartService: IPaneCompositePartService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		if (!nourlmsAuthService.isAuthenticated || nourlmsAuthService.userInfo?.role !== 'student') {
			return;
		}

		this.logService.info('[NourLMS] Applying student restrictions');

		this._studentRestrictedKey = NourlmsStudentRestricted.bindTo(contextKeyService);
		this._studentRestrictedKey.set(true);

		this._hideUIParts();
		this._hideActivityBarIcons();
		this._injectStudentCSS();
		this._blockContextMenu();
		this._blockCommands();
		this._applyStudentSettings();
		this._setupTerminalReadOnly();
		this._hideCommandsFromPalette();
		this._openExplorerSidebar();
	}

	private _hideUIParts(): void {
		this.layoutService.setPartHidden(true, Parts.STATUSBAR_PART);
	}

	private _injectStudentCSS(): void {
		const style = document.createElement('style');
		style.id = 'nourlms-student-restrictions';
		style.textContent = [
			'.monaco-workbench .part.titlebar > .titlebar-container > .titlebar-left > .menubar { display: none !important; }',
			'.monaco-workbench .activitybar .action-item:has(.codicon-settings-gear) { display: none !important; }',
			'.monaco-workbench .activitybar .action-item:has(.codicon-settings-view-bar-icon) { display: none !important; }',
			'.monaco-workbench .activitybar .action-item:has(.codicon-account) { display: none !important; }',
		].join('\n');
		mainWindow.document.head.appendChild(style);
	}

	private _blockContextMenu(): void {
		const handler = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			if (target?.closest('.activitybar') || target?.closest('.part.titlebar')) {
				e.preventDefault();
				e.stopPropagation();
			}
		};
		mainWindow.document.addEventListener('contextmenu', handler, true);
		this._register({ dispose: () => mainWindow.document.removeEventListener('contextmenu', handler, true) });
	}

	private _hideActivityBarIcons(): void {
		const hiddenSet = new Set(HIDDEN_ACTIVITY_BAR_IDS);

		try {
			const pinnedRaw = this.storageService.get(PINNED_VIEW_CONTAINERS_KEY, StorageScope.PROFILE, '[]');
			const pinned: { id: string; pinned: boolean; order?: number; visible: boolean }[] = JSON.parse(pinnedRaw);
			let changed = false;
			for (const item of pinned) {
				if (hiddenSet.has(item.id) && (item.pinned || item.visible)) {
					item.pinned = false;
					item.visible = false;
					changed = true;
				}
			}
			if (changed) {
				this.storageService.store(PINNED_VIEW_CONTAINERS_KEY, JSON.stringify(pinned), StorageScope.PROFILE, StorageTarget.USER);
			}
		} catch (e) {
			this.logService.error('[NourLMS] Failed to update pinned view containers', e);
		}

		try {
			const wsRaw = this.storageService.get(VIEW_CONTAINERS_WORKSPACE_STATE_KEY, StorageScope.WORKSPACE, '[]');
			const wsState: { id: string; visible: boolean }[] = JSON.parse(wsRaw);
			let changed = false;
			for (const item of wsState) {
				if (hiddenSet.has(item.id) && item.visible) {
					item.visible = false;
					changed = true;
				}
			}
			for (const hiddenId of HIDDEN_ACTIVITY_BAR_IDS) {
				if (!wsState.some(item => item.id === hiddenId)) {
					wsState.push({ id: hiddenId, visible: false });
					changed = true;
				}
			}
			if (changed) {
				this.storageService.store(VIEW_CONTAINERS_WORKSPACE_STATE_KEY, JSON.stringify(wsState), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
		} catch (e) {
			this.logService.error('[NourLMS] Failed to update workspace view container state', e);
		}
	}

	private async _openExplorerSidebar(): Promise<void> {
		await this.paneCompositePartService.openPaneComposite(
			'workbench.view.explorer',
			ViewContainerLocation.Sidebar,
			false
		);
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

	private _hideCommandsFromPalette(): void {
		const disposables = new DisposableStore();
		this._register(disposables);

		for (const commandId of BLOCKED_COMMANDS_FOR_STUDENTS) {
			const d = MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
				command: {
					id: commandId,
					title: '',
				},
				when: ContextKeyExpr.equals('nourlmsStudentRestricted', false),
			});
			disposables.add(d);
		}
	}

	private _applyStudentSettings(): void {
		const tryUpdate = (key: string, value: any) => {
			try {
				this.configurationService.updateValue(key, value);
			} catch {
				// setting not registered yet, ignore
			}
		};
		tryUpdate('git.enabled', false);
		tryUpdate('extensions.autoUpdate', false);
		tryUpdate('extensions.autoCheckUpdates', false);
		tryUpdate('workbench.localHistory.enabled', false);
		tryUpdate('terminal.integrated.defaultProfile.linux', 'bash');
		tryUpdate('github.copilot.enable', { '*': false });
		tryUpdate('window.menuBarVisibility', 'hidden');
		this.storageService.store('workbench.activity.showAccounts', false, StorageScope.PROFILE, StorageTarget.USER);
	}

	private _setupTerminalReadOnly(): void {
		this._terminalListener.value = this.terminalService.onDidCreateInstance((instance: ITerminalInstance) => {
			const store = new DisposableStore();
			store.add(instance.onExit(() => {
				instance.xtermReadyPromise.then(xterm => {
					if (xterm) {
						xterm.raw.options.disableStdin = true;
					}
				});
			}));
			this._register(store);
		});
	}

	override dispose(): void {
		if (this._studentRestrictedKey) {
			this._studentRestrictedKey.reset();
		}
		super.dispose();
	}
}

export function registerNourlmsStudentRestrictions(): void {
	registerWorkbenchContribution2(
		NourlmsStudentRestrictions.ID,
		NourlmsStudentRestrictions,
		WorkbenchPhase.AfterRestored
	);
}
