import * as vscode from 'vscode';
import { createChatPanel } from './ui/chatPanel';
import { Agent } from './agent';

interface ModelChoice {
    label: string;
    value: string;
}

async function pickProviderAndModel(): Promise<{ provider: 'moonshot' | 'openrouter'; model: string } | undefined> {
    const providerPick = await vscode.window.showQuickPick(
        [
            { label: 'Moonshot (direct)', value: 'moonshot' as const },
            { label: 'OpenRouter', value: 'openrouter' as const }
        ],
        {
            title: 'Kimi Hardware Agent - Choisir un provider',
            placeHolder: 'Sélectionnez le provider LLM'
        }
    );

    if (!providerPick) {
        return undefined;
    }

    const modelChoices: ModelChoice[] = providerPick.value === 'moonshot'
        ? [
            { label: 'kimi-k2.7-code', value: 'kimi-k2.7-code' },
            { label: 'Saisir un modèle personnalisé...', value: '__custom__' }
        ]
        : [
            { label: 'moonshotai/kimi-k2.7-code', value: 'moonshotai/kimi-k2.7-code' },
            { label: 'anthropic/claude-haiku-4.5', value: 'anthropic/claude-haiku-4.5' },
            { label: 'qwen/qwen-2.5-72b-instruct', value: 'qwen/qwen-2.5-72b-instruct' },
            { label: 'Saisir un modèle personnalisé...', value: '__custom__' }
        ];

    const modelPick = await vscode.window.showQuickPick(modelChoices, {
        title: 'Kimi Hardware Agent - Choisir un modèle',
        placeHolder: 'Sélectionnez le modèle à utiliser'
    });

    if (!modelPick) {
        return undefined;
    }

    let model = modelPick.value;
    if (model === '__custom__') {
        const customModel = await vscode.window.showInputBox({
            prompt: 'Saisissez le nom exact du modèle',
            ignoreFocusOut: true
        });

        if (!customModel?.trim()) {
            return undefined;
        }
        model = customModel.trim();
    }

    return {
        provider: providerPick.value,
        model
    };
}

export function activate(context: vscode.ExtensionContext) {

    // 🧠 Création de l'agent central
    const agent = new Agent(context);

    // 🟦 Commande : Ouvrir le chat Kimi
    const openChat = vscode.commands.registerCommand('kimi.openChat', () => {

        // Création du panneau Webview
        const panel = createChatPanel(context);

        // Réception des messages envoyés depuis la Webview
        panel.webview.onDidReceiveMessage(async (msg) => {

            if (msg.type === "userMessage") {
                panel.webview.postMessage({ type: "thinking" });

                // Appel à l'agent minimal
                const reply = await agent.handleUserMessage(msg.text);

                const providerLabel = reply.provider ?? 'unknown-provider';
                const modelLabel = reply.model ?? 'unknown-model';
                const metadata = `Modele: ${providerLabel} / ${modelLabel}`;

                if (reply.error) {
                    panel.webview.postMessage({
                        type: 'error',
                        text: `${metadata}\n${reply.error}`
                    });
                    return;
                }

                // Renvoi de la réponse à la Webview
                panel.webview.postMessage({
                    type: "response",
                    text: `${metadata}\n\n${reply.text}`
                });
            }
        });
    });

    // 🟩 Commande : Configurer la clé API Moonshot/Kimi
    const setMoonshotApiKey = vscode.commands.registerCommand('kimi.setMoonshotApiKey', async () => {
        const key = await vscode.window.showInputBox({
            prompt: "Entrez votre clé API Moonshot/Kimi",
            ignoreFocusOut: true,
            password: true
        });

        if (key) {
            await context.secrets.store("kimiApiKey", key);
            vscode.window.showInformationMessage("Clé API Moonshot/Kimi enregistrée avec succès.");
        }
    });

    // 🟨 Commande : Configurer la clé API OpenRouter
    const setOpenRouterApiKey = vscode.commands.registerCommand('kimi.setOpenRouterApiKey', async () => {
        const key = await vscode.window.showInputBox({
            prompt: "Entrez votre clé API OpenRouter",
            ignoreFocusOut: true,
            password: true
        });

        if (key) {
            await context.secrets.store("openrouterApiKey", key);
            vscode.window.showInformationMessage("Clé API OpenRouter enregistrée avec succès.");
        }
    });

    // 🟪 Commande : Choisir provider + modèle
    const setProviderAndModel = vscode.commands.registerCommand('kimi.selectProviderAndModel', async () => {
        const selection = await pickProviderAndModel();
        if (!selection) {
            return;
        }

        const config = vscode.workspace.getConfiguration('kimi');
        await config.update('provider', selection.provider, vscode.ConfigurationTarget.Global);
        await config.update('model', selection.model, vscode.ConfigurationTarget.Global);

        vscode.window.showInformationMessage(
            `Configuration mise à jour: provider=${selection.provider}, modèle=${selection.model}`
        );
    });

    // Enregistrer les commandes
    context.subscriptions.push(openChat, setMoonshotApiKey, setOpenRouterApiKey, setProviderAndModel);
}

export function deactivate() {
    // Rien à nettoyer pour l’instant
}
