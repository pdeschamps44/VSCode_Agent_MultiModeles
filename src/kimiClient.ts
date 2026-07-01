import * as vscode from 'vscode';
import fetch from 'node-fetch';

export type LlmProvider = 'moonshot' | 'openrouter';

export interface KimiMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
}

export interface KimiResponse {
    text: string;
    error?: string;
    provider?: LlmProvider;
    model?: string;
}

export class KimiClient {

    constructor(private context: vscode.ExtensionContext) {}

    private getProvider(): LlmProvider {
        const configValue = vscode.workspace
            .getConfiguration('kimi')
            .get<string>('provider', 'moonshot')
            .toLowerCase();

        return configValue === 'openrouter' ? 'openrouter' : 'moonshot';
    }

    private getModel(provider: LlmProvider): string {
        const defaultModel = provider === 'openrouter'
            ? 'moonshotai/kimi-k2.7-code'
            : 'kimi-k2.7-code';

        return vscode.workspace.getConfiguration('kimi').get<string>('model', defaultModel);
    }

    private getTemperature(): number {
        return vscode.workspace.getConfiguration('kimi').get<number>('temperature', 0.2);
    }

    private getMaxTokens(): number {
        return vscode.workspace.getConfiguration('kimi').get<number>('maxTokens', 4096);
    }

    private getOpenRouterHeaders(): { referer: string; title: string } {
        const config = vscode.workspace.getConfiguration('kimi');
        return {
            referer: config.get<string>('openrouter.referer', 'http://localhost'),
            title: config.get<string>('openrouter.title', 'Kimi Hardware Agent')
        };
    }

    async sendMessages(messages: KimiMessage[], stream = false): Promise<KimiResponse> {
        const provider = this.getProvider();
        const model = this.getModel(provider);
        const temperature = this.getTemperature();
        const maxTokens = this.getMaxTokens();

        const apiKeySecretName = provider === 'openrouter' ? 'openrouterApiKey' : 'kimiApiKey';
        const apiKey = await this.context.secrets.get(apiKeySecretName);

        if (!apiKey) {
            return {
                text: '',
                provider,
                model,
                error: provider === 'openrouter'
                    ? 'Clé API OpenRouter non configurée. Exécutez : Kimi: Configurer la clé API OpenRouter.'
                    : 'Clé API Moonshot/Kimi non configurée. Exécutez : Kimi: Configurer la clé API Moonshot.'
            };
        }

        try {
            const endpoint = provider === 'openrouter'
                ? 'https://openrouter.ai/api/v1/chat/completions'
                : 'https://api.moonshot.ai/v1/chat/completions';

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
            };

            if (provider === 'openrouter') {
                const openRouterHeaders = this.getOpenRouterHeaders();
                headers['HTTP-Referer'] = openRouterHeaders.referer;
                headers['X-Title'] = openRouterHeaders.title;
            }

            const response = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    model,
                    messages,
                    temperature,
                    max_tokens: maxTokens,
                    stream
                })
            });

            if (response.status === 429) {
                return {
                    text: "",
                    provider,
                    model,
                    error: "Limite de requêtes atteinte. Réessaie dans 30 à 60 secondes."
                };
            }

            if (response.status === 401 || response.status === 403) {
                return {
                    text: '',
                    provider,
                    model,
                    error: `Authentification refusée (${response.status}). Vérifie la clé API et le provider sélectionné.`
                };
            }

            if (!response.ok) {
                const body = await response.text();
                return {
                    text: "",
                    provider,
                    model,
                    error: `Erreur API : ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`
                };
            }

            // Mode streaming
            if (stream) {
                return {
                    text: "⚠️ Le streaming n'est pas encore activé dans cette version.",
                    provider,
                    model
                };
            }

            // Mode normal
            const data: any = await response.json();
            const text = data?.choices?.[0]?.message?.content ?? "";

            return {
                text,
                provider,
                model
            };

        } catch (err: any) {
            return {
                text: "",
                provider,
                model,
                error: `Erreur réseau : ${err.message}`
            };
        }
    }

    /**
     * Envoie un simple prompt utilisateur (compatibilité avec ton ancienne version)
     */
    async sendMessage(prompt: string): Promise<KimiResponse> {
        return this.sendMessages([
            {
                role: "system",
                content: "Tu es Kimi Hardware Agent, un expert en électronique, PCB, SPICE, firmware et analyse de signaux."
            },
            {
                role: "user",
                content: prompt
            }
        ]);
    }
}
