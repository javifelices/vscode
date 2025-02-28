/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import {TPromise} from 'vs/base/common/winjs.base';
import {IModeService, IModeLookupResult} from 'vs/editor/common/services/modeService';
import {IModelService} from 'vs/editor/common/services/modelService';
import Modes = require('vs/editor/common/modes');
import {IPluginService} from 'vs/platform/plugins/common/plugins';
import {FrankensteinMode} from 'vs/editor/common/modes/abstractMode';
import {LanguageExtensions} from 'vs/editor/common/modes/languageExtensionPoint';
import Errors = require('vs/base/common/errors');
import MonarchTypes = require('vs/editor/common/modes/monarch/monarchTypes');
import {Remotable, IThreadService, ThreadAffinity} from 'vs/platform/thread/common/thread';
import Objects = require('vs/base/common/objects');
import MonarchDefinition = require('vs/editor/common/modes/monarch/monarchDefinition');
import {createTokenizationSupport} from 'vs/editor/common/modes/monarch/monarchLexer';
import {compile} from 'vs/editor/common/modes/monarch/monarchCompile';
import {Registry} from 'vs/platform/platform';
import {IEditorModesRegistry, Extensions} from 'vs/editor/common/modes/modesRegistry';
import MonarchCommonTypes = require('vs/editor/common/modes/monarch/monarchCommon');
import {IDisposable, combinedDispose, empty as EmptyDisposable} from 'vs/base/common/lifecycle';
import {createAsyncDescriptor0, createAsyncDescriptor1} from 'vs/platform/instantiation/common/descriptors';
import {RichEditSupport, IRichEditConfiguration} from 'vs/editor/common/modes/supports/richEditSupport';
import {DeclarationSupport, IDeclarationContribution} from 'vs/editor/common/modes/supports/declarationSupport';
import {ReferenceSupport, IReferenceContribution} from 'vs/editor/common/modes/supports/referenceSupport';
import {ParameterHintsSupport, IParameterHintsContribution} from 'vs/editor/common/modes/supports/parameterHintsSupport';
import {SuggestSupport, ComposableSuggestSupport, ISuggestContribution} from 'vs/editor/common/modes/supports/suggestSupport';

interface IModeConfigurationMap { [modeId: string]: any; }

export class ModeServiceImpl implements IModeService {
	public serviceId = IModeService;

	protected _threadService: IThreadService;
	private _pluginService: IPluginService;
	private _activationPromises: { [modeId: string]: TPromise<Modes.IMode>; };
	private _instantiatedModes: { [modeId: string]: Modes.IMode; };
	private _frankensteinModes: { [modeId: string]: FrankensteinMode; };
	private _config: IModeConfigurationMap;

	constructor(threadService:IThreadService, pluginService:IPluginService) {
		this._threadService = threadService;
		this._pluginService = pluginService;
		this._activationPromises = {};
		this._instantiatedModes = {};
		this._frankensteinModes = {};
		this._config = {};
	}

	public getConfigurationForMode(modeId:string): any {
		return this._config[modeId] || {};
	}

	public configureMode(mimetype: string, options: any): void {
		var modeId = this.getModeId(mimetype);
		if (modeId) {
			this.configureModeById(modeId, options);
		}
	}

	public configureModeById(modeId:string, options:any):void {
		var previousOptions = this._config[modeId] || {};
		var newOptions = Objects.mixin(Objects.clone(previousOptions), options);

		if (Objects.equals(previousOptions, newOptions)) {
			// This configure call is a no-op
			return;
		}

		this._config[modeId] = newOptions;

		var mode = this.getMode(modeId);
		if (mode && mode.configSupport) {
			mode.configSupport.configure(this.getConfigurationForMode(modeId));
		}
	}

	public configureAllModes(config:any): void {
		if (!config) {
			return;
		}
		var modes = LanguageExtensions.getRegisteredModes();
		modes.forEach((modeIdentifier) => {
			var configuration = config[modeIdentifier];
			this.configureModeById(modeIdentifier, configuration);
		});
	}

	public isRegisteredMode(mimetypeOrModeId: string): boolean {
		return LanguageExtensions.isRegisteredMode(mimetypeOrModeId);
	}

	public getRegisteredModes(): string[] {
		return LanguageExtensions.getRegisteredModes();
	}

	public getRegisteredLanguageNames(): string[] {
		return LanguageExtensions.getRegisteredLanguageNames();
	}

	public getExtensions(alias: string): string[] {
		return LanguageExtensions.getExtensions(alias);
	}

	public getMimeForMode(modeId: string): string {
		return LanguageExtensions.getMimeForMode(modeId);
	}

	public getLanguageName(modeId: string): string {
		return LanguageExtensions.getLanguageName(modeId);
	}

	public getModeIdForLanguageName(alias:string): string {
		return LanguageExtensions.getModeIdForLanguageNameLowercase(alias);
	}

	public getModeId(commaSeparatedMimetypesOrCommaSeparatedIds: string): string {
		var modeIds = LanguageExtensions.extractModeIds(commaSeparatedMimetypesOrCommaSeparatedIds);

		if (modeIds.length > 0) {
			return modeIds[0];
		}

		return null;
	}

	// --- instantiation

	public lookup(commaSeparatedMimetypesOrCommaSeparatedIds: string): IModeLookupResult[]{
		var r: IModeLookupResult[] = [];
		var modeIds = LanguageExtensions.extractModeIds(commaSeparatedMimetypesOrCommaSeparatedIds);

		for (var i = 0; i < modeIds.length; i++) {
			var modeId = modeIds[i];

			r.push({
				modeId: modeId,
				isInstantiated: this._instantiatedModes.hasOwnProperty(modeId)
			});
		}

		return r;
	}

	public getMode(commaSeparatedMimetypesOrCommaSeparatedIds: string): Modes.IMode {
		var modeIds = LanguageExtensions.extractModeIds(commaSeparatedMimetypesOrCommaSeparatedIds);

		var isPlainText = false;
		for (var i = 0; i < modeIds.length; i++) {
			if (this._instantiatedModes.hasOwnProperty(modeIds[i])) {
				return this._instantiatedModes[modeIds[i]];
			}
			isPlainText = isPlainText || (modeIds[i] === 'plaintext');
		}

		if (isPlainText) {
			// Try to do it synchronously
			var r: Modes.IMode = null;
			this.getOrCreateMode(commaSeparatedMimetypesOrCommaSeparatedIds).then((mode) => {
				r = mode;
			}).done(null, Errors.onUnexpectedError);
			return r;
		}
	}

	public getModeIdByLanguageName(languageName: string): string {
		var modeIds = LanguageExtensions.getModeIdsFromLanguageName(languageName);

		if (modeIds.length > 0) {
			return modeIds[0];
		}

		return null;
	}

	public getModeIdByFilenameOrFirstLine(filename: string, firstLine?:string): string {
		var modeIds = LanguageExtensions.getModeIdsFromFilenameOrFirstLine(filename, firstLine);

		if (modeIds.length > 0) {
			return modeIds[0];
		}

		return null;
	}

	public getOrCreateMode(commaSeparatedMimetypesOrCommaSeparatedIds: string): TPromise<Modes.IMode> {
		return this._pluginService.onReady().then(() => {
			var modeId = this.getModeId(commaSeparatedMimetypesOrCommaSeparatedIds);
			// Fall back to plain text if no mode was found
			return this._getOrCreateMode(modeId || 'plaintext');
		});
	}

	public getOrCreateModeByLanguageName(languageName: string): TPromise<Modes.IMode> {
		return this._pluginService.onReady().then(() => {
			var modeId = this.getModeIdByLanguageName(languageName);
			// Fall back to plain text if no mode was found
			return this._getOrCreateMode(modeId || 'plaintext');
		});
	}

	public getOrCreateModeByFilenameOrFirstLine(filename: string, firstLine?:string): TPromise<Modes.IMode> {
		return this._pluginService.onReady().then(() => {
			var modeId = this.getModeIdByFilenameOrFirstLine(filename, firstLine);
			// Fall back to plain text if no mode was found
			return this._getOrCreateMode(modeId || 'plaintext');
		});
	}

	private _getOrCreateMode(modeId: string): TPromise<Modes.IMode> {
		if (this._instantiatedModes.hasOwnProperty(modeId)) {
			return TPromise.as(this._instantiatedModes[modeId]);
		}

		if (this._activationPromises.hasOwnProperty(modeId)) {
			return this._activationPromises[modeId];
		}
		var c, e;
		var promise = new TPromise((cc,ee,pp) => { c = cc; e = ee; });
		this._activationPromises[modeId] = promise;

		this._createMode(modeId).then((mode) => {
			this._instantiatedModes[modeId] = mode;
			delete this._activationPromises[modeId];
			return this._instantiatedModes[modeId];
		}).then(c, e);

		return promise;
	}

	protected _createMode(modeId:string): TPromise<Modes.IMode> {
		let activationEvent = 'onLanguage:' + modeId;

		let compatModeData = LanguageExtensions.getCompatMode(modeId);

		if (compatModeData) {
			return this._pluginService.activateByEvent(activationEvent).then((_) => {
				var modeDescriptor = this._createModeDescriptor(modeId);
				let compatModeAsyncDescriptor = createAsyncDescriptor1<Modes.IModeDescriptor, Modes.IMode>(compatModeData.moduleId, compatModeData.ctorName);
				return this._threadService.createInstance(compatModeAsyncDescriptor, modeDescriptor);
			}).then((compatMode) => {
				if (compatMode.configSupport) {
					compatMode.configSupport.configure(this.getConfigurationForMode(modeId));
				}
				return compatMode;
			});
		} else {
			let frankensteinMode = this._getOrCreateFrankensteinMode(modeId);
			this._pluginService.activateByEvent(activationEvent).done(null, Errors.onUnexpectedError);
			return TPromise.as(frankensteinMode);
		}
	}

	private _getOrCreateFrankensteinMode(modeId:string): FrankensteinMode {
		if (!this._frankensteinModes.hasOwnProperty(modeId)) {
			var modeDescriptor = this._createModeDescriptor(modeId);
			this._frankensteinModes[modeId] = this._threadService.createInstance(FrankensteinMode, modeDescriptor);
		}
		return this._frankensteinModes[modeId];
	}

	private _createModeDescriptor(modeId:string): Modes.IModeDescriptor {
		var modesRegistry = <IEditorModesRegistry>Registry.as(Extensions.EditorModes);
		var workerParticipants = modesRegistry.getWorkerParticipants(modeId);
		return {
			id: modeId,
			workerParticipants: workerParticipants.map(p => createAsyncDescriptor0(p.moduleId, p.ctorName))
		};
	}

	protected registerModeSupport<T>(modeId: string, support: string, callback: (mode: Modes.IMode) => T): IDisposable {
		var promise = this._getOrCreateMode(modeId).then(mode => {
			if (mode.registerSupport) {
				return mode.registerSupport(support, callback);
			} else {
				console.warn('Cannot register support ' + support + ' on mode ' + modeId + ' because it is not a Frankenstein mode');
				return EmptyDisposable;
			}
		});
		return {
			dispose: () => {
				promise.done(disposable => disposable.dispose(), null);
			}
		};
	}

	protected doRegisterMonarchDefinition(modeId:string, lexer: MonarchCommonTypes.ILexer): IDisposable {
		return combinedDispose(
			this.registerTokenizationSupport(modeId, (mode: Modes.IMode) => {
				return createTokenizationSupport(this, mode, lexer);
			}),

			this.registerRichEditSupport(modeId, MonarchDefinition.createRichEditSupport(lexer))
		);
	}

	public registerMonarchDefinition(modeId:string, language:MonarchTypes.ILanguage): IDisposable {
		var lexer = compile(Objects.clone(language));
		return this.doRegisterMonarchDefinition(modeId, lexer);
	}

	public registerCodeLensSupport(modeId: string, support: Modes.ICodeLensSupport): IDisposable {
		return this.registerModeSupport(modeId, 'codeLensSupport', (mode) => support);
	}

	public registerRichEditSupport(modeId: string, support: IRichEditConfiguration): IDisposable {
		return this.registerModeSupport(modeId, 'richEditSupport', (mode) => new RichEditSupport(modeId, support));
	}

	public registerDeclarativeDeclarationSupport(modeId: string, contribution: IDeclarationContribution): IDisposable {
		return this.registerModeSupport(modeId, 'declarationSupport', (mode) => new DeclarationSupport(modeId, contribution));
	}

	public registerExtraInfoSupport(modeId: string, support: Modes.IExtraInfoSupport): IDisposable {
		return this.registerModeSupport(modeId, 'extraInfoSupport', (mode) => support);
	}

	public registerFormattingSupport(modeId: string, support: Modes.IFormattingSupport): IDisposable {
		return this.registerModeSupport(modeId, 'formattingSupport', (mode) => support);
	}

	public registerInplaceReplaceSupport(modeId: string, support: Modes.IInplaceReplaceSupport): IDisposable {
		return this.registerModeSupport(modeId, 'inplaceReplaceSupport',(mode) => support);
	}

	public registerOccurrencesSupport(modeId: string, support: Modes.IOccurrencesSupport): IDisposable {
		return this.registerModeSupport(modeId, 'occurrencesSupport', (mode) => support);
	}

	public registerOutlineSupport(modeId: string, support: Modes.IOutlineSupport): IDisposable {
		return this.registerModeSupport(modeId, 'outlineSupport', (mode) => support);
	}

	public registerDeclarativeParameterHintsSupport(modeId: string, support: IParameterHintsContribution): IDisposable {
		return this.registerModeSupport(modeId, 'parameterHintsSupport', (mode) => new ParameterHintsSupport(modeId, support));
	}

	public registerQuickFixSupport(modeId: string, support: Modes.IQuickFixSupport): IDisposable {
		return this.registerModeSupport(modeId, 'quickFixSupport', (mode) => support);
	}

	public registerDeclarativeReferenceSupport(modeId: string, contribution: IReferenceContribution): IDisposable {
		return this.registerModeSupport(modeId, 'referenceSupport', (mode) => new ReferenceSupport(modeId, contribution));
	}

	public registerRenameSupport(modeId: string, support: Modes.IRenameSupport): IDisposable {
		return this.registerModeSupport(modeId, 'renameSupport', (mode) => support);
	}

	public registerDeclarativeSuggestSupport(modeId: string, declaration: ISuggestContribution): IDisposable {
		return this.registerModeSupport(modeId, 'suggestSupport', (mode) => new SuggestSupport(modeId, declaration));
	}

	public registerTokenizationSupport(modeId: string, callback: (mode: Modes.IMode) => Modes.ITokenizationSupport): IDisposable {
		return this.registerModeSupport(modeId, 'tokenizationSupport', callback);
	}
}

export class MainThreadModeServiceImpl extends ModeServiceImpl {
	private _modelService: IModelService;
	private _hasInitialized: boolean;

	constructor(threadService:IThreadService, pluginService:IPluginService, modelService:IModelService) {
		super(threadService, pluginService);
		this._modelService = modelService;
		this._hasInitialized = false;
	}

	private _getModeServiceWorkerHelper(): ModeServiceWorkerHelper {
		let r = this._threadService.getRemotable(ModeServiceWorkerHelper);
		if (!this._hasInitialized) {
			this._hasInitialized = true;
			let modeRegistry = <IEditorModesRegistry> Registry.as(Extensions.EditorModes);
			r.initialize(modeRegistry._getAllWorkerParticipants());
		}
		return r;
	}

	public configureModeById(modeId:string, options:any):void {
		this._getModeServiceWorkerHelper().configureModeById(modeId, options);
		super.configureModeById(modeId, options);
	}

	protected _createMode(modeId:string): TPromise<Modes.IMode> {
		// Instantiate mode also in worker
		this._getModeServiceWorkerHelper().instantiateMode(modeId);
		return super._createMode(modeId);
	}

	protected registerModeSupport<T>(modeId: string, support: string, callback: (mode: Modes.IMode) => T): IDisposable {
		// Since there is a code path that leads to Frankenstein mode instantiation, instantiate mode also in worker
		this._getModeServiceWorkerHelper().instantiateMode(modeId);
		return super.registerModeSupport(modeId, support, callback);
	}

	public registerMonarchDefinition(modeId:string, language:MonarchTypes.ILanguage): IDisposable {
		this._getModeServiceWorkerHelper().registerMonarchDefinition(modeId, language);
		var lexer = compile(Objects.clone(language));
		return combinedDispose(
			super.doRegisterMonarchDefinition(modeId, lexer),

			this.registerModeSupport(modeId, 'suggestSupport', (mode) => {
				return new ComposableSuggestSupport(modeId, MonarchDefinition.createSuggestSupport(this._modelService, mode, lexer));
			})
		);
	}
}

@Remotable.WorkerContext('ModeServiceWorkerHelper', ThreadAffinity.All)
export class ModeServiceWorkerHelper {
	private _modeService:IModeService;

	constructor(@IModeService modeService:IModeService) {
		this._modeService = modeService;
	}

	public initialize(workerParticipants:Modes.IWorkerParticipantDescriptor[]): void {
		var modeRegistry = <IEditorModesRegistry> Registry.as(Extensions.EditorModes);
		modeRegistry._setWorkerParticipants(workerParticipants);
	}

	public instantiateMode(modeId:string): void {
		this._modeService.getOrCreateMode(modeId).done(null, Errors.onUnexpectedError);
	}

	public configureModeById(modeId:string, options:any):void {
		this._modeService.configureMode(modeId, options);
	}

	public registerMonarchDefinition(modeId:string, language:MonarchTypes.ILanguage): void {
		this._modeService.registerMonarchDefinition(modeId, language);
	}
}