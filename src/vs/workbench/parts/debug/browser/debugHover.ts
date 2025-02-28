/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TPromise } from 'vs/base/common/winjs.base';
import errors = require('vs/base/common/errors');
import dom = require('vs/base/browser/dom');
import * as nls from 'vs/nls';
import { ITree } from 'vs/base/parts/tree/browser/tree';
import { Tree } from 'vs/base/parts/tree/browser/treeImpl';
import { DefaultController, ICancelableEvent } from 'vs/base/parts/tree/browser/treeDefaults';
import editorbrowser = require('vs/editor/browser/editorBrowser');
import editorcommon = require('vs/editor/common/editorCommon');
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import debug = require('vs/workbench/parts/debug/common/debug');
import {evaluateExpression, Expression} from 'vs/workbench/parts/debug/common/debugModel';
import viewer = require('vs/workbench/parts/debug/browser/debugViewer');

const $ = dom.emmet;
const debugTreeOptions = {
	indentPixels: 6,
	twistiePixels: 15,
	ariaLabel: nls.localize('treeAriaLabel', "Debug Hover")
};
const MAX_ELEMENTS_SHOWN = 18;

export class DebugHoverWidget implements editorbrowser.IContentWidget {

	public static ID = 'debug.hoverWidget';
	// editor.IContentWidget.allowEditorOverflow
	public allowEditorOverflow = true;

	private domNode: HTMLElement;
	private isVisible: boolean;
	private tree: ITree;
	private showAtPosition: editorcommon.IEditorPosition;
	private highlightDecorations: string[];
	private treeContainer: HTMLElement;
	private valueContainer: HTMLElement;

	constructor(private editor: editorbrowser.ICodeEditor, private debugService: debug.IDebugService, private instantiationService: IInstantiationService) {
		this.domNode = $('.debug-hover-widget monaco-editor-background');
		this.treeContainer = dom.append(this.domNode, $('.debug-hover-tree'));
		this.treeContainer.setAttribute('role', 'tree');
		this.tree = new Tree(this.treeContainer, {
			dataSource: new viewer.VariablesDataSource(this.debugService),
			renderer: this.instantiationService.createInstance(VariablesHoverRenderer),
			controller: new DebugHoverController(editor)
		}, debugTreeOptions);
		this.tree.addListener2('item:expanded', () => {
			this.layoutTree();
		});
		this.tree.addListener2('item:collapsed', () => {
			this.layoutTree();
		});

		this.valueContainer = dom.append(this.domNode, $('.value'));
		this.valueContainer.setAttribute('role', 'tooltip');

		this.isVisible = false;
		this.showAtPosition = null;
		this.highlightDecorations = [];

		this.editor.addContentWidget(this);
	}

	public getId(): string {
		return DebugHoverWidget.ID;
	}

	public getDomNode(): HTMLElement {
		return this.domNode;
	}

	public showAt(range: editorcommon.IEditorRange, hoveringOver: string): void {
		const pos = range.getStartPosition();
		const model = this.editor.getModel();
		const focusedStackFrame = this.debugService.getViewModel().getFocusedStackFrame();
		if (!hoveringOver || !focusedStackFrame || (focusedStackFrame.source.uri.toString() !== model.getAssociatedResource().toString())) {
			return;
		}

		// string magic to get the parents of the variable (a and b for a.b.foo)
		const lineContent = model.getLineContent(pos.lineNumber);
		const namesToFind = lineContent.substring(0, lineContent.indexOf('.' + hoveringOver))
			.split('.').map(word => word.trim()).filter(word => !!word);
		namesToFind.push(hoveringOver);
		namesToFind[0] = namesToFind[0].substring(namesToFind[0].lastIndexOf(' ') + 1);

		this.getExpression(namesToFind).done(expression => {
			if (!expression || !expression.available) {
				this.hide();
				return;
			}

			// show it
			this.highlightDecorations = this.editor.deltaDecorations(this.highlightDecorations, [{
				range: {
					startLineNumber: pos.lineNumber,
					endLineNumber: pos.lineNumber,
					startColumn: lineContent.indexOf(hoveringOver) + 1,
					endColumn: lineContent.indexOf(hoveringOver) + 1 + hoveringOver.length
				},
				options: {
					className: 'hoverHighlight'
				}
			}]);
			this.doShow(pos, expression);
		}, errors.onUnexpectedError);
	}

	private getExpression(namesToFind: string[]): TPromise<Expression> {
		const session = this.debugService.getActiveSession();
		const focusedStackFrame = this.debugService.getViewModel().getFocusedStackFrame();
		if (session.capablities.supportsEvaluateForHovers) {
			return evaluateExpression(session, focusedStackFrame, new Expression(namesToFind.join('.'), true), 'hover');
		}

		const variables: debug.IExpression[] = [];
		return focusedStackFrame.getScopes(this.debugService).then(scopes => {

			// flatten out scopes lists
			return scopes.reduce((accum, scopes) => { return accum.concat(scopes); }, [])

			// no expensive scopes
			.filter((scope: debug.IScope) => !scope.expensive)

			// get the scopes variables
			.map((scope: debug.IScope) => scope.getChildren(this.debugService).done((children: debug.IExpression[]) => {

				// look for our variable in the list. First find the parents of the hovered variable if there are any.
				for (var i = 0; i < namesToFind.length && children; i++) {
					// some languages pass the type as part of the name, so need to check if the last word of the name matches.
					const filtered = children.filter(v => typeof v.name === 'string' && (namesToFind[i] === v.name || namesToFind[i] === v.name.substr(v.name.lastIndexOf(' ') + 1)));
					if (filtered.length !== 1) {
						break;
					}

					if (i === namesToFind.length - 1) {
						variables.push(filtered[0]);
					} else {
						filtered[0].getChildren(this.debugService).done(c => children = c, children = null);
					}
				}
			}, errors.onUnexpectedError));

		// only show if there are no duplicates across scopes
		}).then(() => variables.length === 1 ? TPromise.as(variables[0]) : TPromise.as(null));
	}

	private doShow(position: editorcommon.IEditorPosition, expression: debug.IExpression, forceValueHover = false): void {
		this.showAtPosition = position;
		this.isVisible = true;

		if (expression.reference > 0 && !forceValueHover) {
			this.valueContainer.hidden = true;
			this.treeContainer.hidden = false;
			this.tree.setInput(expression).then(() => {
				this.layoutTree();
			}).then(() => this.editor.layoutContentWidget(this), errors.onUnexpectedError);
		} else {
			this.treeContainer.hidden = true;
			this.valueContainer.hidden = false;
			viewer.renderExpressionValue(expression, this.valueContainer, false);
			this.valueContainer.title = '';
			this.editor.layoutContentWidget(this);
		}
	}

	private layoutTree(): void {
		const navigator = this.tree.getNavigator();
		let visibleElementsCount = 0;
		while (navigator.next()) {
			visibleElementsCount++;
		}

		if (visibleElementsCount === 0) {
			this.doShow(this.showAtPosition, this.tree.getInput(), true);
		} else {
			const height = Math.min(visibleElementsCount, MAX_ELEMENTS_SHOWN) * 18;

			if (this.treeContainer.clientHeight !== height) {
				this.treeContainer.style.height = `${ height }px`;
				this.tree.layout();
			}
		}
	}

	public hide(): void {
		if (!this.isVisible) {
			// already not visible
			return;
		}
		this.isVisible = false;
		this.editor.deltaDecorations(this.highlightDecorations, []);
		this.highlightDecorations = [];
		this.editor.layoutContentWidget(this);
	}

	public getPosition(): editorbrowser.IContentWidgetPosition {
		return this.isVisible ? {
			position: this.showAtPosition,
			preference: [
				editorbrowser.ContentWidgetPositionPreference.ABOVE,
				editorbrowser.ContentWidgetPositionPreference.BELOW
			]
		} : null;
	}
}

class DebugHoverController extends DefaultController {

	constructor(private editor: editorbrowser.ICodeEditor) {
		super();
	}

	/* protected */ public onLeftClick(tree: ITree, element: any, eventish: ICancelableEvent, origin: string = 'mouse'): boolean {
		if (element.reference > 0) {
			super.onLeftClick(tree, element, eventish, origin);
			tree.clearFocus();
			tree.deselect(element);
			this.editor.focus();
		}

		return true;
	}
}

class VariablesHoverRenderer extends viewer.VariablesRenderer {

	public getHeight(tree: ITree, element: any): number {
		return 18;
	}
}
