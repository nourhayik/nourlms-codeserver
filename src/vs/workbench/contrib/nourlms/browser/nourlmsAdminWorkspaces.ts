/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewContainersRegistry, IViewsRegistry, Extensions, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { NourlmsWorkspacesView, NOURLMS_WORKSPACES_VIEW_ID } from './nourlmsAdminWorkspacesView.js';
import { NourlmsContextKeys } from '../../../services/nourlms/common/nourlms.js';

const NOURLMS_WORKSPACES_VIEWLET_ID = 'workbench.view.nourlms.workspaces';

const nourlmsWorkspacesIcon = registerIcon('nourlms-workspaces-view-icon', Codicon.organization, localize('nourlmsWorkspacesViewIcon', 'View icon of the NourLMS workspaces view.'));

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);

const nourlmsWorkspacesViewContainer = viewContainerRegistry.registerViewContainer(
	{
		id: NOURLMS_WORKSPACES_VIEWLET_ID,
		title: localize2('nourlmsWorkspaces', "Student Workspaces"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [NOURLMS_WORKSPACES_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
		icon: nourlmsWorkspacesIcon,
		order: 5,
		hideIfEmpty: true,
	},
	ViewContainerLocation.Sidebar
);

viewsRegistry.registerViews(
	[{
		id: NOURLMS_WORKSPACES_VIEW_ID,
		name: localize2('nourlmsWorkspacesView', "Student Workspaces"),
		ctorDescriptor: new SyncDescriptor(NourlmsWorkspacesView),
		canToggleVisibility: false,
		when: ContextKeyExpr.equals(NourlmsContextKeys.IsAdmin, true),
	}],
	nourlmsWorkspacesViewContainer
);
