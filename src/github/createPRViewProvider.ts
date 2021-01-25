/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { byRemoteName, DetachedHeadError, FolderRepositoryManager, PullRequestDefaults, titleAndBodyFrom } from './folderRepositoryManager';
import webviewContent from '../../media/createPR-webviewIndex.js';
import { getNonce, IRequestMessage, WebviewViewBase } from '../common/webview';
import { PR_SETTINGS_NAMESPACE, PR_TITLE } from '../common/settingKeys';
import { OctokitCommon } from './common';
import { PullRequestModel } from './pullRequestModel';
import Logger from '../common/logger';
import { PullRequestGitHelper } from './pullRequestGitHelper';

export type PullRequestTitleSource = 'commit' | 'branch' | 'custom' | 'ask';

export enum PullRequestTitleSourceEnum {
	Commit = 'commit',
	Branch = 'branch',
	Custom = 'custom',
	Ask = 'ask'
}

export type PullRequestDescriptionSource = 'template' | 'commit' | 'custom' | 'ask';

export enum PullRequestDescriptionSourceEnum {
	Template = 'template',
	Commit = 'commit',
	Custom = 'custom',
	Ask = 'ask'
}

interface RemoteInfo {
	owner: string;
	repositoryName: string;
}

export class CreatePullRequestViewProvider extends WebviewViewBase implements vscode.WebviewViewProvider {
	public readonly viewType = 'github:createPullRequest';

	private _onDone = new vscode.EventEmitter<PullRequestModel | undefined>();
	readonly onDone: vscode.Event<PullRequestModel | undefined> = this._onDone.event;

	private _onDidChangeSelectedRemote = new vscode.EventEmitter<RemoteInfo>();
	readonly onDidChangeSelectedRemote: vscode.Event<RemoteInfo> = this._onDidChangeSelectedRemote.event;

	private _onDidChangeSelectedBranch = new vscode.EventEmitter<string>();
	readonly onDidChangeSelectedBranch: vscode.Event<string> = this._onDidChangeSelectedBranch.event;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _folderRepositoryManager: FolderRepositoryManager,
		private readonly _pullRequestDefaults: PullRequestDefaults,
		private readonly _isDraft: boolean
	) {
		super();
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {

		this._view = webviewView;
		this._webview = webviewView.webview;
		super.initialize();
		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this._context.extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview();

		this.initializeParams();
	}

	private async getTitle(): Promise<string> {
		const method = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<PullRequestTitleSource>(PR_TITLE, PullRequestTitleSourceEnum.Ask);

		switch (method) {

			case PullRequestTitleSourceEnum.Branch:
				return this._folderRepositoryManager.repository.state.HEAD!.name!;

			case PullRequestTitleSourceEnum.Commit:
				return titleAndBodyFrom(await this._folderRepositoryManager.getHeadCommitMessage()).title;

			case PullRequestTitleSourceEnum.Custom:
				return '';

			default:
				// Use same default as GitHub, if there is only one commit, use the commit, otherwise use the branch name.
				// By default, the base branch we use for comparison is the base branch of origin. Compare this to the
				// current local branch if it has a GitHub remote.
				const origin = await this._folderRepositoryManager.getOrigin();
				const repositoryHead = this._folderRepositoryManager.repository.state.HEAD;

				let hasMultipleCommits = true;
				if (repositoryHead?.upstream) {
					const headRepo = this._folderRepositoryManager.findRepo(byRemoteName(repositoryHead?.upstream.remote));
					if (headRepo) {
						const headBranch = `${headRepo.remote.owner}:${repositoryHead.name}`;
						const commits = await origin.compareCommits(this._pullRequestDefaults.base, headBranch);
						hasMultipleCommits = commits.total_commits > 1;
					}
				}

				if (hasMultipleCommits) {
					return this._folderRepositoryManager.repository.state.HEAD!.name!;
				} else {
					return titleAndBodyFrom(await this._folderRepositoryManager.getHeadCommitMessage()).title;
				}
		}
	}

	private async getPullRequestTemplate(): Promise<string> {
		const templateUris = await this._folderRepositoryManager.getPullRequestTemplates();
		if (templateUris[0]) {
			try {
				const templateContent = await vscode.workspace.fs.readFile(templateUris[0]);
				return templateContent.toString();
			} catch (e) {
				Logger.appendLine(`Reading pull request template failed: ${e}`);
				return '';
			}
		}

		return '';
	}

	private async getDescription(): Promise<string> {
		const method = vscode.workspace.getConfiguration('githubPullRequests').get<PullRequestDescriptionSource>('pullRequestDescription', PullRequestDescriptionSourceEnum.Ask);

		switch (method) {

			case PullRequestDescriptionSourceEnum.Template:
				return this.getPullRequestTemplate();

			case PullRequestDescriptionSourceEnum.Commit:
				return titleAndBodyFrom(await this._folderRepositoryManager.getHeadCommitMessage()).body;

			case PullRequestDescriptionSourceEnum.Custom:
				return '';

			default:
				// Try to match github's default, first look for template, then use commit body if available.
				const pullRequestTemplate = this.getPullRequestTemplate();
				return pullRequestTemplate ?? titleAndBodyFrom(await this._folderRepositoryManager.getHeadCommitMessage()).body ?? '';
		}
	}

	public async initializeParams(): Promise<void> {
		if (!this._folderRepositoryManager.repository.state.HEAD) {
			throw new DetachedHeadError(this._folderRepositoryManager.repository);
		}

		const defaultRemote: RemoteInfo = {
			owner: this._pullRequestDefaults.owner,
			repositoryName: this._pullRequestDefaults.repo
		};

		Promise.all([
			this._folderRepositoryManager.getGitHubRemotes(),
			this._folderRepositoryManager.listBranches(this._pullRequestDefaults.owner, this._pullRequestDefaults.repo),
			this.getTitle(),
			this.getDescription()
		]).then(result => {
			const [githubRemotes, branchesForRemote, defaultTitle, defaultDescription] = result;

			const remotes: RemoteInfo[] = githubRemotes.map(remote => {
				return {
					owner: remote.owner,
					repositoryName: remote.repositoryName
				};
			});

			this._postMessage({
				command: 'pr.initialize',
				params: {
					availableRemotes: remotes,
					defaultRemote,
					defaultBranch: this._pullRequestDefaults.base,
					branchesForRemote,
					defaultTitle,
					defaultDescription,
					isDraft: this._isDraft
				}
			});
		});
	}

	private async changeRemote(message: IRequestMessage<{ owner: string, repositoryName: string }>): Promise<void> {
		const { owner, repositoryName } = message.args;
		const githubRepository = this._folderRepositoryManager.findRepo(repo => owner === repo.remote.owner && repositoryName === repo.remote.repositoryName);

		if (!githubRepository) {
			throw new Error('No matching GitHub repository found.');
		}

		const defaultBranch = await githubRepository.getDefaultBranch();
		const newBranches = await this._folderRepositoryManager.listBranches(owner, repositoryName);
		this._onDidChangeSelectedRemote.fire({ owner, repositoryName });
		return this._replyMessage(message, { branches: newBranches, defaultBranch });
	}

	private async create(message: IRequestMessage<OctokitCommon.PullsCreateParams>): Promise<void> {
		try {
			if (!this._folderRepositoryManager.repository.state.HEAD!.upstream) {
				throw new DetachedHeadError(this._folderRepositoryManager.repository);
			}

			const branchName = this._folderRepositoryManager.repository.state.HEAD!.name!;
			const headRepo = this._folderRepositoryManager.findRepo(byRemoteName(this._folderRepositoryManager.repository.state.HEAD!.upstream.remote));
			if (!headRepo) {
				throw new Error(`Unable to find GitHub repository matching '${this._folderRepositoryManager.repository.state.HEAD!.upstream.remote}'.`);
			}

			const head = `${headRepo.remote.owner}:${branchName}`;
			const createdPR = await this._folderRepositoryManager.createPullRequest({ ...message.args, head });

			// Create was cancelled
			if (!createdPR) {
				this._throwError(message, undefined);
			} else {
				await this._replyMessage(message, {});
				await PullRequestGitHelper.associateBranchWithPullRequest(this._folderRepositoryManager.repository, createdPR, branchName);
				this._onDone.fire(createdPR);
			}
		} catch (e) {
			this._throwError(message, e.message);
		}

	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>) {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}

		switch (message.command) {

			case 'pr.cancelCreate':
				vscode.commands.executeCommand('setContext', 'github:createPullRequest', false);
				this._onDone.fire(undefined);
				return;

			case 'pr.create':
				return this.create(message);

			case 'pr.changeRemote':
				return this.changeRemote(message);

			case 'pr.changeBranch':
				this._onDidChangeSelectedBranch.fire(message.args);
				return;

			default:
				// Log error
				vscode.window.showErrorMessage('Unsupported webview message');
		}
	}

	private _getHtmlForWebview() {
		const nonce = getNonce();

		let content = webviewContent;

		let src = '';
		if (this._context.extensionMode === vscode.ExtensionMode.Development) {
			const uri = vscode.Uri.joinPath(this._context.extensionUri, 'media', 'createPR-webviewIndex.js');
			src = ` src="${this._webview!.asWebviewUri(uri).toString()}"`;
			content = '';
		}

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">

		<title>Create Pull Request</title>
	</head>
	<body>
		<div id="app"></div>
		<script nonce="${nonce}"${src}>${content}</script>
	</body>
</html>`;
	}
}