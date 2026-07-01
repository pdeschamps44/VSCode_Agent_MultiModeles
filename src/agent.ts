import * as vscode from 'vscode';
import { KimiClient, KimiMessage, KimiResponse, LlmProvider } from './kimiClient';
import { SpecialistProfile, AgentDomain } from './agents/types';
import { hardwareAgentProfile } from './agents/hardwareAgent';
import { firmwareAgentProfile } from './agents/firmwareAgent';
import { pcbAgentProfile } from './agents/pcbAgent';
import { spiceAgentProfile } from './agents/spiceAgent';
import { signalsAgentProfile } from './agents/signalsAgent';
import { datasheetAgentProfile } from './agents/datasheetAgent';
import { AgentLogger } from './logging';
import { appendTextFile, readTextFile, replaceInFile, writeTextFile } from './actions/fileActions';
import { listProjectFiles } from './actions/projectActions';
import { searchInWorkspace } from './actions/searchActions';

export interface AgentReply {
    text: string;
    error?: string;
    provider?: string;
    model?: string;
    domain?: AgentDomain;
    iterations?: number;
}

type AgentTaskType = 'analysis' | 'coding';

interface ModelCandidate {
    provider: LlmProvider;
    model: string;
}

interface PlannedAction {
    type: 'read_file' | 'write_file' | 'append_file' | 'search' | 'replace' | 'list_files' | 'none';
    args?: Record<string, unknown>;
}

interface PlannerTurn {
    plan?: string;
    action?: PlannedAction;
    finalAnswer?: string;
}

const VALID_ACTION_TYPES: PlannedAction['type'][] = [
    'read_file',
    'write_file',
    'append_file',
    'search',
    'replace',
    'list_files',
    'none'
];

export class Agent {

    private llmClient: KimiClient;
    private logger: AgentLogger;
    private profiles: SpecialistProfile[] = [
        hardwareAgentProfile,
        firmwareAgentProfile,
        pcbAgentProfile,
        spiceAgentProfile,
        signalsAgentProfile,
        datasheetAgentProfile
    ];

    constructor(private context: vscode.ExtensionContext) {
        this.llmClient = new KimiClient(context);
        this.logger = new AgentLogger();
    }

    private getMaxIterations(): number {
        return vscode.workspace.getConfiguration('kimi').get<number>('agent.maxIterations', 4);
    }

    private detectTaskType(message: string): AgentTaskType {
        const codingHints = ['code', 'fichier', 'file', 'refactor', 'modifie', 'genere', 'generate', 'write'];
        const lower = message.toLowerCase();
        return codingHints.some((hint) => lower.includes(hint)) ? 'coding' : 'analysis';
    }

    private pickProfile(message: string): SpecialistProfile {
        const lower = message.toLowerCase();
        let winner: SpecialistProfile | undefined;
        let score = -1;

        for (const profile of this.profiles) {
            const localScore = profile.keywords.reduce((acc, keyword) => {
                return lower.includes(keyword.toLowerCase()) ? acc + 1 : acc;
            }, 0);

            if (localScore > score) {
                score = localScore;
                winner = profile;
            }
        }

        if (winner) {
            return winner;
        }

        return {
            domain: 'general',
            name: 'General Engineer',
            preferredTask: 'analysis',
            keywords: [],
            allowedActions: ['read_file', 'search', 'list_files', 'none'],
            systemPrompt: 'Tu es un assistant d\'ingenierie hardware/firmware pragmatique et rigoureux.'
        };
    }

    private selectModelStack(taskType: AgentTaskType, domain: AgentDomain): ModelCandidate[] {
        if (taskType === 'coding') {
            return [
                { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
                { provider: 'moonshot', model: 'kimi-k2.7-code' },
                { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' }
            ];
        }

        if (domain === 'signals' || domain === 'spice') {
            return [
                { provider: 'moonshot', model: 'kimi-k2.7-code' },
                { provider: 'openrouter', model: 'qwen/qwen-2.5-72b-instruct' },
                { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' }
            ];
        }

        return [
            { provider: 'moonshot', model: 'kimi-k2.7-code' },
            { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' },
            { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }
        ];
    }

    private async requestWithStack(messages: KimiMessage[], stack: ModelCandidate[]): Promise<KimiResponse> {
        let last: KimiResponse = {
            text: '',
            error: 'Aucun modele disponible dans la stack.'
        };

        for (const candidate of stack) {
            this.logger.decision('model-attempt', `${candidate.provider}/${candidate.model}`);
            const response = await this.llmClient.sendMessages(messages, {
                provider: candidate.provider,
                model: candidate.model,
                retries: 1,
                timeoutMs: vscode.workspace.getConfiguration('kimi').get<number>('request.timeoutMs', 45000),
                fallbackModels: []
            });

            if (!response.error) {
                return response;
            }

            this.logger.warn(`Echec modele ${candidate.provider}/${candidate.model}: ${response.error}`);
            last = response;
        }

        return last;
    }

    private safeJsonParse(text: string): PlannerTurn | undefined {
        const parseAttempts: string[] = [];
        const trimmed = text.trim();
        if (trimmed) {
            parseAttempts.push(trimmed);
        }

        const fencedMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
        if (fencedMatch?.[1]) {
            parseAttempts.push(fencedMatch[1].trim());
        }

        const balanced = this.extractFirstBalancedJsonObject(text);
        if (balanced) {
            parseAttempts.push(balanced);
        }

        for (const candidate of parseAttempts) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(candidate);
            } catch {
                continue;
            }

            const validation = this.validatePlannerTurn(parsed);
            if (validation.ok) {
                return validation.turn;
            }
        }

        return undefined;
    }

    private extractFirstBalancedJsonObject(text: string): string | undefined {
        let start = -1;
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let idx = 0; idx < text.length; idx += 1) {
            const char = text[idx];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }

            if (char === '"') {
                inString = true;
                continue;
            }

            if (char === '{') {
                if (depth === 0) {
                    start = idx;
                }
                depth += 1;
                continue;
            }

            if (char === '}') {
                if (depth === 0) {
                    continue;
                }

                depth -= 1;
                if (depth === 0 && start >= 0) {
                    return text.slice(start, idx + 1);
                }
            }
        }

        return undefined;
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private validatePlannerTurn(parsed: unknown): { ok: true; turn: PlannerTurn } | { ok: false; reason: string } {
        if (!this.isRecord(parsed)) {
            return { ok: false, reason: 'Le planner JSON doit etre un objet.' };
        }

        const plan = parsed.plan;
        const finalAnswer = parsed.finalAnswer;
        const actionCandidate = parsed.action;

        if (plan !== undefined && typeof plan !== 'string') {
            return { ok: false, reason: 'Le champ plan doit etre une string.' };
        }

        if (finalAnswer !== undefined && typeof finalAnswer !== 'string') {
            return { ok: false, reason: 'Le champ finalAnswer doit etre une string.' };
        }

        let action: PlannedAction | undefined;
        if (actionCandidate !== undefined) {
            if (!this.isRecord(actionCandidate)) {
                return { ok: false, reason: 'Le champ action doit etre un objet.' };
            }

            const actionType = actionCandidate.type;
            if (typeof actionType !== 'string' || !VALID_ACTION_TYPES.includes(actionType as PlannedAction['type'])) {
                return { ok: false, reason: `Type d'action invalide: ${String(actionType)}.` };
            }

            const actionArgs = actionCandidate.args;
            if (actionArgs !== undefined && !this.isRecord(actionArgs)) {
                return { ok: false, reason: 'Le champ action.args doit etre un objet.' };
            }

            action = {
                type: actionType as PlannedAction['type'],
                args: actionArgs as Record<string, unknown> | undefined
            };
        }

        return {
            ok: true,
            turn: {
                plan,
                finalAnswer,
                action
            }
        };
    }

    private stringifyResult(payload: unknown): string {
        try {
            return JSON.stringify(payload).slice(0, 3000);
        } catch {
            return String(payload);
        }
    }

    private getRequiredStringArg(args: Record<string, unknown>, key: string): string {
        const value = args[key];
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error(`Argument requis invalide: ${key}`);
        }

        return value.trim();
    }

    private async executeAction(action: PlannedAction, allowedActions: SpecialistProfile['allowedActions']): Promise<string> {
        if (!allowedActions.includes(action.type)) {
            throw new Error(`Action non autorisee pour ce sous-agent: ${action.type}`);
        }

        const args = action.args ?? {};

        switch (action.type) {
            case 'read_file': {
                const path = this.getRequiredStringArg(args, 'path');
                const file = await readTextFile(path);
                return this.stringifyResult({ path: file.path, content: file.content.slice(0, 5000) });
            }
            case 'write_file': {
                const path = this.getRequiredStringArg(args, 'path');
                const content = this.getRequiredStringArg(args, 'content');
                const result = await writeTextFile(path, content);
                return this.stringifyResult(result);
            }
            case 'append_file': {
                const path = this.getRequiredStringArg(args, 'path');
                const content = this.getRequiredStringArg(args, 'content');
                const result = await appendTextFile(path, content);
                return this.stringifyResult(result);
            }
            case 'replace': {
                const path = this.getRequiredStringArg(args, 'path');
                const search = this.getRequiredStringArg(args, 'search');
                const replacement = this.getRequiredStringArg(args, 'replacement');
                const result = await replaceInFile(path, search, replacement);
                return this.stringifyResult(result);
            }
            case 'search': {
                const query = this.getRequiredStringArg(args, 'query');
                const includeGlob = String(args.includeGlob ?? '**/*.{ts,tsx,js,jsx,json,md}');
                const maxResults = Math.min(100, Math.max(1, Number(args.maxResults ?? 20)));
                const result = await searchInWorkspace(query, includeGlob, maxResults);
                return this.stringifyResult(result);
            }
            case 'list_files': {
                const glob = String(args.glob ?? '**/*');
                const maxResults = Math.min(1000, Math.max(1, Number(args.maxResults ?? 200)));
                const files = await listProjectFiles(glob, maxResults);
                return this.stringifyResult(files);
            }
            case 'none':
            default:
                return 'No action executed.';
        }
    }

    /**
     * Reçoit un message utilisateur et retourne la réponse du provider configuré.
     */
    async handleUserMessage(message: string): Promise<AgentReply> {
        const taskType = this.detectTaskType(message);
        const profile = this.pickProfile(message);
        const stack = this.selectModelStack(taskType, profile.domain);
        const maxIterations = Math.max(1, this.getMaxIterations());

        this.logger.decision('task-type', taskType);
        this.logger.decision('specialist', `${profile.domain} (${profile.name})`);
        this.logger.decision('iteration-limit', String(maxIterations));

        const messages: KimiMessage[] = [
            {
                role: 'system',
                content: [
                    `Tu agis comme sous-agent specialise: ${profile.name}.`,
                    profile.systemPrompt,
                    `Actions autorisees: ${profile.allowedActions.join(', ')}.`,
                    'Reponds STRICTEMENT en JSON avec ce schema:',
                    '{"plan":"string","action":{"type":"read_file|write_file|append_file|search|replace|list_files|none","args":{}},"finalAnswer":"string"}',
                    'Si tu n\'as plus besoin d\'action, mets action.type="none" et remplis finalAnswer.'
                ].join('\n')
            },
            {
                role: 'user',
                content: `Demande utilisateur: ${message}`
            }
        ];

        let lastProvider = '';
        let lastModel = '';
        let lastText = '';

        for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
            this.logger.info(`Iteration ${iteration}/${maxIterations}`);

            const response = await this.requestWithStack(messages, stack);
            lastProvider = response.provider ?? lastProvider;
            lastModel = response.model ?? lastModel;
            lastText = response.text;

            if (response.error) {
                return {
                    text: response.error,
                    error: response.error,
                    provider: response.provider,
                    model: response.model,
                    domain: profile.domain,
                    iterations: iteration
                };
            }

            const planner = this.safeJsonParse(response.text);
            if (!planner) {
                const parseError = 'Reponse non conforme au schema JSON attendu.';
                this.logger.warn(parseError);
                messages.push({ role: 'assistant', content: response.text });

                if (iteration >= maxIterations) {
                    return {
                        text: `${parseError} Boucle interrompue apres ${iteration} iterations.`,
                        error: parseError,
                        provider: response.provider,
                        model: response.model,
                        domain: profile.domain,
                        iterations: iteration
                    };
                }

                messages.push({
                    role: 'user',
                    content: 'Ta reponse n\'est pas un JSON valide au schema requis. Reponds uniquement avec un JSON strict conforme au schema fourni.'
                });
                continue;
            }

            if (planner.plan) {
                this.logger.decision('plan', planner.plan);
            }

            const action = planner.action ?? { type: 'none' as const, args: {} };
            if (action.type === 'none' && planner.finalAnswer?.trim()) {
                return {
                    text: planner.finalAnswer,
                    provider: response.provider,
                    model: response.model,
                    domain: profile.domain,
                    iterations: iteration
                };
            }

            if (action.type === 'none' && !planner.finalAnswer?.trim()) {
                const noOpError = 'Action none sans finalAnswer valide: boucle interrompue pour eviter une no-op loop.';
                this.logger.warn(noOpError);
                return {
                    text: noOpError,
                    error: noOpError,
                    provider: response.provider,
                    model: response.model,
                    domain: profile.domain,
                    iterations: iteration
                };
            }

            try {
                this.logger.action(action.type, this.stringifyResult(action.args ?? {}));
                const observation = await this.executeAction(action, profile.allowedActions);
                messages.push({ role: 'assistant', content: response.text });
                messages.push({
                    role: 'user',
                    content: `Observation action ${action.type}: ${observation}\nContinue en JSON strict.`
                });
            } catch (err: any) {
                const observation = `Erreur action ${action.type}: ${err.message}`;
                this.logger.error(observation);
                messages.push({ role: 'assistant', content: response.text });
                messages.push({
                    role: 'user',
                    content: `${observation}\nCorrige le plan et continue en JSON strict.`
                });
            }
        }

        return {
            text: lastText || 'Boucle agentique terminee sans reponse finale exploitable.',
            provider: lastProvider,
            model: lastModel,
            domain: profile.domain,
            iterations: maxIterations
        };
    }
}
