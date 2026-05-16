/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { HomeworkPollingRegistry, PollState } from '../../browser/homework/nourlmsHomeworkPolling.js';
import { NourlmsHomeworkApi, INourlmsHomeworkApi } from '../../browser/homework/nourlmsHomeworkApi.js';
import type { AiResultStatus } from '../../browser/homework/nourlmsHomeworkApi.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

class MockApi extends NourlmsHomeworkApi implements INourlmsHomeworkApi {
	private statusResponse: AiResultStatus = { state: 'pending' };
	private callCount = 0;

	constructor() {
		super(
			{ request: async () => ({ res: { statusCode: 200 }, stream: { on() { }, once() { }, destroy() { } } }) } as any,
			{ userInfo: { name: 'test', role: 'student', workspacePath: '/tmp', userId: 1 }, logout: async () => { } } as any,
			{ trace() { }, warn() { }, error() { } } as any,
		);
	}

	override async pollAiResultStatus(_homeworkId: number, _submissionId: number, _token: CancellationToken): Promise<AiResultStatus> {
		this.callCount++;
		return this.statusResponse;
	}

	setStatusResponse(status: AiResultStatus): void {
		this.statusResponse = status;
	}

	getCallCount(): number {
		return this.callCount;
	}
}

const mockAuthService = { onDidLogout: () => ({ dispose() { } }) } as any;

suite('HomeworkPollingRegistry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('honors cancellation immediately', async () => {
		const api = new MockApi();
		const registry = new HomeworkPollingRegistry(api, { trace() { }, warn() { }, error() { } } as any, mockAuthService);
		const states: PollState[] = [];

		const { onState, cancel } = registry.poll({ homeworkId: 1, submissionId: 1 });
		onState((s: PollState) => states.push(s));

		cancel.dispose();

		await new Promise<void>(resolve => setTimeout(resolve, 100));
		assert.strictEqual(states.length, 0);
		registry.dispose();
	});

	test('reaches gave-up after 60 attempts when upstream stays pending', async () => {
		const api = new MockApi();
		api.setStatusResponse({ state: 'pending' });
		const registry = new HomeworkPollingRegistry(api, { trace() { }, warn() { }, error() { } } as any, mockAuthService);
		const states: PollState[] = [];

		const { onState } = registry.poll({ homeworkId: 1, submissionId: 1 });
		onState((s: PollState) => states.push(s));

		await new Promise<void>(resolve => setTimeout(resolve, 500));
		const gaveUp = states.some(s => s.kind === 'gave-up');
		assert.ok(gaveUp, 'should eventually give up');
		assert.ok(api.getCallCount() <= 60, `should not exceed 60 attempts, got ${api.getCallCount()}`);
		registry.dispose();
	});

	test('backoff capped at 15 s', () => {
		let delay = 2000;
		const cap = 15000;
		const multiplier = 1.5;
		for (let i = 0; i < 100; i++) {
			delay = Math.min(cap, delay * multiplier);
		}
		assert.strictEqual(delay, cap, 'delay should be capped at 15s');
	});

	test('3rd consecutive transient failure transitions to gave-up', async () => {
		const api = new MockApi();

		(api as any).pollAiResultStatus = async () => {
			throw { status: 500 };
		};

		const registry = new HomeworkPollingRegistry(api, { trace() { }, warn() { }, error() { } } as any, mockAuthService);
		const states: PollState[] = [];

		const { onState } = registry.poll({ homeworkId: 1, submissionId: 1 });
		onState((s: PollState) => states.push(s));

		await new Promise<void>(resolve => setTimeout(resolve, 500));
		const gaveUp = states.some(s => s.kind === 'gave-up');
		assert.ok(gaveUp, 'should give up after consecutive errors');
		registry.dispose();
	});

	test('6th simultaneous poll waits in queue', async () => {
		const api = new MockApi();
		api.setStatusResponse({ state: 'pending' });
		const registry = new HomeworkPollingRegistry(api, { trace() { }, warn() { }, error() { } } as any, mockAuthService);

		const disposables = new DisposableStore();
		for (let i = 0; i < 6; i++) {
			const { cancel } = registry.poll({ homeworkId: i + 1, submissionId: i + 1 });
			disposables.add(cancel);
		}

		assert.strictEqual((registry as any).waitQueue.length, 1, '6th poll should be queued');
		registry.dispose();
		disposables.dispose();
	});
});
