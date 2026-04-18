/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as cookie from 'cookie';

export interface NourlmsSession {
	userId: number;
	name: string;
	role: string;
	token: string;
}

const SESSION_COOKIE_NAME = 'nourlms.session';
const SESSION_MAX_AGE_SECONDS = 55 * 60;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function deriveKey(serverDataDir: string): Buffer {
	const keyMaterial = `nourlms-session-key:${serverDataDir}`;
	return crypto.createHash('sha256').update(keyMaterial).digest();
}

export function sanitizeUsername(name: string): string {
	return name
		.toLowerCase()
		.replace(/\s+/g, '')
		.replace(/[^a-z0-9]/g, '');
}

export function encryptSession(session: NourlmsSession, serverDataDir: string): string {
	const key = deriveKey(serverDataDir);
	const iv = crypto.randomBytes(IV_LENGTH);
	const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
	const plaintext = JSON.stringify(session);
	let encrypted = cipher.update(plaintext, 'utf8', 'base64');
	encrypted += cipher.final('base64');
	const authTag = cipher.getAuthTag();
	const payload = Buffer.concat([iv, authTag, Buffer.from(encrypted, 'base64')]);
	return payload.toString('base64');
}

export function decryptSession(encrypted: string, serverDataDir: string): NourlmsSession | null {
	try {
		const key = deriveKey(serverDataDir);
		const payload = Buffer.from(encrypted, 'base64');
		if (payload.length < IV_LENGTH + AUTH_TAG_LENGTH) {
			return null;
		}
		const iv = payload.subarray(0, IV_LENGTH);
		const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
		const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
		const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
		decipher.setAuthTag(authTag);
		let decrypted = decipher.update(ciphertext, undefined, 'utf8');
		decrypted += decipher.final('utf8');
		return JSON.parse(decrypted) as NourlmsSession;
	} catch {
		return null;
	}
}

export function parseSessionCookie(cookieHeader: string | undefined, serverDataDir: string): NourlmsSession | null {
	if (!cookieHeader) {
		return null;
	}
	const cookies = cookie.parse(cookieHeader);
	const raw = cookies[SESSION_COOKIE_NAME];
	if (!raw) {
		return null;
	}
	return decryptSession(raw, serverDataDir);
}

export function createSessionCookie(session: NourlmsSession, serverDataDir: string): string {
	const encrypted = encryptSession(session, serverDataDir);
	return cookie.serialize(SESSION_COOKIE_NAME, encrypted, {
		httpOnly: true,
		secure: false,
		sameSite: 'lax',
		maxAge: SESSION_MAX_AGE_SECONDS,
		path: '/',
	});
}

export function createLogoutCookie(): string {
	return cookie.serialize(SESSION_COOKIE_NAME, '', {
		httpOnly: true,
		secure: false,
		sameSite: 'lax',
		maxAge: 0,
		path: '/',
	});
}

export function ensureWorkspaceDir(workspacesDir: string, sanitizedName: string): string {
	if (!fs.existsSync(workspacesDir)) {
		fs.mkdirSync(workspacesDir, { recursive: true });
	}
	const workspacePath = path.join(workspacesDir, sanitizedName);
	if (!fs.existsSync(workspacePath)) {
		fs.mkdirSync(workspacePath, { recursive: true });
	}
	return workspacePath;
}
