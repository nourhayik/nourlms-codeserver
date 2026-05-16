/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import type { Homework, HomeworkSubmission } from './types.js';

/**
 * Routes the Homework editor pane can show. Each route is a stack frame
 * pushed onto the router. Closing the editor wipes the stack.
 */
export type HomeworkRoute =
	| { kind: 'home' }
	| { kind: 'studentHomework'; homeworkId: number; preloaded?: Homework }
	| { kind: 'submission'; homeworkId: number; submissionId: number; isAdmin: boolean; preloaded?: HomeworkSubmission }
	| { kind: 'aiResult'; resultId: number }
	| { kind: 'adminQuestionBank' }
	| { kind: 'adminAssigned' }
	| { kind: 'adminQuestion'; questionId: number }
	| { kind: 'newQuestion' };

export interface HomeworkRouteRecord {
	readonly route: HomeworkRoute;
	readonly title: string;
}

export interface IHomeworkRouterController {
	push(route: HomeworkRoute, title: string): void;
	replace(route: HomeworkRoute, title: string): void;
	pop(): void;
	popTo(predicate: (record: HomeworkRouteRecord) => boolean): void;
	resetTo(route: HomeworkRoute, title: string): void;
}

export interface ScreenContext extends IHomeworkRouterController {
	readonly userInfo: { readonly role: 'admin' | 'student'; readonly userId?: number };
}

/**
 * A "Screen" mounts itself into a host element, returns a disposable, and
 * has no other interaction with the editor pane (the router callback is
 * passed in via ScreenContext).
 */
export interface IHomeworkScreen extends IDisposable {
	mount(parent: HTMLElement, ctx: ScreenContext): void;
}

export class HomeworkRouter extends Disposable {

	private _stack: HomeworkRouteRecord[] = [];

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	get stack(): readonly HomeworkRouteRecord[] {
		return this._stack;
	}

	get current(): HomeworkRouteRecord | undefined {
		return this._stack[this._stack.length - 1];
	}

	get canGoBack(): boolean {
		return this._stack.length > 1;
	}

	push(route: HomeworkRoute, title: string): void {
		this._stack.push({ route, title });
		this._onDidChange.fire();
	}

	replace(route: HomeworkRoute, title: string): void {
		if (this._stack.length === 0) {
			this.push(route, title);
			return;
		}
		this._stack[this._stack.length - 1] = { route, title };
		this._onDidChange.fire();
	}

	pop(): void {
		if (this._stack.length <= 1) {
			return;
		}
		this._stack.pop();
		this._onDidChange.fire();
	}

	popTo(predicate: (record: HomeworkRouteRecord) => boolean): void {
		// Pop until either (a) the predicate matches the new top, or (b) only one
		// frame remains. Always fire `onDidChange` if we actually popped anything,
		// otherwise the breadcrumb click would silently leave the pane on the old
		// route.
		let changed = false;
		while (this._stack.length > 1) {
			const top = this._stack[this._stack.length - 1];
			if (predicate(top)) {
				break;
			}
			this._stack.pop();
			changed = true;
		}
		if (changed) {
			this._onDidChange.fire();
		}
	}

	resetTo(route: HomeworkRoute, title: string): void {
		this._stack = [{ route, title }];
		this._onDidChange.fire();
	}

	clear(): void {
		this._stack = [];
		this._onDidChange.fire();
	}
}
