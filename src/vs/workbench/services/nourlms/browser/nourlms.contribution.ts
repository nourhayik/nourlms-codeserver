/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { NourlmsAuthService } from './nourlmsAuthService.js';
import { INourlmsAuthService } from '../common/nourlms.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

registerSingleton(INourlmsAuthService, NourlmsAuthService, InstantiationType.Eager);
