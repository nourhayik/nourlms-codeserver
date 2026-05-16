/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, $ } from '../../../../../../base/browser/dom.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { localize } from '../../../../../../nls.js';
import type { Question } from '../types.js';

/**
 * Defensive HTML escape. Coerces null/undefined/numbers to a string first,
 * which fixes the previous "Cannot read properties of undefined (reading
 * 'replace')" crash when a submission/AI-result field was missing.
 */
export function escapeHtml(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	const str = typeof value === 'string' ? value : String(value);
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function safeText(value: unknown, fallback: string = ''): string {
	if (value === null || value === undefined) {
		return fallback;
	}
	return typeof value === 'string' ? value : String(value);
}

export function formatDate(value: unknown): string {
	if (value === null || value === undefined || value === '') {
		return localize('nourlms.homework.unknownDate', "—");
	}
	const date = new Date(typeof value === 'string' ? value : String(value));
	if (isNaN(date.getTime())) {
		return safeText(value);
	}
	return date.toLocaleString();
}

/**
 * Resolves the question's type "key" defensively. The upstream API has
 * historically returned this as either a plain string ("code") or as a
 * nested object ({ key: "code", ... }). The old code only checked for the
 * string form, which is why the "Assign to current student" button stayed
 * disabled forever even on real code questions.
 */
export function getQuestionTypeKey(q: Question): string | undefined {
	const raw: unknown = (q as any).question_type;
	if (typeof raw === 'string') {
		return raw;
	}
	if (raw && typeof raw === 'object') {
		const obj = raw as { key?: unknown; name?: unknown; type?: unknown };
		if (typeof obj.key === 'string') { return obj.key; }
		if (typeof obj.name === 'string') { return obj.name; }
		if (typeof obj.type === 'string') { return obj.type; }
	}
	return undefined;
}

export function isCodeQuestion(q: Question): boolean {
	const key = getQuestionTypeKey(q);
	return key === 'code';
}

export function shortQuestionPreview(q: Question, fallbackId: number | string = q.id ?? '?'): string {
	const stripped = (q.content ?? '').replace(/<[^>]*>/g, '').trim();
	if (stripped.length > 0) {
		return stripped.length > 100 ? stripped.substring(0, 100) + '…' : stripped;
	}
	return localize('nourlms.homework.untitledQuestion', "Question #{0}", String(fallbackId));
}

export function appendIcon(parent: HTMLElement, codicon: ThemeIcon): HTMLElement {
	const span = append(parent, $('span'));
	span.classList.add(...ThemeIcon.asClassNameArray(codicon));
	return span;
}

export function appendLoadingRow(parent: HTMLElement, label?: string): HTMLElement {
	const row = append(parent, $('.nourlms-hw-loading'));
	append(row, $('.nourlms-hw-spinner'));
	const text = append(row, $('span'));
	text.textContent = label ?? localize('nourlms.homework.loading', "Loading…");
	return row;
}

export function appendErrorRow(parent: HTMLElement, message: string): HTMLElement {
	const row = append(parent, $('.nourlms-hw-error'));
	row.textContent = message;
	return row;
}

export function appendEmptyRow(parent: HTMLElement, title: string, hint?: string, icon: ThemeIcon = Codicon.book): HTMLElement {
	const empty = append(parent, $('.nourlms-hw-empty'));
	const iconEl = append(empty, $('.nourlms-hw-empty__icon'));
	iconEl.classList.add(...ThemeIcon.asClassNameArray(icon));
	const titleEl = append(empty, $('.nourlms-hw-empty__title'));
	titleEl.textContent = title;
	if (hint) {
		const hintEl = append(empty, $('.nourlms-hw-empty__hint'));
		hintEl.textContent = hint;
	}
	return empty;
}

export function initials(name: string | undefined | null): string {
	if (!name) { return '?'; }
	return name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map(part => part[0]?.toUpperCase() ?? '')
		.join('') || '?';
}

/**
 * Returns the modifier CSS class for a grade pill / badge based on the
 * 0..100 numeric value:
 *
 *   - `nourlms-hw-grade--low`     for grades < 50  (red)
 *   - `nourlms-hw-grade--mid`     for grades 50..80 (warning amber)
 *   - `nourlms-hw-grade--high`    for grades 81..100 (green)
 *   - `nourlms-hw-grade--unknown` when the grade is missing / non-numeric
 *
 * `gradeTierForValue` returns just the suffix (`'low' | 'mid' | 'high' | 'unknown'`)
 * for callers that want to use it elsewhere (e.g. text label).
 */
export type GradeTier = 'low' | 'mid' | 'high' | 'unknown';

export function gradeTierForValue(value: unknown): GradeTier {
	if (value === null || value === undefined) { return 'unknown'; }
	const n = typeof value === 'number' ? value : Number(value);
	if (!isFinite(n) || isNaN(n)) { return 'unknown'; }
	if (n < 50) { return 'low'; }
	if (n <= 80) { return 'mid'; }
	return 'high';
}

export function gradeClassForValue(value: unknown): string {
	return `nourlms-hw-grade--${gradeTierForValue(value)}`;
}

