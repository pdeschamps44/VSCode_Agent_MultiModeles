import * as vscode from 'vscode';

export function getWorkspaceRootUri(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function toWorkspaceRelativePath(uri: vscode.Uri): string {
	const root = getWorkspaceRootUri();
	if (!root) {
		return uri.fsPath;
	}

	return vscode.workspace.asRelativePath(uri, false);
}

export async function listProjectFiles(
	globPattern = '**/*',
	maxResults = 200
): Promise<string[]> {
	const files = await vscode.workspace.findFiles(
		globPattern,
		'{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}',
		maxResults
	);

	return files.map((uri) => toWorkspaceRelativePath(uri));
}
