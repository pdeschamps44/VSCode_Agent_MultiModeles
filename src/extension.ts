import * as vscode from 'vscode';
import { createChatPanel } from './ui/chatPanel';
import { Agent } from './agent';

interface ModelChoice {
    label: string;
    value: string;
}

function formatDryRunJsonIfAny(text: string): string {
    const candidate = text.trim();
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
        return text;
    }

    try {
        const payload = JSON.parse(candidate) as Record<string, unknown>;
        if (payload.dryRun !== true || typeof payload.action !== 'string') {
            return text;
        }

        const path = typeof payload.path === 'string' ? payload.path : 'inconnu';
        const action = String(payload.action);

        if (action === 'write_file') {
            return [
                '[DRY-RUN] write_file',
                `Fichier: ${path}`,
                `Taille actuelle: ${Number(payload.existingLength ?? 0)} chars`,
                `Nouvelle taille: ${Number(payload.newLength ?? 0)} chars`
            ].join('\n');
        }

        if (action === 'append_file') {
            return [
                '[DRY-RUN] append_file',
                `Fichier: ${path}`,
                `Taille actuelle: ${Number(payload.existingLength ?? 0)} chars`,
                `Taille ajoutee: ${Number(payload.appendLength ?? 0)} chars`,
                `Taille finale estimee: ${Number(payload.resultingLength ?? 0)} chars`
            ].join('\n');
        }

        if (action === 'replace') {
            return [
                '[DRY-RUN] replace',
                `Fichier: ${path}`,
                `Occurrences trouvees: ${Number(payload.occurrences ?? 0)}`,
                `Remplacement effectif: ${Boolean(payload.wouldReplace) ? 'oui' : 'non'}`,
                `Taille avant: ${Number(payload.beforeLength ?? 0)} chars`,
                `Taille apres: ${Number(payload.afterLength ?? 0)} chars`
            ].join('\n');
        }

        return text;
    } catch {
        return text;
    }
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

    // � Log d'activation
    const config = vscode.workspace.getConfiguration('kimi');
    const provider = config.get<string>('provider', 'moonshot');
    const model = config.get<string>('model', 'kimi-k2.7-code');
    
    // Note: Les logs du logger de l'agent s'affichent automatiquement dans le canal "Kimi Hardware Agent"
    console.log(`[Kimi Hardware Agent] Activé avec provider=${provider}, model=${model}`);

    // �🟦 Commande : Ouvrir le chat Kimi
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
                const domainLabel = reply.domain ?? 'general';
                const iterationLabel = reply.iterations ?? 1;
                const executionMode = reply.dryRun ? 'DRY-RUN (preview only)' : 'LIVE (writes enabled)';
                const metadata = `Modele: ${providerLabel} / ${modelLabel}\nSous-agent: ${domainLabel}\nIterations: ${iterationLabel}\nExecution: ${executionMode}`;

                if (reply.error) {
                    panel.webview.postMessage({
                        type: 'error',
                        text: `${metadata}\n${reply.error}`
                    });
                    return;
                }

                const formattedReplyText = reply.dryRun ? formatDryRunJsonIfAny(reply.text) : reply.text;

                // Renvoi de la réponse à la Webview
                panel.webview.postMessage({
                    type: "response",
                    text: `${metadata}\n\n${formattedReplyText}`
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
