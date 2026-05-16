/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IUntypedEditorInput } from '../../../../common/editor.js';

export const NOURLMS_HOMEWORK_EDITOR_INPUT_TYPE_ID = 'workbench.editors.nourlmsHomeworkInput';
export const NOURLMS_HOMEWORK_EDITOR_RESOURCE = URI.from({
	scheme: Schemas.vscode,
	authority: 'nourlms-homework',
	path: '/homework',
});

export class NourlmsHomeworkEditorInput extends EditorInput {

	static readonly ID = NOURLMS_HOMEWORK_EDITOR_INPUT_TYPE_ID;

	override get typeId(): string {
		return NourlmsHomeworkEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	override get resource(): URI {
		return NOURLMS_HOMEWORK_EDITOR_RESOURCE;
	}

	override getName(): string {
		return localize('nourlms.homework.editor.title', "Homework");
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: NOURLMS_HOMEWORK_EDITOR_RESOURCE,
			options: {
				override: NourlmsHomeworkEditorInput.ID,
				pinned: true,
			},
		};
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof NourlmsHomeworkEditorInput;
	}
}
