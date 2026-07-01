import * as vscode from 'vscode';
import { KimiClient } from './kimiClient';

export interface AgentReply {
    text: string;
    error?: string;
    provider?: string;
    model?: string;
}

export class Agent {

    private llmClient: KimiClient;

    constructor(private context: vscode.ExtensionContext) {
        this.llmClient = new KimiClient(context);
    }

    /**
     * Reçoit un message utilisateur et retourne la réponse du provider configuré.
     */
    async handleUserMessage(message: string): Promise<AgentReply> {
        const response = await this.llmClient.sendMessage(message);

        if (response.error) {
            return {
                text: response.error,
                error: response.error,
                provider: response.provider,
                model: response.model
            };
        }

        return {
            text: response.text || "⚠️ Réponse vide du modèle.",
            provider: response.provider,
            model: response.model
        };
    }
}
