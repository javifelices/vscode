/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import modes = require('vs/editor/common/modes');
import {AbstractMode} from 'vs/editor/common/modes/abstractMode';
import {AbstractState} from 'vs/editor/common/modes/abstractState';
import {AbstractModeWorker} from 'vs/editor/common/modes/abstractModeWorker';
import {RichEditSupport} from 'vs/editor/common/modes/supports/richEditSupport';
import {TokenizationSupport} from 'vs/editor/common/modes/supports/tokenizationSupport';

export class CommentState extends AbstractState {

	constructor(mode:modes.IMode, stateCount:number) {
		super(mode);
	}

	public makeClone():CommentState {
		return this;
	}

	public equals(other:modes.IState):boolean {
		return true;
	}

	public tokenize(stream:modes.IStream):modes.ITokenizationResult {
		stream.advanceToEOS();
		return { type: 'state' };
	}
}

export class CommentMode extends AbstractMode<AbstractModeWorker> {

	public tokenizationSupport: modes.ITokenizationSupport;
	public richEditSupport: modes.IRichEditSupport;

	constructor(commentsConfig:modes.ICommentsConfiguration) {
		super({ id: 'tests.commentMode', workerParticipants: [] }, null, null);

		this.tokenizationSupport = new TokenizationSupport(this, {
			getInitialState: () => new CommentState(this, 0)
		}, false, false);

		this.richEditSupport = {
			comments:commentsConfig
		};
	}
}

export class TestingMode implements modes.IMode {
	public getId():string {
		return 'testing';
	}

	public toSimplifiedMode(): modes.IMode {
		return this;
	}
}

export abstract class AbstractIndentingMode extends TestingMode {

	public getElectricCharacters():string[] {
		return null;
	}

	public onElectricCharacter(context:modes.ILineContext, offset:number):modes.IElectricAction {
		return null;
	}

	public onEnter(context:modes.ILineContext, offset:number):modes.IEnterAction {
		return null;
	}

}

export class ModelState1 extends AbstractState {

	constructor(mode:modes.IMode) {
		super(mode);
	}

	public makeClone():ModelState1 {
		return this;
	}

	public equals(other: modes.IState):boolean {
		return this === other;
	}

	public tokenize(stream:modes.IStream):modes.ITokenizationResult {
		(<ModelMode1>this.getMode()).calledFor.push(stream.next());
		stream.advanceToEOS();
		return { type: '' };
	}
}

export class ModelMode1 extends TestingMode {
	public calledFor:string[];

	public tokenizationSupport: modes.ITokenizationSupport;

	constructor() {
		super();
		this.calledFor = [];
		this.tokenizationSupport = new TokenizationSupport(this, {
			getInitialState: () => new ModelState1(this)
		}, false, false);
	}
}

export class ModelState2 extends AbstractState {

	private prevLineContent:string;

	constructor(mode:ModelMode2, prevLineContent:string) {
		super(mode);
		this.prevLineContent = prevLineContent;
	}

	public makeClone():ModelState2 {
		return new ModelState2(<ModelMode2>this.getMode(), this.prevLineContent);
	}

	public equals(other: modes.IState):boolean {
		return (other instanceof ModelState2) && (this.prevLineContent === (<ModelState2>other).prevLineContent);
	}

	public tokenize(stream:modes.IStream):modes.ITokenizationResult {
		var line= '';
		while (!stream.eos()) {
			line+= stream.next();
		}
		this.prevLineContent= line;
		return { type: '' };
	}
}

export class ModelMode2 extends TestingMode {
	public calledFor:any[];

	public tokenizationSupport: modes.ITokenizationSupport;

	constructor() {
		super();
		this.calledFor = null;
		this.tokenizationSupport = new TokenizationSupport(this, {
			getInitialState: () => new ModelState2(this, '')
		}, false, false);
	}
}

export class BracketState extends AbstractState {

	private allResults:{
		[key:string]:modes.ITokenizationResult;
	};

	constructor(mode:modes.IMode) {
		super(mode);
		this.allResults = null;
	}

	public makeClone():BracketState {
		return this;
	}

	public equals(other: modes.IState):boolean {
		return true;
	}

	public tokenize(stream:modes.IStream):modes.ITokenizationResult {
		this.initializeAllResults();
		stream.setTokenRules('{}[]()', '');
		var token= stream.nextToken();
		// Strade compiler bug: can't reference self in Object return creation.
		var state:modes.IState = this;
		if (this.allResults.hasOwnProperty(token)) {
			return this.allResults[token];
		} else {
			return {
				type: '',
				bracket: modes.Bracket.None,
				nextState: state
			};
		}
	}

	public initializeAllResults(): void {
		if (this.allResults !== null) {
			return;
		}
		this.allResults = {};
		var brackets:any= {
			'{': '}',
			'[': ']',
			'(': ')'
		};

		var type= 1;
		var state:modes.IState = this;
		for (var x in brackets) {
			this.allResults[x]= {
				type: 'bracket' + type,
				bracket: modes.Bracket.Open,
				nextState: state
			};
			this.allResults[brackets[x]] = {
				type: 'bracket' + type,
				bracket: modes.Bracket.Close,
				nextState: state
			};
			type++;
		}
	}
}

export class BracketMode extends TestingMode {

	public tokenizationSupport: modes.ITokenizationSupport;
	public richEditSupport: modes.IRichEditSupport;

	constructor() {
		super();
		this.tokenizationSupport = new TokenizationSupport(this, {
			getInitialState: () => new BracketState(this)
		}, false, false);
		this.richEditSupport = new RichEditSupport(this.getId(), {
			__electricCharacterSupport: {
				brackets: [
					{ tokenType: 'asd', open: '{', close: '}', isElectric: true },
					{ tokenType: 'qwe', open: '[', close: ']', isElectric: true },
					{ tokenType: 'zxc', open: '(', close: ')', isElectric: true }
				]
			}
		});
	}
}

export class NState extends AbstractState {

	private n:number;
	private allResults:modes.ITokenizationResult[];

	constructor(mode:modes.IMode, n:number) {
		super(mode);
		this.n = n;
		this.allResults = null;
	}


	public makeClone():NState {
		return this;
	}

	public equals(other: modes.IState):boolean {
		return true;
	}

	public tokenize(stream:modes.IStream):modes.ITokenizationResult {
		var ndash = this.n, value = '';
		while(!stream.eos() && ndash > 0) {
			value += stream.next();
			ndash--;
		}
		return { type: 'n-' + (this.n - ndash) + '-' + value };
	}
}

export class NMode extends TestingMode {

	private n:number;

	public tokenizationSupport: modes.ITokenizationSupport;

	constructor(n:number) {
		this.n = n;
		super();
		this.tokenizationSupport = new TokenizationSupport(this, {
			getInitialState: () => new NState(this, this.n)
		}, false, false);
	}
}