/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import { NOURLMS_PROXY_ALLOWLIST, handleNourlmsApiProxy } from '../../node/nourlmsApiProxy.js';
import type { NourlmsSession } from '../../node/nourlmsAuth.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ILogService } from '../../../platform/log/common/log.js';

class MockLogService implements Partial<ILogService> {
	_serviceBrand: undefined;
	traceLevel = 0;
	onDidChangeLogLevel: any = { event: () => ({ dispose() { } }) };
	trace() { }
	debug() { }
	info() { }
	warn() { }
	error() { }
	flush() { }
	getLevel() { return 0; }
	setLevel() { }
	isVisible() { return false; }
	dispose() { }
}

suite('nourlmsApiProxy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const logService = new MockLogService() as ILogService;
	const adminSession: NourlmsSession = { userId: 1, name: 'Admin', role: 'admin', token: 'admin-token' };
	const studentSession: NourlmsSession = { userId: 2, name: 'Student', role: 'student', token: 'student-token' };

	test('every route in the allow-list parses cleanly', () => {
		for (const route of NOURLMS_PROXY_ALLOWLIST) {
			assert.ok(route.method, `route ${route.pathPattern} has method`);
			assert.ok(route.pathPattern.startsWith('/'), `route ${route.pathPattern} starts with /`);
			assert.ok(['admin', 'student', 'any'].includes(route.role), `route ${route.pathPattern} has valid role`);
		}
	});

	test('FR-to-route coverage: every spec FR with an upstream endpoint maps to at least one allow-listed route', () => {
		const frToRoute: [string, string, string][] = [
			['FR-014', 'GET', '/question-bank/questions'],
			['FR-020', 'POST', '/question-bank/questions'],
			['FR-017', 'POST', '/admin/homeworks/assign'],
			['FR-023', 'GET', '/admin/homeworks'],
			['FR-024', 'GET', '/admin/homeworks/:id/submissions'],
			['FR-025', 'POST', '/admin/homeworks/:id/ai-grade'],
			['FR-026', 'POST', '/admin/homeworks/:id/ai-grade/regrade'],
			['FR-028', 'GET', '/student/homeworks'],
			['FR-030', 'GET', '/student/homeworks/:id'],
			['FR-031', 'POST', '/student/homeworks/:id/submit'],
			['FR-034', 'GET', '/student/homeworks/:id/submissions'],
			['FR-027', 'GET', '/ai-grading/results/:id'],
		];

		for (const [fr, method, pattern] of frToRoute) {
			const found = NOURLMS_PROXY_ALLOWLIST.some(r => r.method === method && r.pathPattern === pattern);
			assert.ok(found, `${fr}: expected route ${method} ${pattern} in allow-list`);
		}
	});

	test('non-allow-listed path returns 404', async () => {
		const req = { method: 'GET', headers: {} } as any as http.IncomingMessage;
		const resChunks: Buffer[] = [];
		let resStatusCode = 0;
		const res = {
			writeHead(status: number, headers?: any) { resStatusCode = status; },
			end(data?: any) { if (data) resChunks.push(Buffer.from(data)); },
		} as any as http.ServerResponse;

		await handleNourlmsApiProxy(req, res, '/unknown/path', '', 'http://localhost:9999/api', adminSession, logService);
		assert.strictEqual(resStatusCode, 404);
		const body = JSON.parse(Buffer.concat(resChunks).toString());
		assert.strictEqual(body.error, 'Route not exposed');
	});

	test('student calling admin-only route returns 404 (not 403)', async () => {
		const req = { method: 'GET', headers: {} } as any as http.IncomingMessage;
		const resChunks: Buffer[] = [];
		let resStatusCode = 0;
		const res = {
			writeHead(status: number, headers?: any) { resStatusCode = status; },
			end(data?: any) { if (data) resChunks.push(Buffer.from(data)); },
		} as any as http.ServerResponse;

		await handleNourlmsApiProxy(req, res, '/admin/homeworks', '', 'http://localhost:9999/api', studentSession, logService);
		assert.strictEqual(resStatusCode, 404);
		const body = JSON.parse(Buffer.concat(resChunks).toString());
		assert.strictEqual(body.error, 'Route not exposed');
	});

	test('inbound headers are not forwarded upstream — only session-derived Authorization and allowlisted headers are sent', async () => {
		let receivedHeaders: Record<string, string | string[] | undefined> = {};
		const server = http.createServer((req, res) => {
			receivedHeaders = req.headers;
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ data: [] }));
		});
		await new Promise<void>(resolve => server.listen(0, resolve));
		const port = (server.address() as any).port;
		const upstreamUrl = `http://localhost:${port}/api`;

		const req = {
			method: 'GET',
			headers: {
				'Authorization': 'Bearer should-not-forward',
				'Cookie': 'session=should-not-forward',
				'X-Custom-Header': 'should-not-forward',
				'Accept': 'text/html',
				'Cache-Control': 'no-cache',
				'If-None-Match': '"etag123"',
			},
		} as any as http.IncomingMessage;
		const resChunks: Buffer[] = [];
		let resStatusCode = 0;
		const res = {
			writeHead(status: number, headers?: any) { resStatusCode = status; },
			end(data?: any) { if (data) resChunks.push(Buffer.from(data)); },
		} as any as http.ServerResponse;

		await handleNourlmsApiProxy(req, res, '/student/homeworks', '', upstreamUrl, studentSession, logService);
		assert.strictEqual(resStatusCode, 200);

		assert.strictEqual(receivedHeaders['authorization'], `Bearer ${studentSession.token}`);
		assert.strictEqual(receivedHeaders['accept'], 'application/json');
		assert.strictEqual(receivedHeaders['cache-control'], 'no-cache');
		assert.strictEqual(receivedHeaders['if-none-match'], '"etag123"');
		assert.strictEqual(receivedHeaders['cookie'], undefined);
		assert.strictEqual(receivedHeaders['x-custom-header'], undefined);

		await new Promise<void>(resolve => { server.close(() => resolve()); });
	});

	test('upstream Set-Cookie and other response headers are not forwarded — only Content-Type, Cache-Control, and Link pass through', async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Set-Cookie': 'laravel_session=should-not-forward',
				'X-Custom-Response-Header': 'should-not-forward',
				'Cache-Control': 'no-store',
				'Link': '<http://example.com/page2>; rel="next"',
			});
			res.end(JSON.stringify({ data: [] }));
		});
		await new Promise<void>(resolve => server.listen(0, resolve));
		const port = (server.address() as any).port;
		const upstreamUrl = `http://localhost:${port}/api`;

		const req = { method: 'GET', headers: {} } as any as http.IncomingMessage;
		let resHeaders: Record<string, string> = {};
		const resChunks: Buffer[] = [];
		let resStatusCode = 0;
		const res = {
			writeHead(status: number, headers?: any) { resStatusCode = status; resHeaders = headers ?? {}; },
			end(data?: any) { if (data) resChunks.push(Buffer.from(data)); },
		} as any as http.ServerResponse;

		await handleNourlmsApiProxy(req, res, '/student/homeworks', '', upstreamUrl, studentSession, logService);
		assert.strictEqual(resStatusCode, 200);

		assert.strictEqual(resHeaders['Content-Type'], 'application/json');
		assert.strictEqual(resHeaders['Cache-Control'], 'no-store');
		assert.strictEqual(resHeaders['Link'], '<http://example.com/page2>; rel="next"');
		assert.strictEqual(resHeaders['Set-Cookie'], undefined);
		assert.strictEqual(resHeaders['X-Custom-Response-Header'], undefined);

		await new Promise<void>(resolve => { server.close(() => resolve()); });
	});

	test('upstream 401 is forwarded as 401 with Session expired', async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ message: 'Unauthenticated.' }));
		});
		await new Promise<void>(resolve => server.listen(0, resolve));
		const port = (server.address() as any).port;
		const upstreamUrl = `http://localhost:${port}/api`;

		const req = { method: 'GET', headers: { 'Accept': 'application/json' } } as any as http.IncomingMessage;
		const resChunks: Buffer[] = [];
		let resStatusCode = 0;
		const res = {
			writeHead(status: number, headers?: any) { resStatusCode = status; },
			end(data?: any) { if (data) resChunks.push(Buffer.from(data)); },
		} as any as http.ServerResponse;

		await handleNourlmsApiProxy(req, res, '/student/homeworks', '', upstreamUrl, studentSession, logService);
		assert.strictEqual(resStatusCode, 401);
		const body = JSON.parse(Buffer.concat(resChunks).toString());
		assert.strictEqual(body.error, 'Session expired');

		await new Promise<void>(resolve => { server.close(() => resolve()); });
	});

	test('upstream network error becomes 502', async () => {
		const req = { method: 'GET', headers: {} } as any as http.IncomingMessage;
		const resChunks: Buffer[] = [];
		let resStatusCode = 0;
		const res = {
			writeHead(status: number, headers?: any) { resStatusCode = status; },
			end(data?: any) { if (data) resChunks.push(Buffer.from(data)); },
		} as any as http.ServerResponse;

		await handleNourlmsApiProxy(req, res, '/student/homeworks', '', 'http://localhost:1/api', studentSession, logService);
		assert.strictEqual(resStatusCode, 502);
		const body = JSON.parse(Buffer.concat(resChunks).toString());
		assert.strictEqual(body.error, 'Upstream unreachable');
		assert.strictEqual(body.retry, true);
	});

	test('query string is forwarded to upstream', async () => {
		let receivedPath = '';
		const server = http.createServer((req, res) => {
			receivedPath = req.url ?? '';
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ data: [] }));
		});
		await new Promise<void>(resolve => server.listen(0, resolve));
		const port = (server.address() as any).port;
		const upstreamUrl = `http://localhost:${port}/api`;

		const req = { method: 'GET', headers: { 'Accept': 'application/json' } } as any as http.IncomingMessage;
		const resChunks: Buffer[] = [];
		let resStatusCode = 0;
		const res = {
			writeHead(status: number, headers?: any) { resStatusCode = status; },
			end(data?: any) { if (data) resChunks.push(Buffer.from(data)); },
		} as any as http.ServerResponse;

		await handleNourlmsApiProxy(req, res, '/student/homeworks', '?page=1&per_page=10', upstreamUrl, studentSession, logService);
		assert.strictEqual(resStatusCode, 200);
		assert.ok(receivedPath.includes('?page=1&per_page=10'), `expected query string in upstream path, got: ${receivedPath}`);

		await new Promise<void>(resolve => { server.close(() => resolve()); });
	});

	test('SC-005: forged-ID — student calls /student/homeworks/<id-not-owned> and proxy forwards 404 unmodified', async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ message: 'Not found.' }));
		});
		await new Promise<void>(resolve => server.listen(0, resolve));
		const port = (server.address() as any).port;
		const upstreamUrl = `http://localhost:${port}/api`;

		const req = { method: 'GET', headers: { 'Accept': 'application/json' } } as any as http.IncomingMessage;
		const resChunks: Buffer[] = [];
		let resStatusCode = 0;
		const res = {
			writeHead(status: number, headers?: any) { resStatusCode = status; },
			end(data?: any) { if (data) resChunks.push(Buffer.from(data)); },
		} as any as http.ServerResponse;

		await handleNourlmsApiProxy(req, res, '/student/homeworks/9999', '', upstreamUrl, studentSession, logService);
		assert.strictEqual(resStatusCode, 404);
		const body = JSON.parse(Buffer.concat(resChunks).toString());
		assert.strictEqual(body.message, 'Not found.');

		await new Promise<void>(resolve => { server.close(() => resolve()); });
	});

	test('FR-039 / SC-010: no setInterval or setTimeout wrapping IRequestService.request to list endpoints', () => {
		const fs = require('fs');
		const path = require('path');

		const homeworkDir = path.resolve(__dirname, '../../../workbench/contrib/nourlms/browser/homework');
		if (!fs.existsSync(homeworkDir)) {
			return;
		}

		const listEndpoints = [
			'/question-bank/questions',
			'/admin/homeworks',
			'/student/homeworks',
			'/admin/homeworks/:id/submissions',
			'/student/homeworks/:id/submissions',
		];

		function walkDir(dir: string): string[] {
			const results: string[] = [];
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					results.push(...walkDir(fullPath));
				} else if (entry.name.endsWith('.ts')) {
					results.push(fullPath);
				}
			}
			return results;
		}

		const files = walkDir(homeworkDir);
		for (const file of files) {
			const content = fs.readFileSync(file, 'utf8');
			const timerPattern = /(setInterval|setTimeout)\s*\(/g;
			let match;
			while ((match = timerPattern.exec(content)) !== null) {
				const start = Math.max(0, match.index - 200);
				const end = Math.min(content.length, match.index + 200);
				const context = content.substring(start, end);
				const hasListEndpoint = listEndpoints.some(ep => context.includes(ep.replace(/:id/, '')));
				assert.ok(!hasListEndpoint, `${file}: timer near list endpoint call detected — FR-039 violation`);
			}
		}
	});
});
