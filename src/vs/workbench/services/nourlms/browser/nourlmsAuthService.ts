/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { INourlmsAuthService, INourlmsUserInfo, NourlmsContextKeys } from '../common/nourlms.js';

export class NourlmsAuthService extends Disposable implements INourlmsAuthService {
	declare readonly _serviceBrand: undefined;

	private readonly _userInfo: INourlmsUserInfo | undefined;
	private readonly _isStudentContextKey: IContextKey<boolean>;
	private readonly _isAdminContextKey: IContextKey<boolean>;
	private readonly _isAuthenticatedContextKey: IContextKey<boolean>;
	private readonly _roleContextKey: IContextKey<string>;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		this._isStudentContextKey = new RawContextKey<boolean>(NourlmsContextKeys.IsStudent, false).bindTo(contextKeyService);
		this._isAdminContextKey = new RawContextKey<boolean>(NourlmsContextKeys.IsAdmin, false).bindTo(contextKeyService);
		this._isAuthenticatedContextKey = new RawContextKey<boolean>(NourlmsContextKeys.IsAuthenticated, false).bindTo(contextKeyService);
		this._roleContextKey = new RawContextKey<string>(NourlmsContextKeys.Role, '').bindTo(contextKeyService);

		this._userInfo = this._readUserInfoFromDom();

		if (this._userInfo) {
			this._isAuthenticatedContextKey.set(true);
			this._roleContextKey.set(this._userInfo.role);
			this._isStudentContextKey.set(this._userInfo.role === 'student');
			this._isAdminContextKey.set(this._userInfo.role === 'admin');
		}
	}

	get userInfo(): INourlmsUserInfo | undefined {
		return this._userInfo;
	}

	get isAuthenticated(): boolean {
		return !!this._userInfo;
	}

	async logout(): Promise<void> {
		const form = document.createElement('form');
		form.method = 'POST';
		form.action = '/nourlms-logout';
		document.body.appendChild(form);
		form.submit();
	}

	private _readUserInfoFromDom(): INourlmsUserInfo | undefined {
		try {
			const element = document.getElementById('vscode-nourlms-user');
			if (!element) {
				return undefined;
			}
			const raw = element.getAttribute('data-settings');
			if (!raw || raw === '' || raw === 'undefined') {
				return undefined;
			}
			const parsed = JSON.parse(raw);
			if (parsed && parsed.name && parsed.role) {
				return {
					name: parsed.name,
					role: parsed.role,
					workspacePath: parsed.workspacePath || '',
				};
			}
		} catch {
			// ignore
		}
		return undefined;
	}
}
