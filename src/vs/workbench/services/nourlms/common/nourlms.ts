/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

export const INourlmsAuthService = createDecorator<INourlmsAuthService>('nourlmsAuthService');

export interface INourlmsUserInfo {
	readonly name: string;
	readonly role: 'admin' | 'student';
	readonly workspacePath: string;
	readonly userId: number | undefined;
}

export interface INourlmsAuthService {
	readonly _serviceBrand: undefined;
	readonly userInfo: INourlmsUserInfo | undefined;
	readonly isAuthenticated: boolean;
	readonly onDidLogout: Event<void>;
	logout(): Promise<void>;
}

export namespace NourlmsContextKeys {
	export const IsStudent = 'nourlmsIsStudent';
	export const IsAdmin = 'nourlmsIsAdmin';
	export const Role = 'nourlmsRole';
	export const IsAuthenticated = 'nourlmsIsAuthenticated';
}
