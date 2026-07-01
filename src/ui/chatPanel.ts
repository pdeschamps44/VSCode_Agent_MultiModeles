import * as vscode from "vscode";
export function createChatPanel(context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel(
    "kimiHardwareChat",
    "Kimi Hardware Agent",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
    }
  );

  const htmlUri = vscode.Uri.joinPath(context.extensionUri, "media", "chat.html");
  vscode.workspace.fs.readFile(htmlUri).then((data) => {
    panel.webview.html = data.toString();
  });

  return panel;
}
