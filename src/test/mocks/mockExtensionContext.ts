import * as path from 'path';
import * as temp from 'temp';
import { ExtensionContext, Uri, SecretState, Event } from 'vscode';

import { InMemoryMemento } from './inMemoryMemento';

export class MockExtensionContext implements ExtensionContext {
	extensionPath = path.resolve(__dirname, '..');

	workspaceState = new InMemoryMemento();
	globalState = new InMemoryMemento();
	secretState = new class implements SecretState {
		get(key: string): Thenable<string | undefined> {
			throw new Error('Method not implemented.');
		}
		set(key: string, value: string): Thenable<void> {
			throw new Error('Method not implemented.');
		}
		delete(key: string): Thenable<void> {
			throw new Error('Method not implemented.');
		}
		onDidChange: Event<void>;
	};
	subscriptions: { dispose(): any; }[] = [];

	storagePath: string;
	globalStoragePath: string;
	logPath: string;
	extensionUri: Uri;
	environmentVariableCollection: any;
	extensionMode: any;

	logUri: Uri;

	storageUri: Uri;

	globalStorageUri: Uri;

	extensionRuntime: any;

	constructor() {
		this.storagePath = temp.mkdirSync('storage-path');
		this.globalStoragePath = temp.mkdirSync('global-storage-path');
		this.logPath = temp.mkdirSync('log-path');
	}

	asAbsolutePath(relativePath: string): string {
		return path.resolve(this.extensionPath, relativePath);
	}

	dispose() {
		this.subscriptions.forEach(sub => sub.dispose());
	}
}