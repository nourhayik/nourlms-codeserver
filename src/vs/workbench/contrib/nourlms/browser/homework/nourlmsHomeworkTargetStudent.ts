/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { asJson } from '../../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { INourlmsAuthService } from '../../../../services/nourlms/common/nourlms.js';

export interface TargetStudent {
	userId: number;
	name: string;
	workspacePath: string;
}

export const INourlmsHomeworkTargetStudentService = createDecorator<INourlmsHomeworkTargetStudentService>('nourlmsHomeworkTargetStudentService');

export interface INourlmsHomeworkTargetStudentService {
	readonly _serviceBrand: undefined;
	readonly current: TargetStudent | undefined;
	readonly onDidChange: Event<TargetStudent | undefined>;
}

export class NourlmsHomeworkTargetStudentService extends Disposable implements INourlmsHomeworkTargetStudentService {

	declare readonly _serviceBrand: undefined;

	private _current: TargetStudent | undefined;
	private readonly _onDidChange = new Emitter<TargetStudent | undefined>();

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IRequestService private readonly requestService: IRequestService,
		@INourlmsAuthService private readonly authService: INourlmsAuthService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		if (this.authService.userInfo?.role !== 'admin') {
			return;
		}

		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.resolveTarget()));
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.resolveTarget()));
		this.resolveTarget();
	}

	get current(): TargetStudent | undefined {
		return this._current;
	}

	get onDidChange(): Event<TargetStudent | undefined> {
		return this._onDidChange.event;
	}

	private async resolveTarget(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			this.setTarget(undefined);
			return;
		}

		const folderPath = folders[0].uri.fsPath;
		try {
			const context = await this.requestService.request({
				type: 'GET',
				url: `/nourlms-workspaces/lookup?path=${encodeURIComponent(folderPath)}`,
			}, CancellationToken.None);

			const result = await asJson<{ userId: number; name: string; sanitizedName: string; path: string }>(context);
			if (result && typeof result.userId === 'number' && result.userId > 0) {
				this.setTarget({
					userId: result.userId,
					name: result.name,
					workspacePath: result.path,
				});
			} else {
				this.setTarget(undefined);
			}
		} catch {
			this._logService.trace('[NourlmsHomeworkTargetStudent] Failed to resolve target workspace');
			this.setTarget(undefined);
		}
	}

	private setTarget(target: TargetStudent | undefined): void {
		if (this._current && target && this._current.userId === target.userId) {
			return;
		}
		this._current = target;
		this._onDidChange.fire(target);
	}

	override dispose(): void {
		this._onDidChange.dispose();
		super.dispose();
	}
}
