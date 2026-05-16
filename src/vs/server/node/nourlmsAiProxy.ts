/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodeHttp from 'http';
import * as nodeHttps from 'https';
import * as url from 'url';
import type { ILogService } from '../../platform/log/common/log.js';
import type { NourlmsSession } from './nourlmsAuth.js';

const DEFAULT_AI_BASE_URL = 'https://ai.nourlms.com/v1';
const DEFAULT_AI_SCOPES = 'operator.admin,operator.read,operator.write';
const MAX_BODY_SIZE = 256 * 1024;
const ALLOWED_PATHS = new Set<string>([
	'/chat/completions',
]);

export async function handleNourlmsAiProxy(
	req: nodeHttp.IncomingMessage,
	res: nodeHttp.ServerResponse,
	subPath: string,
	session: NourlmsSession,
	logService: ILogService
): Promise<void> {
	if (session.role !== 'admin') {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		return void res.end(JSON.stringify({ error: 'Route not exposed' }));
	}

	if (req.method !== 'POST') {
		res.writeHead(405, { 'Content-Type': 'application/json' });
		return void res.end(JSON.stringify({ error: 'Method not allowed' }));
	}

	if (!ALLOWED_PATHS.has(subPath)) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		return void res.end(JSON.stringify({ error: 'Route not exposed' }));
	}

	const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
	if (!apiKey) {
		logService.warn('[nourlmsAiProxy] AI_API_KEY env var is not configured');
		res.writeHead(503, { 'Content-Type': 'application/json' });
		return void res.end(JSON.stringify({ error: 'AI service not configured on this server' }));
	}

	const baseUrl = (process.env.AI_API_BASE_URL || DEFAULT_AI_BASE_URL).replace(/\/+$/, '');

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
	let bodyBuffer = Buffer.concat(chunks);

	// Optional server-side model override. The default model name the gateway
	// accepts may change (e.g. it currently rejects `gpt-4o-mini` and requires
	// `openclaw`). Admins can pin a model here in `.env` so a future rename
	// does not require a workbench rebuild — we rewrite `body.model` before
	// forwarding upstream. If parsing fails (empty body, malformed JSON, etc.)
	// we forward the original buffer untouched so we never get in the way of a
	// legitimate request.
	const overrideModel = (process.env.AI_API_MODEL || '').trim();
	if (overrideModel && bodyBuffer.length > 0) {
		try {
			const parsed = JSON.parse(bodyBuffer.toString('utf8'));
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				(parsed as { model?: string }).model = overrideModel;
				bodyBuffer = Buffer.from(JSON.stringify(parsed), 'utf8');
			}
		} catch {
			// Forward the original body if the override step fails. Diagnostics
			// for an actually broken body will surface as a 4xx from upstream.
		}
	}

	const upstreamUrlStr = `${baseUrl}${subPath}`;
	const parsedUpstream = url.parse(upstreamUrlStr);

	// The OpenClaw gateway at ai.nourlms.com requires `x-openclaw-scopes` on
	// every request — without it the gateway returns 403. Defaults to the full
	// admin/read/write triplet documented in AI_API.md; admins can pin a
	// narrower set in `.env` via AI_API_SCOPES if they ever need to.
	const scopes = (process.env.AI_API_SCOPES || DEFAULT_AI_SCOPES).trim();

	const upstreamHeaders: Record<string, string> = {
		'Authorization': `Bearer ${apiKey}`,
		'Content-Type': 'application/json',
		'Accept': 'application/json',
		'x-openclaw-scopes': scopes,
	};

	const options: nodeHttp.RequestOptions = {
		hostname: parsedUpstream.hostname,
		port: parsedUpstream.port || (parsedUpstream.protocol === 'https:' ? 443 : 80),
		path: parsedUpstream.path,
		method: 'POST',
		headers: upstreamHeaders,
	};

	const httpModule = parsedUpstream.protocol === 'https:' ? nodeHttps : nodeHttp;

	logService.trace(`[nourlmsAiProxy] POST ${subPath} → ${parsedUpstream.host} (admin: ${session.userId})`);

	return new Promise<void>((resolve) => {
		const apiReq = httpModule.request(options, (apiRes) => {
			const forwardHeaders: Record<string, string> = {};
			const ct = apiRes.headers['content-type'];
			if (ct !== undefined) {
				forwardHeaders['Content-Type'] = Array.isArray(ct) ? ct.join(', ') : ct;
			}
			res.writeHead(apiRes.statusCode ?? 502, forwardHeaders);
			apiRes.pipe(res);
			apiRes.on('error', () => {
				res.end();
				resolve();
			});
			res.on('finish', () => resolve());
		});

		apiReq.on('error', (err) => {
			logService.warn(`[nourlmsAiProxy] upstream network error: ${err.message}`);
			res.writeHead(502, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'AI upstream unreachable', retry: true }));
			resolve();
		});

		apiReq.write(bodyBuffer);
		apiReq.end();
	});
}
