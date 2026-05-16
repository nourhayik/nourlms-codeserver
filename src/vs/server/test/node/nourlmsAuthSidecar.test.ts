/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as nourlmsAuth from '../../node/nourlmsAuth.js';
import { getRandomTestPath } from '../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';

suite('nourlmsAuth.workspace.sidecar', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let testDir: string;

	setup(() => {
		testDir = getRandomTestPath(os.tmpdir(), 'nourlms-sidecar-test');
		fs.mkdirSync(testDir, { recursive: true });
	});

	teardown(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	test('writeWorkspaceSidecar creates valid JSON file with mode 0o600', () => {
		const workspacePath = path.join(testDir, 'teststudent');
		fs.mkdirSync(workspacePath, { recursive: true });

		const session: nourlmsAuth.NourlmsSession = {
			userId: 42,
			name: 'Test Student',
			role: 'student',
			token: 'test-token',
		};

		nourlmsAuth.writeWorkspaceSidecar(workspacePath, session);

		const sidecarPath = path.join(workspacePath, '.nourlms-user.json');
		assert.ok(fs.existsSync(sidecarPath), 'sidecar file should exist');

		const stat = fs.statSync(sidecarPath);
		const mode = stat.mode & 0o777;
		assert.strictEqual(mode, 0o600, 'file should have mode 0o600');

		const content = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
		assert.strictEqual(content.userId, 42);
		assert.strictEqual(content.name, 'Test Student');
		assert.strictEqual(content.sanitizedName, 'teststudent');
		assert.strictEqual(content.writtenBy, 'nourlms-codeserver');
		assert.ok(content.writtenAt);
	});

	test('readWorkspaceSidecar returns null for missing file', () => {
		const workspacePath = path.join(testDir, 'missing');
		fs.mkdirSync(workspacePath, { recursive: true });
		assert.strictEqual(nourlmsAuth.readWorkspaceSidecar(workspacePath), null);
	});

	test('readWorkspaceSidecar returns null for malformed JSON', () => {
		const workspacePath = path.join(testDir, 'malformed');
		fs.mkdirSync(workspacePath, { recursive: true });
		fs.writeFileSync(path.join(workspacePath, '.nourlms-user.json'), '{ not valid json', { mode: 0o600 });
		assert.strictEqual(nourlmsAuth.readWorkspaceSidecar(workspacePath), null);
	});

	test('readWorkspaceSidecar returns null when sanitizedName mismatches', () => {
		const workspacePath = path.join(testDir, 'correctname');
		fs.mkdirSync(workspacePath, { recursive: true });
		const payload = {
			userId: 1,
			name: 'Some One',
			sanitizedName: 'wrongname',
			writtenAt: new Date().toISOString(),
			writtenBy: 'nourlms-codeserver',
		};
		fs.writeFileSync(path.join(workspacePath, '.nourlms-user.json'), JSON.stringify(payload), { mode: 0o600 });
		assert.strictEqual(nourlmsAuth.readWorkspaceSidecar(workspacePath), null);
	});

	test('round-trip write→read returns identical data', () => {
		const workspacePath = path.join(testDir, 'roundtripstudent');
		fs.mkdirSync(workspacePath, { recursive: true });

		const session: nourlmsAuth.NourlmsSession = {
			userId: 99,
			name: 'Round Trip',
			role: 'student',
			token: 'rt-token',
		};

		nourlmsAuth.writeWorkspaceSidecar(workspacePath, session);
		const result = nourlmsAuth.readWorkspaceSidecar(workspacePath);

		assert.ok(result, 'read should return non-null');
		assert.strictEqual(result.userId, 99);
		assert.strictEqual(result.name, 'Round Trip');
		assert.strictEqual(result.sanitizedName, 'roundtripstudent');
		assert.strictEqual(result.writtenBy, 'nourlms-codeserver');
	});
});
