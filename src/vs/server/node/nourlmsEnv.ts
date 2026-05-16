/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Variables that the NourLMS server understands. The list is intentionally
 * small — every option that used to be a command-line flag is now also
 * controllable through this `.env` file so that production deployments do not
 * have to hand-craft a long argv.
 *
 * Variables NOT listed here are still passed through to `process.env` (so a
 * `.env` file can define ad-hoc settings consumed elsewhere) but they are not
 * the documented surface.
 */
export const NOURLMS_ENV_KEYS = [
	'NOURLMS_API_URL',
	'NOURLMS_WORKSPACES_DIR',
	'NOURLMS_HOST',
	'NOURLMS_PORT',
	'NOURLMS_CONNECTION_TOKEN',
	'NOURLMS_DISABLE_TELEMETRY',
] as const;

export interface NourlmsEnvLoadResult {
	readonly path: string | undefined;
	readonly loaded: number;
	readonly skipped: number;
}

/**
 * Returns the list of paths that will be searched (in order) for a `.env`
 * file. The first one that exists wins. Set `NOURLMS_ENV_FILE` in the real
 * environment to override the search and pin a specific file.
 */
export function getNourlmsEnvSearchPaths(): string[] {
	const explicit = process.env['NOURLMS_ENV_FILE'];
	if (explicit && explicit.trim().length > 0) {
		return [explicit];
	}
	const candidates = [
		path.join(process.cwd(), '.env'),
		path.join(process.cwd(), '.env.local'),
	];
	const remoteDataFolder = process.env['VSCODE_AGENT_FOLDER'];
	if (remoteDataFolder) {
		candidates.push(path.join(remoteDataFolder, '.env'));
	}
	candidates.push(path.join(os.homedir(), '.nourlms', '.env'));
	return candidates;
}

/**
 * Parses a `.env` style file. Supports:
 *  - `KEY=value`
 *  - `KEY="value with spaces"` and `KEY='value with spaces'`
 *  - `export KEY=value`
 *  - leading `#` line comments and blank lines
 *  - trailing comments on unquoted values (`KEY=value # note`)
 *  - escape sequences inside double-quoted values: `\n`, `\r`, `\t`, `\\`, `\"`
 *  - `${OTHER_KEY}` interpolation using values already in `process.env` or the
 *    current parse pass.
 *
 * Existing `process.env` values are NEVER overwritten — the real environment
 * always wins. This matches `dotenv` semantics and keeps systemd / docker
 * overrides effective.
 */
export function parseDotenv(contents: string): Record<string, string> {
	const result: Record<string, string> = {};
	const lines = contents.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith('#')) {
			continue;
		}
		const stripped = line.startsWith('export ') ? line.substring('export '.length) : line;
		const eqIdx = stripped.indexOf('=');
		if (eqIdx <= 0) {
			continue;
		}
		const key = stripped.substring(0, eqIdx).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			continue;
		}
		let value = stripped.substring(eqIdx + 1).trim();
		if (value.length === 0) {
			result[key] = '';
			continue;
		}
		const first = value[0];
		if ((first === '"' || first === '\'') && value.endsWith(first) && value.length >= 2) {
			value = value.substring(1, value.length - 1);
			if (first === '"') {
				value = value.replace(/\\(["\\nrt])/g, (_, ch) => {
					switch (ch) {
						case 'n': return '\n';
						case 'r': return '\r';
						case 't': return '\t';
						default: return ch;
					}
				});
			}
		} else {
			const commentIdx = value.indexOf(' #');
			if (commentIdx !== -1) {
				value = value.substring(0, commentIdx).trim();
			}
		}
		value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, refKey) => {
			return process.env[refKey] ?? result[refKey] ?? '';
		});
		result[key] = value;
	}
	return result;
}

/**
 * Loads the first `.env` file found in `getNourlmsEnvSearchPaths()` and
 * applies its key/value pairs to `process.env` without overwriting variables
 * that are already set.
 *
 * Returns metadata about what happened so the caller can log a single line at
 * startup. Missing files and parse errors are not fatal — the server keeps
 * running on whatever values are already in `process.env`.
 */
/**
 * Convenience aliases mapping our `NOURLMS_*` names to the names the
 * VS Code server bootstrap (`server-main.js`) already understands. We set
 * both, again without overwriting an explicit `process.env` value.
 */
const ENV_ALIASES: ReadonlyArray<readonly [string, string]> = [
	['NOURLMS_HOST', 'VSCODE_SERVER_HOST'],
	['NOURLMS_PORT', 'VSCODE_SERVER_PORT'],
	['NOURLMS_CONNECTION_TOKEN', 'VSCODE_SERVER_CONNECTION_TOKEN'],
];

function applyAliases(): void {
	for (const [from, to] of ENV_ALIASES) {
		const fromValue = process.env[from];
		if (fromValue && (process.env[to] === undefined || process.env[to] === '')) {
			process.env[to] = fromValue;
		}
	}
}

export function loadNourlmsEnv(): NourlmsEnvLoadResult {
	const paths = getNourlmsEnvSearchPaths();
	for (const candidate of paths) {
		if (!candidate) {
			continue;
		}
		try {
			if (!fs.existsSync(candidate)) {
				continue;
			}
			const contents = fs.readFileSync(candidate, 'utf8');
			const parsed = parseDotenv(contents);
			let loaded = 0;
			let skipped = 0;
			for (const [k, v] of Object.entries(parsed)) {
				if (process.env[k] !== undefined && process.env[k] !== '') {
					skipped++;
					continue;
				}
				process.env[k] = v;
				loaded++;
			}
			applyAliases();
			return { path: candidate, loaded, skipped };
		} catch (e) {
			console.warn(`[nourlmsEnv] Failed to read ${candidate}:`, e);
		}
	}
	applyAliases();
	return { path: undefined, loaded: 0, skipped: 0 };
}
