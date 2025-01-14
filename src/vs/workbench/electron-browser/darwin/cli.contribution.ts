/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';
import * as pfs from 'vs/base/node/pfs';
import { nfcall } from 'vs/base/common/async';
import { TPromise } from 'vs/base/common/winjs.base';
import URI from 'vs/base/common/uri';
import { Action } from 'vs/base/common/actions';
import { IWorkbenchActionRegistry, Extensions as ActionExtensions } from 'vs/workbench/common/actionRegistry';
import { IWorkbenchContributionsRegistry, IWorkbenchContribution, Extensions as WorkbenchExtensions } from 'vs/workbench/common/contributions';
import { Registry } from 'vs/platform/platform';
import { SyncActionDescriptor } from 'vs/platform/actions/common/actions';
import { IWorkspaceContextService } from 'vs/workbench/services/workspace/common/contextService';
import { IMessageService, Severity } from 'vs/platform/message/common/message';
import { IEditorService } from 'vs/platform/editor/common/editor';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';

function ignore<T>(code: string, value: T = null): (err: any) => TPromise<T> {
	return err => err.code === code ? TPromise.as<T>(value) : TPromise.wrapError<T>(err);
}

const root = URI.parse(require.toUrl('')).fsPath;
const source = path.resolve(root, '..', 'bin', 'code');
const isAvailable = fs.existsSync(source);

class InstallAction extends Action {

	static ID = 'workbench.action.installCommandLine';
	static LABEL = nls.localize('install', 'Install in PATH');

	constructor(
		id: string,
		label: string,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IMessageService private messageService: IMessageService,
		@IEditorService private editorService: IEditorService
	) {
		super(id, label);
	}

	private get applicationName(): string {
		return this.contextService.getConfiguration().env.applicationName;
	}

	private get target(): string {
		return `/usr/local/bin/${ this.applicationName }`;
	}

	run(): TPromise<void> {
		return this.checkLegacy()
			.then(files => {
				if (files.length > 0) {
					const file = files[0];
					const resource = URI.create('file', null, file);
					const message = nls.localize('exists', "Please remove the 'code' alias in '{0}' and retry this action.", file);
					const input = { resource, mime: 'text/x-shellscript' };
					const actions = [
						new Action('inlineEdit', nls.localize('editFile', "Edit '{0}'", file), '', true, () => {
							return this.editorService.openEditor(input).then(() => {
								const message = nls.localize('again', "Once you remove the 'code' alias, you can retry the PATH installation.");
								const actions = [
									new Action('cancel', nls.localize('cancel', "Cancel")),
									new Action('yes', nls.localize('retry', "Retry"), '', true, () => this.run())
								];

								this.messageService.show(Severity.Info, { message, actions });
							});
						})
					];

					this.messageService.show(Severity.Warning, { message, actions });
					return TPromise.as(null);
				}

				return this.isInstalled()
					.then(isInstalled => {
						if (!isAvailable || isInstalled) {
							return TPromise.as(null);
						} else {
							const createSymlink = () => {
								return pfs.unlink(this.target)
									.then(null, ignore('ENOENT'))
									.then(() => pfs.symlink(source, this.target));
							};

							return createSymlink().then(null, err => {
								if (err.code === 'EACCES' || err.code === 'ENOENT') {
									return this.createBinFolder()
										.then(() => createSymlink());
								}

								return TPromise.wrapError(err);
							});
						}
					})
					.then(() => this.messageService.show(Severity.Info, nls.localize('success', 'Shortcut \'{0}\' successfully installed in PATH.', this.applicationName)));
			});
	}

	private isInstalled(): TPromise<boolean> {
		return pfs.lstat(this.target)
			.then(stat => stat.isSymbolicLink())
			.then(() => pfs.readlink(this.target))
			.then(link => link === source)
			.then(null, ignore('ENOENT', false));
	}

	private createBinFolder(): TPromise<void> {
		const command = 'osascript -e "do shell script \\"mkdir -p /usr/local/bin && chown \\" & (do shell script (\\"whoami\\")) & \\" /usr/local/bin\\" with administrator privileges"';

		return nfcall(cp.exec, command, {})
			.then(null, _ => TPromise.wrapError(new Error(nls.localize('cantCreateBinFolder', "Unable to create '/usr/local/bin'."))));
	}

	public checkLegacy(): TPromise<string[]> {
		const readOrEmpty = name => pfs.readFile(name, 'utf8')
			.then(null, ignore('ENOENT', ''));

		const files = [
			path.join(os.homedir(), '.bash_profile'),
			path.join(os.homedir(), '.bashrc'),
			path.join(os.homedir(), '.zshrc')
		];

		return TPromise.join(files.map(f => readOrEmpty(f))).then(result => {
			return result.reduce((result, contents, index) => {
				const env = this.contextService.getConfiguration().env;

				if (contents.indexOf(env.darwinBundleIdentifier) > -1) {
					result.push(files[index]);
				}

				return result;
			}, []);
		});
	}
}

class UninstallAction extends Action {

	static ID = 'workbench.action.uninstallCommandLine';
	static LABEL = nls.localize('uninstall', 'Uninstall from PATH');

	constructor(
		id: string,
		label: string,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IMessageService private messageService: IMessageService
	) {
		super(id, label);
	}

	private get applicationName(): string {
		return this.contextService.getConfiguration().env.applicationName;
	}

	private get target(): string {
		return `/usr/local/bin/${ this.applicationName }`;
	}

	run(): TPromise<void> {
		return pfs.unlink(this.target)
			.then(null, ignore('ENOENT'))
			.then(() => this.messageService.show(Severity.Info, nls.localize('success', 'Shortcut \'{0}\' successfully uninstalled from PATH.', this.applicationName)));
	}
}

class DarwinCLIHelper implements IWorkbenchContribution {

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IMessageService messageService: IMessageService
	) {
		const installAction = instantiationService.createInstance(InstallAction, InstallAction.ID, InstallAction.LABEL);

		installAction.checkLegacy().done(files => {
			if (files.length > 0) {
				const message = nls.localize('update', "Code needs to update the command line launcher. Would you like to do this now?");
				const actions = [
					new Action('later', nls.localize('now', "Later")),
					new Action('now', nls.localize('now', "Update Now"), '', true, () => installAction.run())
				];

				messageService.show(Severity.Info, { message, actions });
			}
		});
	}

	getId(): string {
		return 'darwin.cli';
	}
}

if (isAvailable && process.platform === 'darwin') {
	const category = nls.localize('commandLine', "Command Line");

	const workbenchActionsRegistry = <IWorkbenchActionRegistry>Registry.as(ActionExtensions.WorkbenchActions);
	workbenchActionsRegistry.registerWorkbenchAction(new SyncActionDescriptor(InstallAction, InstallAction.ID, InstallAction.LABEL), category);
	workbenchActionsRegistry.registerWorkbenchAction(new SyncActionDescriptor(UninstallAction, UninstallAction.ID, UninstallAction.LABEL), category);

	const workbenchRegistry = <IWorkbenchContributionsRegistry>Registry.as(WorkbenchExtensions.Workbench);
	workbenchRegistry.registerWorkbenchContribution(DarwinCLIHelper);
}
