/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Disposable,
	DisposableStore,
	MutableDisposable,
} from "../../../../base/common/lifecycle.js";
import {
	IWorkbenchContribution,
	registerWorkbenchContribution2,
	WorkbenchPhase,
} from "../../../common/contributions.js";
import { INourlmsAuthService } from "../../../services/nourlms/common/nourlms.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import {
	ITerminalService,
	ITerminalInstance,
} from "../../terminal/browser/terminal.js";
import { TerminalCapability } from "../../../../platform/terminal/common/capabilities/capabilities.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import {
	IWorkbenchLayoutService,
	Parts,
} from "../../../services/layout/browser/layoutService.js";
import {
	IContextKeyService,
	RawContextKey,
	ContextKeyExpr,
} from "../../../../platform/contextkey/common/contextkey.js";
import { IPaneCompositePartService } from "../../../services/panecomposite/browser/panecomposite.js";
import { ViewContainerLocation } from "../../../common/views.js";
import {
	MenuId,
	MenuRegistry,
} from "../../../../platform/actions/common/actions.js";
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from "../../../../platform/storage/common/storage.js";
import { mainWindow } from "../../../../base/browser/window.js";
import { IPreferencesService } from "../../../services/preferences/common/preferences.js";
import { IEditorGroupsService } from "../../../services/editor/common/editorGroupsService.js";
import { IQuickInputService } from "../../../../platform/quickinput/common/quickInput.js";
import { gettingStartedInputTypeId } from "../../welcomeGettingStarted/browser/gettingStartedInput.js";

const BLOCKED_COMMANDS_FOR_STUDENTS = [
	// --- Settings (all entry points) ---
	"workbench.action.openSettings",
	"workbench.action.openSettings2",
	"workbench.action.openGlobalSettings",
	"workbench.action.openApplicationSettingsJson",
	"workbench.action.openSettingsJson",
	"workbench.action.openRawDefaultSettings",
	"workbench.action.openGlobalKeybindings",
	"workbench.action.openGlobalKeybindingsFile",
	"workbench.action.openDefaultKeybindingsFile",
	"workbench.action.openSnippets",
	"workbench.action.openWorkspaceSettings",
	"workbench.action.openWorkspaceSettingsFile",
	"workbench.action.openFolderSettingsFile",
	"workbench.action.openFolderSettings",
	"workbench.action.openAccessibilitySettings",
	"workbench.action.openRemoteSettings",
	"workbench.action.openRemoteSettingsFile",
	"workbench.action.settings",
	// --- Extensions ---
	"workbench.view.extensions",
	"workbench.extensions.search",
	"workbench.extensions.installExtension",
	"workbench.extensions.uninstallExtension",
	"workbench.extensions.action.showRecommendedExtensions",
	"workbench.extensions.action.showRecommendedExtension",
	"workbench.extensions.action.installRecommendedExtension",
	"workbench.extensions.action.listOutdatedExtensions",
	"workbench.extensions.action.install.specificVersion",
	"workbench.extensions.action.install.anotherVersion",
	"workbench.extensions.action.configureWorkspaceRecommendedExtensions",
	"workbench.extensions.action.configureWorkspaceFolderRecommendedExtensions",
	"workbench.extensions.action.setColorTheme",
	"workbench.extensions.action.setFileIconTheme",
	"workbench.extensions.action.setProductIconTheme",
	// --- Git/SCM ---
	"workbench.view.scm",
	"git.init",
	"git.clone",
	"git.publish",
	// --- Terminal (direct creation only — run commands stay unblocked) ---
	"workbench.action.terminal.new",
	"workbench.action.terminal.createNew",
	"workbench.action.terminal.newInActiveWorkspace",
	"workbench.action.terminal.newWithProfile",
	"workbench.action.terminal.newInNewWindow",
	"workbench.action.terminal.newWithCwd",
	"workbench.action.terminal.newLocal",
	"workbench.action.terminal.split",
	"workbench.action.terminal.splitInActiveWorkspace",
	"workbench.action.createTerminalEditor",
	"workbench.action.createTerminalEditorSide",
	"workbench.action.terminal.focusAtIndex1",
	"workbench.action.terminal.focusAtIndex2",
	"workbench.action.terminal.focusAtIndex3",
	"workbench.action.terminal.focusAtIndex4",
	"workbench.action.terminal.focusAtIndex5",
	"workbench.action.terminal.focusAtIndex6",
	"workbench.action.terminal.focusAtIndex7",
	"workbench.action.terminal.focusAtIndex8",
	"workbench.action.terminal.focusAtIndex9",
	"workbench.action.quickOpenTerm",
	// --- Debug ---
	"workbench.action.debug.configure",
	"workbench.action.debug.start",
	"workbench.action.debug.run",
	"workbench.action.debug.selectandstart",
	"workbench.action.openLaunchJson",
	"workbench.view.debug",
	// --- Tasks ---
	"workbench.action.tasks.runTask",
	"workbench.action.tasks.build",
	"workbench.action.tasks.test",
	"workbench.action.tasks.rerunForActiveTerminal",
	// --- Layout / visibility ---
	"workbench.action.toggleSidebarVisibility",
	"workbench.action.openActivityBar",
	"workbench.action.toggleActivityBarVisibility",
	"workbench.action.toggleStatusbarVisibility",
	"workbench.action.toggleAuxiliaryBar",
	"workbench.action.togglePanel",
	"workbench.action.toggleMenuBar",
	"workbench.action.customizeLayout",
	"workbench.action.toggleZenMode",
	"workbench.action.toggleFullScreen",
	"workbench.action.toggleCenteredLayout",
	// --- Sessions layout toggles ---
	"workbench.action.agentToggleSidebarVisibility",
	"workbench.action.agentToggleSecondarySidebarVisibility",
	"workbench.action.agentTogglePanelVisibility",
	// --- Output / views ---
	"workbench.action.output.toggleOutput",
	"workbench.view.testing",
	// --- Workspace config ---
	"workbench.action.openWorkspaceConfigFile",
	// --- Editor config ---
	"workbench.action.configureEditor",
	"workbench.action.configureEditorTabs",
	"workbench.action.configureEditorLayout",
	"workbench.action.openContextMenu",
	"workbench.action.quickOpenView",
	"workbench.action.showAllEditors",
	"workbench.action.showEditorsInActiveGroup",
	// --- Themes ---
	"workbench.action.selectTheme",
	"workbench.action.selectIconTheme",
	"workbench.action.selectProductIconTheme",
	"workbench.action.toggleLightDarkThemes",
	"workbench.action.browseColorThemesInMarketplace",
	// --- Remote ---
	"workbench.action.openRemoteWindow",
	"workbench.action.remote.showMenu",
	// --- AI / Copilot / Chat ---
	"workbench.action.chat.open",
	"workbench.action.chat.toggle",
	"workbench.action.chat.newChat",
	"workbench.action.chat.manage",
	"inlineChat.start",
	"inlineChat.askInChat",
	"inlineChat.acceptChanges",
	"inlineChat.discardHunkChange",
	"inlineChat.regenerate",
	"inlineChat.viewInChat",
	"inlineChat.toggleDiff",
	"inlineChat.focus",
	"inlineChat.submitInput",
	"inlineChat.hideInput",
	"interactiveEditor.start",
	"interactive.acceptChanges",
	"workbench.action.quickchat.toggle",
	// --- Command Palette / Quick Open ---
	"workbench.action.showCommands",
	"workbench.action.quickOpen",
	"workbench.action.quickOpenNavigateNext",
	"workbench.action.quickOpenNavigatePrevious",
	"workbench.action.quickOpenSelectNext",
	"workbench.action.quickOpenSelectPrevious",
	// --- Welcome / Getting Started ---
	"workbench.action.openWalkthrough",
	"welcome.showAllWalkthroughs",
	"welcome.markStepComplete",
	"welcome.markStepIncomplete",
];

const NourlmsStudentRestricted = new RawContextKey<boolean>(
	"nourlmsStudentRestricted",
	false,
);

class NourlmsStudentRestrictions
	extends Disposable
	implements IWorkbenchContribution
{
	static readonly ID = "workbench.contrib.nourlms.studentRestrictions";

	private readonly _terminalListener = this._register(new MutableDisposable());
	private readonly _studentRestrictedKey;

	constructor(
		@INourlmsAuthService nourlmsAuthService: INourlmsAuthService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ILogService private readonly logService: ILogService,
		@IWorkbenchLayoutService
		private readonly layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IPaneCompositePartService
		private readonly paneCompositePartService: IPaneCompositePartService,
		@IStorageService private readonly storageService: IStorageService,
		@IPreferencesService
		private readonly preferencesService: IPreferencesService,
		@IEditorGroupsService
		private readonly editorGroupsService: IEditorGroupsService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super();

		if (
			!nourlmsAuthService.isAuthenticated ||
			nourlmsAuthService.userInfo?.role !== "student"
		) {
			return;
		}

		this.logService.info("[NourLMS] Applying student restrictions");

		this._studentRestrictedKey =
			NourlmsStudentRestricted.bindTo(contextKeyService);
		this._studentRestrictedKey.set(true);

		this._hideUIParts();
		this._guardActivityBarHidden();
		this._injectStudentCSS();
		this._blockContextMenu();
		this._blockCommands();
		this._blockQuickInput();
		this._blockSettingsAccess();
		this._blockThemeChanges();
		this._applyStudentSettings();
		this._setupTerminalReadOnly();
		this._hideCommandsFromPalette();
		this._openExplorerSidebar();
		this._closeWelcomePage();
	}

	private _hideUIParts(): void {
		this.layoutService.setPartHidden(true, Parts.STATUSBAR_PART);
		this.layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART);
	}

	/**
	 * Guard against the activity bar being re-shown via Customize Layout or any setting change.
	 */
	private _guardActivityBarHidden(): void {
		// Re-hide if the part visibility changes (e.g. from Customize Layout toggle)
		this._register(
			this.layoutService.onDidChangePartVisibility((e) => {
				if (e.partId === Parts.ACTIVITYBAR_PART && e.visible) {
					this.layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART);
				}
			}),
		);

		// Re-hide if the setting is changed away from 'hidden'
		this._register(
			this.configurationService.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("workbench.activityBar.location")) {
					const current = this.configurationService.getValue<string>(
						"workbench.activityBar.location",
					);
					if (current !== "hidden") {
						this.configurationService.updateValue(
							"workbench.activityBar.location",
							"hidden",
						);
						this.layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART);
					}
				}
			}),
		);
	}

	private _injectStudentCSS(): void {
		const style = mainWindow.document.createElement("style");
		style.id = "nourlms-student-restrictions";
		style.textContent = [
			".monaco-workbench .part.activitybar { display: none !important; }",
			".monaco-workbench .part.titlebar > .titlebar-container > .titlebar-left > .menubar { display: none !important; }",
			".monaco-workbench .auxiliarybar { display: none !important; }",
			".monaco-workbench .action-item:has(.codicon-layout) { display: none !important; }",
			".monaco-workbench .sidebar .composite-title .actions-container .action-item:has(.codicon-settings-view-bar-icon) { display: none !important; }",
			".monaco-workbench .sidebar .composite-title .actions-container .action-item:has(.codicon-extensions-view-bar-icon) { display: none !important; }",
		].join("\n");
		mainWindow.document.head.appendChild(style);
	}

	private _blockContextMenu(): void {
		const handler = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			// Allow right-click in editor, panel, and sidebar (explorer file tree)
			if (
				target?.closest(".part.editor") ||
				target?.closest(".part.panel") ||
				target?.closest(".part.sidebar")
			) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
		};
		mainWindow.document.addEventListener("contextmenu", handler, true);
		this._register({
			dispose: () =>
				mainWindow.document.removeEventListener("contextmenu", handler, true),
		});
	}

	private async _openExplorerSidebar(): Promise<void> {
		await this.paneCompositePartService.openPaneComposite(
			"workbench.view.explorer",
			ViewContainerLocation.Sidebar,
			false,
		);
	}

	private _blockCommands(): void {
		const blocked = new Set(BLOCKED_COMMANDS_FOR_STUDENTS);
		const originalExecuteCommand = this.commandService.executeCommand.bind(
			this.commandService,
		);

		(this.commandService as any).executeCommand = function (
			command: string,
			...args: any[]
		) {
			if (blocked.has(command)) {
				return Promise.resolve();
			}
			return originalExecuteCommand(command, ...args);
		};
	}

	private _blockQuickInput(): void {
		const originalShow = this.quickInputService.quickAccess.show.bind(
			this.quickInputService.quickAccess,
		);
		(this.quickInputService.quickAccess as any).show = (
			prefix: string,
			options?: any,
		) => {
			if (prefix.startsWith(">")) {
				return;
			}
			return originalShow(prefix, options);
		};
	}

	private _hideCommandsFromPalette(): void {
		const disposables = new DisposableStore();
		this._register(disposables);

		for (const commandId of BLOCKED_COMMANDS_FOR_STUDENTS) {
			const d = MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
				command: {
					id: commandId,
					title: "",
				},
				when: ContextKeyExpr.equals("nourlmsStudentRestricted", false),
			});
			disposables.add(d);
		}
	}

	/**
	 * Block all settings/preferences UI access at the service level.
	 * This is a defense-in-depth layer: even if the command proxy is bypassed
	 * (e.g. Configure Editors menu item), the underlying service call is blocked.
	 */
	private _blockSettingsAccess(): void {
		const noop = () => Promise.resolve(undefined);
		const svc = this.preferencesService as any;
		svc.openSettings = noop;
		svc.openUserSettings = noop;
		svc.openApplicationSettings = noop;
		svc.openRemoteSettings = noop;
		svc.openWorkspaceSettings = noop;
		svc.openFolderSettings = noop;
		svc.openGlobalKeybindingSettings = noop;
		svc.openDefaultKeybindingsFile = noop;
		svc.openRawDefaultSettings = noop;
		svc.openLanguageSpecificSettings = noop;
		svc.openPreferences = noop;
	}

	/**
	 * Block students from changing the color theme at the service level.
	 */
	private _blockThemeChanges(): void {
		// Guard the setting: if student tries to change colorTheme, force it back
		this._register(
			this.configurationService.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("workbench.colorTheme")) {
					const current = this.configurationService.getValue<string>(
						"workbench.colorTheme",
					);
					if (current !== "Default Dark Modern") {
						this.configurationService.updateValue(
							"workbench.colorTheme",
							"Default Dark Modern",
						);
					}
				}
			}),
		);
	}

	private _applyStudentSettings(): void {
		const tryUpdate = (key: string, value: any) => {
			try {
				this.configurationService.updateValue(key, value);
			} catch {
				// setting not registered yet, ignore
			}
		};
		tryUpdate("git.enabled", false);
		tryUpdate("extensions.autoUpdate", false);
		tryUpdate("extensions.autoCheckUpdates", false);
		tryUpdate("workbench.localHistory.enabled", false);
		tryUpdate("terminal.integrated.defaultProfile.linux", "bash");
		tryUpdate("terminal.integrated.shellIntegration.enabled", true);
		tryUpdate("chat.disableAIFeatures", true);
		tryUpdate("window.menuBarVisibility", "hidden");
		tryUpdate("workbench.activityBar.location", "hidden");
		tryUpdate("workbench.startupEditor", "none");
		tryUpdate("workbench.colorTheme", "Default Dark Modern");
		this.storageService.store(
			"workbench.activity.showAccounts",
			false,
			StorageScope.PROFILE,
			StorageTarget.USER,
		);
	}

	private _setupTerminalReadOnly(): void {
		let codeIsRunning = false;
		const patchedInstances = new WeakSet<ITerminalInstance>();

		const patchInstance = (instance: ITerminalInstance) => {
			if (patchedInstances.has(instance)) {
				return;
			}
			patchedInstances.add(instance);

			const store = new DisposableStore();
			let commandRunning = false;
			let sawChildren = false;

			// Mark the instance so TerminalInstance core code respects read-only
			instance.nourlmsReadOnly = true;
			instance.nourlmsAllowInput = false;

			const lockTerminal = () => {
				instance.nourlmsAllowInput = false;
				const xterm = instance.xterm;
				if (xterm) {
					xterm.raw.options.disableStdin = true;
				}
			};

			const unlockTerminal = () => {
				instance.nourlmsAllowInput = true;
				const xterm = instance.xterm;
				if (xterm) {
					xterm.raw.options.disableStdin = false;
				}
			};

			const markRunStart = () => {
				if (!commandRunning) {
					commandRunning = true;
					codeIsRunning = true;
					sawChildren = false;
					unlockTerminal();
					this.logService.info(
						"[NourLMS] Terminal: code execution started, stdin enabled",
					);
				}
			};

			const markRunEnd = () => {
				if (commandRunning) {
					commandRunning = false;
					codeIsRunning = false;
					sawChildren = false;
					lockTerminal();
					this.logService.info(
						"[NourLMS] Terminal: code execution finished, stdin disabled",
					);
				}
			};

			// Wire CommandDetection — fires per finished command (e.g. `python script.py`)
			const wireCommandDetection = () => {
				const cmdDetect = instance.capabilities.get(
					TerminalCapability.CommandDetection,
				);
				if (cmdDetect) {
					store.add(cmdDetect.onCommandFinished(() => markRunEnd()));
				}
				const partialDetect = instance.capabilities.get(
					TerminalCapability.PartialCommandDetection,
				);
				if (partialDetect) {
					store.add(partialDetect.onCommandFinished(() => markRunEnd()));
				}
			};
			store.add(
				instance.capabilities.onDidAddCommandDetectionCapability(() =>
					wireCommandDetection(),
				),
			);
			wireCommandDetection();

			// Lock immediately once xterm is ready, and keep enforcing
			instance.xtermReadyPromise.then((xterm) => {
				if (xterm && !commandRunning) {
					xterm.raw.options.disableStdin = true;
				}
			});

			// Safety net: re-assert disableStdin every 200ms in case anything
			// (reconnect, waitOnExit, addon) flips it back.
			const enforceInterval = setInterval(() => {
				if (!commandRunning) {
					const xterm = instance.xterm;
					if (xterm) {
						xterm.raw.options.disableStdin = true;
					}
				}
			}, 200);

			// Hook sendText — "Run Active File" / Code Runner / etc.
			const originalSendText = instance.sendText.bind(instance);
			(instance as any).sendText = function (
				text: string,
				shouldExecute?: boolean,
				bracketedPasteMode?: boolean,
			) {
				if (shouldExecute !== false) {
					markRunStart();
				}
				return originalSendText(
					text,
					shouldExecute ?? true,
					bracketedPasteMode,
				);
			};

			const originalSendPath = (instance as any).sendPath?.bind(instance);
			if (originalSendPath) {
				(instance as any).sendPath = function (
					originalPath: string | any,
					shouldExecute?: boolean,
				) {
					markRunStart();
					return originalSendPath(originalPath, shouldExecute);
				};
			}

			// Backup signal: child process exits (works without shell integration)
			store.add(
				instance.onDidChangeHasChildProcesses((hasChildren: boolean) => {
					if (hasChildren) {
						sawChildren = true;
					} else if (sawChildren && commandRunning) {
						markRunEnd();
					}
				}),
			);

			// Cleanup on shell exit
			store.add(
				instance.onExit(() => {
					markRunEnd();
					clearInterval(enforceInterval);
				}),
			);

			this._register(store);
			this._register({ dispose: () => clearInterval(enforceInterval) });
		};

		// --- 1. Patch ALL existing terminal instances (restored from previous session) ---
		for (const instance of this.terminalService.instances) {
			patchInstance(instance);
		}

		// --- 2. Patch every future terminal instance ---
		this._terminalListener.value = this.terminalService.onDidCreateInstance(
			(instance: ITerminalInstance) => {
				patchInstance(instance);
			},
		);

		// --- 3. Block terminal creation while code is running ---
		const originalCreateTerminal = this.terminalService.createTerminal.bind(
			this.terminalService,
		);
		(this.terminalService as any).createTerminal = (config?: any) => {
			if (codeIsRunning) {
				this.logService.info(
					"[NourLMS] Blocked terminal creation — code is running",
				);
				return Promise.resolve(undefined);
			}
			return originalCreateTerminal(config);
		};

		// --- 4. Dispose extra terminals that sneak in while code runs ---
		this._register(
			this.terminalService.onDidChangeInstances(() => {
				if (codeIsRunning && this.terminalService.instances.length > 1) {
					const extras = this.terminalService.instances.slice(1);
					for (const extra of extras) {
						extra.dispose();
					}
				}
			}),
		);
	}

	private _closeWelcomePage(): void {
		for (const group of this.editorGroupsService.groups) {
			const welcomeEditors = group.editors.filter(
				(e) => e.typeId === gettingStartedInputTypeId,
			);
			for (const editor of welcomeEditors) {
				group.closeEditor(editor);
			}
		}
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
		WorkbenchPhase.AfterRestored,
	);
}
