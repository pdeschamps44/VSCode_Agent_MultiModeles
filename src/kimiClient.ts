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
    statusCode?: number;
}

export interface LlmSendOptions {
    provider?: LlmProvider;
    model?: string;
    stream?: boolean;
    timeoutMs?: number;
    retries?: number;
    fallbackModels?: string[];
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

    private getRequestTimeoutMs(): number {
        return vscode.workspace.getConfiguration('kimi').get<number>('request.timeoutMs', 120000);
    }

    private getRetryCount(): number {
        return vscode.workspace.getConfiguration('kimi').get<number>('request.retries', 1);
    }

    private getTemperature(): number {
        // Les modèles Kimi K2 (moonshot/kimi-k2-7-code) n'acceptent que temperature=1
        const provider = this.getProvider();
        const model = this.getModel(provider);
        
        if (model.toLowerCase().includes('kimi-k2') || model.toLowerCase().includes('moonshot')) {
            return 1;
        }
        
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

    private getDefaultFallbackModels(provider: LlmProvider, primaryModel: string): string[] {
        const defaults = provider === 'openrouter'
            ? ['moonshotai/kimi-k2.7-code', 'qwen/qwen-2.5-72b-instruct']
            : ['kimi-k2.7-code'];

        return defaults.filter((model) => model !== primaryModel);
    }

    private async sendOnce(
        provider: LlmProvider,
        model: string,
        messages: KimiMessage[],
        stream: boolean,
        timeoutMs: number
    ): Promise<KimiResponse> {
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

        const abortController = new AbortController();
        const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                signal: abortController.signal,
                body: JSON.stringify({
                    model,
                    messages,
                    temperature,
                    max_tokens: maxTokens,
                    stream
                })
            });

            if (!response.ok) {
                const body = await response.text();
                return {
                    text: '',
                    provider,
                    model,
                    statusCode: response.status,
                    error: `Erreur API : ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`
                };
            }

            if (stream) {
                return {
                    text: "⚠️ Le streaming n'est pas encore activé dans cette version.",
                    provider,
                    model,
                    statusCode: response.status
                };
            }

            const data: any = await response.json();
            const text = data?.choices?.[0]?.message?.content ?? '';

            return {
                text,
                provider,
                model,
                statusCode: response.status
            };
        } catch (err: any) {
            if (err?.name === 'AbortError') {
                return {
                    text: '',
                    provider,
                    model,
                    error: `Timeout API après ${timeoutMs} ms.`
                };
            }

            return {
                text: '',
                provider,
                model,
                error: `Erreur réseau : ${err.message}`
            };
        } finally {
            clearTimeout(timeoutHandle);
        }
    }

    private isRetryable(response: KimiResponse): boolean {
        if (!response.error) {
            return false;
        }

        if (response.statusCode === 429) {
            return true;
        }

        if (!response.statusCode) {
            return true;
        }

        return response.statusCode >= 500;
    }

    private isFatalAuthError(response: KimiResponse): boolean {
        return response.statusCode === 401 || response.statusCode === 403;
    }

    async sendMessages(
        messages: KimiMessage[],
        streamOrOptions: boolean | LlmSendOptions = false
    ): Promise<KimiResponse> {
        const options: LlmSendOptions = typeof streamOrOptions === 'boolean'
            ? { stream: streamOrOptions }
            : streamOrOptions;

        const provider = options.provider ?? this.getProvider();
        const primaryModel = options.model ?? this.getModel(provider);
        const timeoutMs = options.timeoutMs ?? this.getRequestTimeoutMs();
        const retries = Math.max(0, options.retries ?? this.getRetryCount());
        const stream = options.stream ?? false;
        const fallbackModels = options.fallbackModels ?? this.getDefaultFallbackModels(provider, primaryModel);
        const modelCandidates = [primaryModel, ...fallbackModels.filter((m) => m !== primaryModel)];

        let lastError: KimiResponse = {
            text: '',
            provider,
            model: primaryModel,
            error: 'Aucune tentative de requête n\'a été exécutée.'
        };

        for (const model of modelCandidates) {
            for (let attempt = 0; attempt <= retries; attempt += 1) {
                const response = await this.sendOnce(provider, model, messages, stream, timeoutMs);
                if (!response.error) {
                    return response;
                }

                lastError = response;

                if (this.isFatalAuthError(response)) {
                    return response;
                }

                if (!this.isRetryable(response)) {
                    break;
                }
            }
        }

        return lastError;
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
