/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { INourlmsAuthService } from '../../../../services/nourlms/common/nourlms.js';
import { INourlmsHomeworkApi } from './nourlmsHomeworkApi.js';

export interface IHomeworkPollingRegistry {
	readonly _serviceBrand: undefined;
	poll(opts: PollOptions): { onState: Event<PollState>; cancel: IDisposable };
	cancelAll(): void;
}

export const IHomeworkPollingRegistry = createDecorator<IHomeworkPollingRegistry>('homeworkPollingRegistry');

export interface PollOptions {
	homeworkId: number;
	submissionId: number;
}

export type PollState =
	| { kind: 'pending'; attempts: number }
	| { kind: 'ready'; resultId: number; gradedAt: string }
	| { kind: 'transient-error'; attempts: number; lastStatus?: number }
	| { kind: 'gave-up'; attempts: number; reason: string };

interface PollerEntry {
	homeworkId: number;
	submissionId: number;
	state: PollState;
	attempts: number;
	consecutiveErrors: number;
	nextDelayMs: number;
	cancellation: CancellationTokenSource;
	onChange: Emitter<PollState>;
	timer: ReturnType<typeof setTimeout> | undefined;
	active: boolean;
}

const INITIAL_DELAY = 2000;
const BACKOFF_MULTIPLIER = 1.5;
const CAP_DELAY = 15000;
const JITTER_FACTOR = 0.2;
const MAX_ATTEMPTS = 60;
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_CONCURRENT = 5;

export class HomeworkPollingRegistry extends Disposable implements IHomeworkPollingRegistry {

	declare readonly _serviceBrand: undefined;

	private readonly entries = new Map<string, PollerEntry>();
	private readonly waitQueue: PollerEntry[] = [];
	private activeCount = 0;

	constructor(
		@INourlmsHomeworkApi private readonly api: INourlmsHomeworkApi,
		@ILogService _logService: ILogService,
		@INourlmsAuthService authService: INourlmsAuthService,
	) {
		super();
		void _logService;
		this._register(authService.onDidLogout(() => this.cancelAll()));
	}

	poll(opts: PollOptions): { onState: Event<PollState>; cancel: IDisposable } {
		const key = `${opts.homeworkId}:${opts.submissionId}`;
		const existing = this.entries.get(key);
		if (existing) {
			return { onState: existing.onChange.event, cancel: existing.cancellation };
		}

		const emitter = new Emitter<PollState>();
		const cts = new CancellationTokenSource();
		const entry: PollerEntry = {
			homeworkId: opts.homeworkId,
			submissionId: opts.submissionId,
			state: { kind: 'pending', attempts: 0 },
			attempts: 0,
			consecutiveErrors: 0,
			nextDelayMs: INITIAL_DELAY,
			cancellation: cts,
			onChange: emitter,
			timer: undefined,
			active: false,
		};

		this.entries.set(key, entry);

		if (this.activeCount < MAX_CONCURRENT) {
			this.activeCount++;
			entry.active = true;
			this.scheduleNext(entry);
		} else {
			this.waitQueue.push(entry);
		}

		cts.token.onCancellationRequested(() => {
			this.cancelEntry(entry);
		});

		return {
			onState: emitter.event,
			cancel: { dispose: () => cts.cancel() },
		};
	}

	private scheduleNext(entry: PollerEntry): void {
		if (entry.cancellation.token.isCancellationRequested) {
			this.finishEntry(entry);
			return;
		}

		const jitter = entry.nextDelayMs * JITTER_FACTOR * (Math.random() * 2 - 1);
		const delay = Math.max(500, entry.nextDelayMs + jitter);

		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			this.doPoll(entry);
		}, delay);
	}

	private async doPoll(entry: PollerEntry): Promise<void> {
		if (entry.cancellation.token.isCancellationRequested) {
			this.finishEntry(entry);
			return;
		}

		entry.attempts++;
		try {
			const result = await this.api.pollAiResultStatus(entry.homeworkId, entry.submissionId, entry.cancellation.token);
			entry.consecutiveErrors = 0;

			if (result.state === 'ready' && result.result_id) {
				entry.state = { kind: 'ready', resultId: result.result_id, gradedAt: result.graded_at ?? new Date().toISOString() };
				entry.onChange.fire(entry.state);
				this.finishEntry(entry);
				return;
			}

			if (entry.attempts >= MAX_ATTEMPTS) {
				entry.state = { kind: 'gave-up', attempts: entry.attempts, reason: 'Max attempts reached' };
				entry.onChange.fire(entry.state);
				this.finishEntry(entry);
				return;
			}

			entry.state = { kind: 'pending', attempts: entry.attempts };
			entry.onChange.fire(entry.state);
			entry.nextDelayMs = Math.min(CAP_DELAY, entry.nextDelayMs * BACKOFF_MULTIPLIER);
			this.scheduleNext(entry);
		} catch (err: any) {
			const status = err?.status;
			if (status && status >= 500) {
				entry.consecutiveErrors++;
			} else if (status && status < 500) {
				entry.state = { kind: 'gave-up', attempts: entry.attempts, reason: `HTTP ${status}` };
				entry.onChange.fire(entry.state);
				this.finishEntry(entry);
				return;
			} else {
				entry.consecutiveErrors++;
			}

			if (entry.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
				entry.state = { kind: 'gave-up', attempts: entry.attempts, reason: 'Too many errors' };
				entry.onChange.fire(entry.state);
				this.finishEntry(entry);
				return;
			}

			if (entry.attempts >= MAX_ATTEMPTS) {
				entry.state = { kind: 'gave-up', attempts: entry.attempts, reason: 'Max attempts reached' };
				entry.onChange.fire(entry.state);
				this.finishEntry(entry);
				return;
			}

			entry.state = { kind: 'transient-error', attempts: entry.attempts, lastStatus: status };
			entry.onChange.fire(entry.state);
			entry.nextDelayMs = Math.min(CAP_DELAY, entry.nextDelayMs * BACKOFF_MULTIPLIER);
			this.scheduleNext(entry);
		}
	}

	private cancelEntry(entry: PollerEntry): void {
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		entry.cancellation.cancel();
		this.finishEntry(entry);
	}

	private finishEntry(entry: PollerEntry): void {
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		const key = `${entry.homeworkId}:${entry.submissionId}`;
		if (!this.entries.has(key)) {
			return;
		}
		this.entries.delete(key);
		entry.onChange.dispose();

		if (entry.active) {
			entry.active = false;
			this.activeCount = Math.max(0, this.activeCount - 1);
		} else {
			const queueIdx = this.waitQueue.indexOf(entry);
			if (queueIdx !== -1) {
				this.waitQueue.splice(queueIdx, 1);
			}
		}

		while (this.waitQueue.length > 0 && this.activeCount < MAX_CONCURRENT) {
			const next = this.waitQueue.shift()!;
			if (next.cancellation.token.isCancellationRequested) {
				continue;
			}
			this.activeCount++;
			next.active = true;
			this.scheduleNext(next);
		}
	}

	cancelAll(): void {
		for (const entry of this.entries.values()) {
			if (entry.timer !== undefined) {
				clearTimeout(entry.timer);
			}
			entry.cancellation.cancel();
			entry.onChange.dispose();
		}
		this.entries.clear();
		this.waitQueue.length = 0;
		this.activeCount = 0;
	}

	override dispose(): void {
		this.cancelAll();
		super.dispose();
	}
}
