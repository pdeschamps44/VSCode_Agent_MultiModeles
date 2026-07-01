import * as vscode from 'vscode';
import { toWorkspaceRelativePath } from './projectActions';

export interface SearchMatch {
	path: string;
	line: number;
	preview: string;
}

export async function searchInWorkspace(
	query: string,
	includeGlob = '**/*.{ts,tsx,js,jsx,json,md,txt,html,css}',
	maxResults = 30
): Promise<SearchMatch[]> {
	if (!query.trim()) {
		return [];
	}

	const lowerQuery = query.toLowerCase();
	const files = await vscode.workspace.findFiles(
		includeGlob,
		'{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}',
		250
	);

	const matches: SearchMatch[] = [];

	for (const fileUri of files) {
		if (matches.length >= maxResults) {
			break;
		}

		let text: string;
		try {
			const raw = await vscode.workspace.fs.readFile(fileUri);
			text = Buffer.from(raw).toString('utf8');
		} catch {
			continue;
		}

		const lines = text.split(/\r?\n/);
		for (let idx = 0; idx < lines.length; idx += 1) {
			if (!lines[idx].toLowerCase().includes(lowerQuery)) {
				continue;
			}

			matches.push({
				path: toWorkspaceRelativePath(fileUri),
				line: idx + 1,
				preview: lines[idx].trim()
			});

			if (matches.length >= maxResults) {
				break;
			}
		}
	}

	return matches;
}
