/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import 'vs/languages/plaintext/common/plaintext.contribution';
import 'vs/languages/html/common/html.contribution';

import assert = require('assert');
import Platform = require('vs/platform/platform');
import ModesExtensions = require('vs/editor/common/modes/modesRegistry');
import EditorCommon = require('vs/editor/common/editorCommon');
import Modes = require('vs/editor/common/modes');
import {createMockModeService} from 'vs/editor/test/common/servicesTestUtils';

suite('Editor Modes - Modes Registry', () => {
	test('Bug 12104: [f12] createModel not successfully handling mime type list?', () => {
		let modeService = createMockModeService();
		assert.equal(modeService.getModeId('text/html,text/plain'), 'html');
	});
});

