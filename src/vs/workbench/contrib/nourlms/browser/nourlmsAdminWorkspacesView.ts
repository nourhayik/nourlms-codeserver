/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { append, $ } from '../../../../base/browser/dom.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { asJson } from '../../../../platform/request/common/request.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';

export const NOURLMS_WORKSPACES_VIEW_ID = 'workbench.view.nourlms.workspaces.main';

interface IWorkspaceInfo {
	name: string;
	path: string;
}

export class NourlmsWorkspacesView extends ViewPane {

	private workspaces: IWorkspaceInfo[] = [];
	private container!: HTMLElement;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible) {
			this.fetchWorkspaces();
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this.container = append(container, $('.nourlms-workspaces'));
		this.container.style.padding = '0';
		this.fetchWorkspaces();
	}

	private async fetchWorkspaces(): Promise<void> {
		try {
			const context = await this.requestService.request({
				type: 'GET',
				url: '/nourlms-workspaces',
			}, CancellationToken.None);

			const result = await asJson<{ workspaces: IWorkspaceInfo[] }>(context);
			if (result?.workspaces) {
				this.workspaces = result.workspaces;
				this.renderWorkspaces();
			}
		} catch (e) {
			this.logService.error('[NourLMS] Failed to fetch workspaces', e);
			this.renderError();
		}
	}

	private renderWorkspaces(): void {
		this.container.textContent = '';

		if (this.workspaces.length === 0) {
			const empty = append(this.container, $('.nourlms-workspaces-empty'));
			empty.textContent = localize('noWorkspaces', "No student workspaces found.");
			empty.style.padding = '10px 14px';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			empty.style.fontSize = '12px';
			return;
		}

		const list = append(this.container, $('.nourlms-workspaces-list'));
		list.style.listStyle = 'none';
		list.style.padding = '0';
		list.style.margin = '0';

		for (const workspace of this.workspaces) {
			const item = append(list, $('.nourlms-workspaces-item'));
			item.style.display = 'flex';
			item.style.alignItems = 'center';
			item.style.padding = '6px 14px';
			item.style.cursor = 'pointer';
			item.style.borderBottom = '1px solid var(--vscode-widget-border, transparent)';
			item.title = workspace.path;

			const icon = append(item, $('span'));
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.folder));
			icon.style.marginRight = '8px';
			icon.style.fontSize = '14px';
			icon.style.color = 'var(--vscode-icon-foreground)';

			const label = append(item, $('span'));
			label.textContent = workspace.name;
			label.style.fontSize = '13px';
			label.style.overflow = 'hidden';
			label.style.textOverflow = 'ellipsis';
			label.style.whiteSpace = 'nowrap';

			const openWorkspace = () => {
				const separatorIndex = window.location.href.indexOf('?');
				const baseUrl = separatorIndex > 0 ? window.location.href.substring(0, separatorIndex) : window.location.href;
				const url = `${baseUrl}?folder=${encodeURIComponent(workspace.path)}`;
				window.location.href = url;
			};

			item.addEventListener('click', openWorkspace);
		}
	}

	private renderError(): void {
		this.container.textContent = '';
		const errorEl = append(this.container, $('.nourlms-workspaces-error'));
		errorEl.textContent = localize('workspacesError', "Failed to load workspaces.");
		errorEl.style.padding = '10px 14px';
		errorEl.style.color = 'var(--vscode-errorForeground)';
		errorEl.style.fontSize = '12px';
	}
}