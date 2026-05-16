/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodeHttp from 'http';
import * as nodeHttps from 'https';
import * as url from 'url';
import type { ILogService } from '../../platform/log/common/log.js';
import type { NourlmsSession } from './nourlmsAuth.js';

export interface NourlmsProxyRoute {
	method: 'GET' | 'POST' | 'PATCH';
	pathPattern: string;
	role: 'admin' | 'student' | 'any';
}

export const NOURLMS_PROXY_ALLOWLIST: readonly NourlmsProxyRoute[] = [
	{ method: 'GET', pathPattern: '/question-bank/questions', role: 'admin' },
	{ method: 'POST', pathPattern: '/question-bank/questions', role: 'admin' },
	{ method: 'GET', pathPattern: '/question-bank/questions/:id', role: 'admin' },
	{ method: 'GET', pathPattern: '/question-bank/courses', role: 'admin' },
	{ method: 'GET', pathPattern: '/question-bank/subjects', role: 'admin' },
	{ method: 'POST', pathPattern: '/question-bank/subjects', role: 'admin' },
	{ method: 'GET', pathPattern: '/question-bank/courses/:id/subjects', role: 'admin' },
	{ method: 'GET', pathPattern: '/question-bank/difficulty-rates', role: 'admin' },
	{ method: 'GET', pathPattern: '/question-bank/question-types', role: 'admin' },
	{ method: 'GET', pathPattern: '/admin/students/:id/courses', role: 'admin' },
	{ method: 'GET', pathPattern: '/admin/homeworks', role: 'admin' },
	{ method: 'POST', pathPattern: '/admin/homeworks/assign', role: 'admin' },
	{ method: 'GET', pathPattern: '/admin/homeworks/:id', role: 'admin' },
	{ method: 'GET', pathPattern: '/admin/homeworks/:id/submissions', role: 'admin' },
	{ method: 'GET', pathPattern: '/admin/homeworks/:id/submissions/:sid', role: 'admin' },
	{ method: 'PATCH', pathPattern: '/admin/homeworks/:id/submissions/:sid/correct', role: 'admin' },
	{ method: 'POST', pathPattern: '/admin/homeworks/:id/ai-grade', role: 'admin' },
	{ method: 'POST', pathPattern: '/admin/homeworks/:id/ai-grade/regrade', role: 'admin' },
	{ method: 'GET', pathPattern: '/student/homeworks', role: 'student' },
	{ method: 'GET', pathPattern: '/student/homeworks/courses', role: 'student' },
	{ method: 'GET', pathPattern: '/student/homeworks/:id', role: 'student' },
	{ method: 'POST', pathPattern: '/student/homeworks/:id/submit', role: 'student' },
	{ method: 'GET', pathPattern: '/student/homeworks/:id/submissions', role: 'student' },
	{ method: 'GET', pathPattern: '/student/homeworks/:id/submissions/:sid', role: 'student' },
	{ method: 'GET', pathPattern: '/ai-grading/results/:id', role: 'any' },
	{ method: 'GET', pathPattern: '/homeworks/:id/submissions/:sid/ai-result', role: 'any' },
	{ method: 'GET', pathPattern: '/homeworks/:id/submissions/:sid/ai-result/status', role: 'any' },
];

function matchRoute(route: NourlmsProxyRoute, method: string, pathname: string): boolean {
	if (route.method !== method) {
		return false;
	}
	const patternParts = route.pathPattern.split('/');
	const pathParts = pathname.split('/');
	if (patternParts.length !== pathParts.length) {
		return false;
	}
	for (let i = 0; i < patternParts.length; i++) {
		if (patternParts[i].startsWith(':')) {
			continue;
		}
		if (patternParts[i] !== pathParts[i]) {
			return false;
		}
	}
	return true;
}

function findMatchingRoute(method: string, pathname: string): NourlmsProxyRoute | undefined {
	for (const route of NOURLMS_PROXY_ALLOWLIST) {
		if (matchRoute(route, method, pathname)) {
			return route;
		}
	}
	return undefined;
}

const MAX_BODY_SIZE = 2 * 1024 * 1024;

export async function handleNourlmsApiProxy(
	req: nodeHttp.IncomingMessage,
	res: nodeHttp.ServerResponse,
	pathname: string,
	queryString: string,
	nourlmsApiUrl: string,
	session: NourlmsSession,
	logService: ILogService
): Promise<void> {
	const method = req.method?.toUpperCase();
	if (method !== 'GET' && method !== 'POST' && method !== 'PATCH') {
		res.writeHead(405, { 'Content-Type': 'application/json' });
		return void res.end(JSON.stringify({ error: 'Method not allowed' }));
	}

	const route = findMatchingRoute(method, pathname);
	if (!route) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		return void res.end(JSON.stringify({ error: 'Route not exposed' }));
	}

	if (route.role !== 'any' && route.role !== session.role) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		return void res.end(JSON.stringify({ error: 'Route not exposed' }));
	}

	let bodyBuffer: Buffer | undefined;
	if (method === 'POST' || method === 'PATCH') {
		const chunks: Buffer[] = [];
		let totalSize = 0;
		for await (const chunk of req) {
			totalSize += chunk.length;
			if (totalSize > MAX_BODY_SIZE) {
				res.writeHead(413, { 'Content-Type': 'application/json' });
				return void res.end(JSON.stringify({ error: 'Payload too large' }));
			}
			chunks.push(chunk as Buffer);
		}
		bodyBuffer = Buffer.concat(chunks);
	}

	const upstreamBase = nourlmsApiUrl.replace(/\/+$/, '');
	const upstreamUrlStr = `${upstreamBase}${pathname}${queryString}`;
	const parsedUpstream = url.parse(upstreamUrlStr);

	const upstreamHeaders: Record<string, string> = {
		'Authorization': `Bearer ${session.token}`,
		'Accept': 'application/json',
	};
	if (bodyBuffer) {
		const ct = req.headers['content-type'];
		if (ct) {
			upstreamHeaders['Content-Type'] = ct;
		}
	}
	if (req.headers['cache-control']) {
		upstreamHeaders['Cache-Control'] = req.headers['cache-control'] as string;
	}
	if (req.headers['if-none-match']) {
		upstreamHeaders['If-None-Match'] = req.headers['if-none-match'] as string;
	}

	const options: nodeHttp.RequestOptions = {
		hostname: parsedUpstream.hostname,
		port: parsedUpstream.port || (parsedUpstream.protocol === 'https:' ? 443 : 80),
		path: parsedUpstream.path,
		method,
		headers: upstreamHeaders,
	};

	const httpModule = parsedUpstream.protocol === 'https:' ? nodeHttps : nodeHttp;

	logService.trace(`[nourlmsApiProxy] ${method} ${pathname} → upstream (role: ${session.role})`);

	return new Promise<void>((resolve) => {
		const apiReq = httpModule.request(options, (apiRes: nodeHttp.IncomingMessage) => {
			if (apiRes.statusCode === 401) {
				res.writeHead(401, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Session expired' }));
				return resolve();
			}

			const forwardHeaders: Record<string, string> = {};
			const ct = apiRes.headers['content-type'];
			if (ct !== undefined) {
				forwardHeaders['Content-Type'] = Array.isArray(ct) ? ct.join(', ') : ct;
			}
			const cc = apiRes.headers['cache-control'];
			if (cc !== undefined) {
				forwardHeaders['Cache-Control'] = Array.isArray(cc) ? cc.join(', ') : cc;
			}
			const link = apiRes.headers['link'];
			if (link !== undefined) {
				forwardHeaders['Link'] = Array.isArray(link) ? link.join(', ') : link;
			}

			res.writeHead(apiRes.statusCode ?? 502, forwardHeaders);
			apiRes.pipe(res);
			apiRes.on('error', () => {
				res.end();
				resolve();
			});
			res.on('finish', () => {
				resolve();
			});
		});

		apiReq.on('error', (err) => {
			logService.warn(`[nourlmsApiProxy] upstream network error for ${method} ${pathname}: ${err.message}`);
			res.writeHead(502, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Upstream unreachable', retry: true }));
			resolve();
		});

		if (bodyBuffer) {
			apiReq.write(bodyBuffer);
		}
		apiReq.end();
	});
}
