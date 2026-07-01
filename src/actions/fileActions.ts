import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { getWorkspaceRootUri, toWorkspaceRelativePath } from './projectActions';

function resolveTargetUri(targetPath: string): vscode.Uri {
	if (path.isAbsolute(targetPath)) {
		return vscode.Uri.file(targetPath);
	}

	const root = getWorkspaceRootUri();
	if (!root) {
		throw new Error('Aucun dossier workspace ouvert.');
	}

	return vscode.Uri.joinPath(root, targetPath);
}

export async function readTextFile(targetPath: string): Promise<{ path: string; content: string }> {
	const uri = resolveTargetUri(targetPath);
	const data = await vscode.workspace.fs.readFile(uri);
	return {
		path: toWorkspaceRelativePath(uri),
		content: Buffer.from(data).toString('utf8')
	};
}

export async function writeTextFile(targetPath: string, content: string): Promise<{ path: string }> {
	const uri = resolveTargetUri(targetPath);
	await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));

	return {
		path: toWorkspaceRelativePath(uri)
	};
}

export async function appendTextFile(targetPath: string, content: string): Promise<{ path: string }> {
	const uri = resolveTargetUri(targetPath);
	await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });

	let current = '';
	try {
		const data = await vscode.workspace.fs.readFile(uri);
		current = Buffer.from(data).toString('utf8');
	} catch {
		current = '';
	}

	const nextContent = `${current}${content}`;
	await vscode.workspace.fs.writeFile(uri, Buffer.from(nextContent, 'utf8'));

	return {
		path: toWorkspaceRelativePath(uri)
	};
}

export async function replaceInFile(
	targetPath: string,
	search: string,
	replacement: string
): Promise<{ path: string; replaced: boolean }> {
	const file = await readTextFile(targetPath);
	const replaced = file.content.includes(search);
	if (!replaced) {
		return {
			path: file.path,
			replaced: false
		};
	}

	const updated = file.content.replace(search, replacement);
	await writeTextFile(targetPath, updated);

	return {
		path: file.path,
		replaced: true
	};
}
