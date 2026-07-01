import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { getWorkspaceRootUri, toWorkspaceRelativePath } from './projectActions';

export type SimulatedMutationAction = 'write_file' | 'append_file' | 'replace';

export interface SimulatedMutationResult {
	dryRun: true;
	success: true;
	message: string;
	action: SimulatedMutationAction;
	path: string;
	changed: boolean;
	beforeLength: number;
	afterLength: number;
	occurrences?: number;
	diffSummary: string;
	beforePreview: string;
	afterPreview: string;
	proposedPreview?: string;
	diffLog: string;
}

const PREVIEW_LIMIT = 600;

function toPreview(content: string, max = PREVIEW_LIMIT): string {
	if (content.length <= max) {
		return content;
	}

	return `${content.slice(0, max)}... [truncated ${content.length - max} chars]`;
}

function splitLines(content: string): string[] {
	if (!content) {
		return [];
	}

	return content.split(/\r?\n/);
}

function buildDiffSummary(before: string, after: string): string {
	const beforeLines = splitLines(before);
	const afterLines = splitLines(after);
	const maxLen = Math.max(beforeLines.length, afterLines.length);
	let changed = 0;

	for (let i = 0; i < maxLen; i += 1) {
		const b = beforeLines[i] ?? '';
		const a = afterLines[i] ?? '';
		if (b !== a) {
			changed += 1;
		}
	}

	const added = Math.max(0, afterLines.length - beforeLines.length);
	const removed = Math.max(0, beforeLines.length - afterLines.length);
	return `${changed} line(s) changed, +${added} / -${removed}`;
}

async function readExistingContent(uri: vscode.Uri): Promise<string> {
	try {
		const data = await vscode.workspace.fs.readFile(uri);
		return Buffer.from(data).toString('utf8');
	} catch {
		return '';
	}
}

function buildDiffLog(action: SimulatedMutationAction, workspacePath: string, before: string, after: string): string {
	return [
		`[Dry-Run] ${action} on ${workspacePath}`,
		buildDiffSummary(before, after),
		'--- BEFORE (preview) ---',
		toPreview(before),
		'--- AFTER (preview) ---',
		toPreview(after)
	].join('\n');
}

function makeSimulationResult(
	action: SimulatedMutationAction,
	workspacePath: string,
	before: string,
	after: string,
	extra?: { occurrences?: number; proposedPreview?: string }
): SimulatedMutationResult {
	return {
		dryRun: true,
		success: true,
		message: '[Dry-Run] Modification simulee avec succes',
		action,
		path: workspacePath,
		changed: before !== after,
		beforeLength: before.length,
		afterLength: after.length,
		occurrences: extra?.occurrences,
		diffSummary: buildDiffSummary(before, after),
		beforePreview: toPreview(before),
		afterPreview: toPreview(after),
		proposedPreview: extra?.proposedPreview,
		diffLog: buildDiffLog(action, workspacePath, before, after)
	};
}

function resolveTargetUri(targetPath: string): vscode.Uri {
	const root = getWorkspaceRootUri();
	if (!root) {
		throw new Error('Aucun dossier workspace ouvert.');
	}

	const normalizedInput = targetPath.trim();
	if (!normalizedInput) {
		throw new Error('Chemin de fichier vide.');
	}

	if (path.isAbsolute(normalizedInput)) {
		throw new Error('Chemins absolus interdits. Utilisez un chemin relatif au workspace.');
	}

	if (/^[a-zA-Z]:/.test(normalizedInput)) {
		throw new Error('Chemins de type drive letter interdits. Utilisez un chemin relatif au workspace.');
	}

	const candidateFsPath = path.resolve(root.fsPath, normalizedInput);
	const relative = path.relative(root.fsPath, candidateFsPath);
	const isOutsideWorkspace = relative.startsWith('..') || path.isAbsolute(relative);
	if (isOutsideWorkspace) {
		throw new Error('Acces refuse: chemin en dehors du workspace.');
	}

	if (!relative || relative === '.') {
		throw new Error('Chemin de fichier invalide: la racine workspace ne peut pas etre lue/ecrite.');
	}

	return vscode.Uri.file(candidateFsPath);
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

export async function simulateWriteTextFile(targetPath: string, content: string): Promise<SimulatedMutationResult> {
	const uri = resolveTargetUri(targetPath);
	const workspacePath = toWorkspaceRelativePath(uri);
	const before = await readExistingContent(uri);
	const after = content;

	return makeSimulationResult('write_file', workspacePath, before, after, {
		proposedPreview: toPreview(content)
	});
}

export async function simulateAppendTextFile(targetPath: string, content: string): Promise<SimulatedMutationResult> {
	const uri = resolveTargetUri(targetPath);
	const workspacePath = toWorkspaceRelativePath(uri);
	const before = await readExistingContent(uri);
	const after = `${before}${content}`;

	return makeSimulationResult('append_file', workspacePath, before, after, {
		proposedPreview: toPreview(content)
	});
}

export async function simulateReplaceInFile(
	targetPath: string,
	search: string,
	replacement: string
): Promise<SimulatedMutationResult> {
	const uri = resolveTargetUri(targetPath);
	const workspacePath = toWorkspaceRelativePath(uri);
	const before = await readExistingContent(uri);
	const occurrences = search ? before.split(search).length - 1 : 0;
	const after = occurrences > 0 ? before.replace(search, replacement) : before;

	return makeSimulationResult('replace', workspacePath, before, after, {
		occurrences,
		proposedPreview: toPreview(replacement)
	});
}
