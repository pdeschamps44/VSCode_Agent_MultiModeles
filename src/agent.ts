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
import {
    appendTextFile,
    readTextFile,
    replaceInFile,
    simulateAppendTextFile,
    simulateReplaceInFile,
    simulateWriteTextFile,
    SimulatedMutationResult,
    writeTextFile
} from './actions/fileActions';
import { listProjectFiles } from './actions/projectActions';
import { searchInWorkspace } from './actions/searchActions';
import { applySingleProviderPolicy, ModelCandidate } from './modelPolicy';

export interface AgentReply {
    text: string;
    error?: string;
    provider?: string;
    model?: string;
    domain?: AgentDomain;
    iterations?: number;
    dryRun?: boolean;
}

type AgentTaskType = 'analysis' | 'coding';
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

    private getSingleProviderStrict(): boolean {
        return vscode.workspace.getConfiguration('kimi').get<boolean>('security.singleProviderStrict', true);
    }

    private getConfiguredProvider(): LlmProvider {
        const configured = vscode.workspace.getConfiguration('kimi').get<string>('provider', 'moonshot');
        if (configured === 'openrouter' || configured === 'moonshot') {
            return configured;
        }

        this.logger.warn(`Provider configure invalide: ${String(configured)}. Fallback sur moonshot.`);
        return 'moonshot';
    }

    private getDryRunEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('kimi');
        const explicitDryRun = config.get<boolean>('agent.dryRun');
        if (explicitDryRun !== undefined) {
            return explicitDryRun;
        }

        const legacyPreview = config.get<boolean>('agent.dryRunPreview');
        if (legacyPreview !== undefined) {
            this.logger.warn('Configuration legacy kimi.agent.dryRunPreview detectee. Utilisez kimi.agent.dryRun.');
            return legacyPreview;
        }

        return true;
    }

    private logSimulation(result: SimulatedMutationResult): void {
        this.logger.action('dry-run', `${result.action} ${result.path} | ${result.diffSummary}`);
        this.logger.decision('dry-run-diff', result.diffLog);
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
                timeoutMs: vscode.workspace.getConfiguration('kimi').get<number>('request.timeoutMs', 120000),
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

    private async executeAction(
        action: PlannedAction,
        allowedActions: SpecialistProfile['allowedActions'],
        dryRunEnabled: boolean
    ): Promise<string> {
        if (!allowedActions.includes(action.type)) {
            throw new Error(`Action non autorisee pour ce sous-agent: ${action.type}`);
        }

        const args = action.args ?? {};

        switch (action.type) {
            case 'read_file': {
                const path = this.getRequiredStringArg(args, 'path');
                const offset = Number(args.offset ?? 0);
                const limit = Number(args.limit ?? 15000);
                
                const file = await readTextFile(path, offset > 0 ? offset : undefined, limit > 0 ? limit : undefined);
                return this.stringifyResult({ path: file.path, content: file.content });
            }
            case 'write_file': {
                const path = this.getRequiredStringArg(args, 'path');
                const content = this.getRequiredStringArg(args, 'content');

                if (dryRunEnabled) {
                    const simulation = await simulateWriteTextFile(path, content);
                    this.logSimulation(simulation);
                    return this.stringifyResult(simulation);
                }

                const result = await writeTextFile(path, content);
                return this.stringifyResult(result);
            }
            case 'append_file': {
                const path = this.getRequiredStringArg(args, 'path');
                const content = this.getRequiredStringArg(args, 'content');

                if (dryRunEnabled) {
                    const simulation = await simulateAppendTextFile(path, content);
                    this.logSimulation(simulation);
                    return this.stringifyResult(simulation);
                }

                const result = await appendTextFile(path, content);
                return this.stringifyResult(result);
            }
            case 'replace': {
                const path = this.getRequiredStringArg(args, 'path');
                const search = this.getRequiredStringArg(args, 'search');
                const replacement = this.getRequiredStringArg(args, 'replacement');

                if (dryRunEnabled) {
                    const simulation = await simulateReplaceInFile(path, search, replacement);
                    this.logSimulation(simulation);
                    return this.stringifyResult(simulation);
                }

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
        const singleProviderStrict = this.getSingleProviderStrict();
        const configuredProvider = this.getConfiguredProvider();
        const effectiveStack = applySingleProviderPolicy(stack, configuredProvider, singleProviderStrict);
        const dryRunEnabled = this.getDryRunEnabled();
        const maxIterations = Math.max(1, this.getMaxIterations());

        this.logger.decision('task-type', taskType);
        this.logger.decision('specialist', `${profile.domain} (${profile.name})`);
        this.logger.decision('single-provider-strict', String(singleProviderStrict));
        this.logger.decision('configured-provider', configuredProvider);
        this.logger.decision('dry-run', String(dryRunEnabled));
        this.logger.decision('stack-size-before-filter', String(stack.length));
        this.logger.decision('stack-size-after-filter', String(effectiveStack.length));
        this.logger.decision('iteration-limit', String(maxIterations));

        if (effectiveStack.length === 0) {
            const policyError = [
                'Aucun modele disponible apres application de la politique single-provider strict.',
                `provider=${configuredProvider}`,
                `task=${taskType}`,
                `domain=${profile.domain}`,
                'Ajustez kimi.provider ou desactivez kimi.security.singleProviderStrict.'
            ].join(' ');

            this.logger.error(policyError);
            return {
                text: policyError,
                error: policyError,
                provider: configuredProvider,
                domain: profile.domain,
                iterations: 0,
                dryRun: dryRunEnabled
            };
        }

        const messages: KimiMessage[] = [
            {
                role: 'system',
                content: [
                    `Tu agis comme sous-agent specialise: ${profile.name}.`,
                    profile.systemPrompt,
                    `Actions autorisees: ${profile.allowedActions.join(', ')}.`,
                    '',
                    '🎯 PRIORITES:',
                    '1. LIMITE les list_files/read_file a des patterns specifiques (ex: "*.pcb", "*.sch", dossier "firmware/") - NE lis pas recursif tout le projet.',
                    '2. ANALYSE d\'abord (read, search) avant toute ECRITURE (write_file, append_file, replace).',
                    '3. Chaque iteration: une action ciblée max. Pas de list_files suivi immediatement d\'une autre list_files.',
                    `4. ${maxIterations > 15 ? 'Tu as suffisamment d\'iterations pour une analyse approfondie: sois methodique.' : 'Tu as peu d\'iterations: sois tres selectif et cible les fichiers cles.'}`,
                    '',
                    '⚠️ ACCES AUX FICHIERS:',
                    '- ❌ Tu n\'as AUCUN acces a un terminal ou des commandes shell. Les appels shell seront bloques.',
                    '- ✅ Tu dois OBLIGATOIREMENT utiliser l\'action read_file pour explorer les fichiers.',
                    '- ✅ Pour les fichiers volumineux, utilise les parametres offset et limit:',
                    '  Exemple: {"type":"read_file","args":{"path":"models.py","offset":5000,"limit":10000}}',
                    '  Cela lira 10000 caracteres a partir du caractere 5000. Augmente offset pour explorer suite.',
                    '',
                    '⚠️ REGLES STRICTES SUR LES ECRITURES:',
                    '- Tu ne dois JAMAIS affirmer qu\'un fichier a ete "cree", "modifie", "genere" ou "ecrit" sans avoir EXPLICITEMENT execute write_file/append_file/replace.',
                    '- Avant de conclure (action.type="none"), tu DOIS avoir execute toutes les ecritures necessaires et recu leurs observations.',
                    '- La sequence OBLIGATOIRE est: PLAN → ACTION (write_file) → OBSERVATION (confirmation d\'ecriture) → CONCLUSION dans finalAnswer.',
                    '- Si tu n\'as pas execute l\'action, tu dois le faire a l\'iteration suivante. Ne simule JAMAIS une action.',
                    '',
                    'Reponds STRICTEMENT en JSON avec ce schema:',
                    '{"plan":"string (justifie ta strategie)","action":{"type":"read_file|write_file|append_file|search|replace|list_files|none","args":{}},"finalAnswer":"string"}',
                    'Si tu n\'as plus besoin d\'action (toutes les ecritures sont CONFIRMEES), mets action.type="none" et remplis finalAnswer avec tes conclusions.'
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

            const response = await this.requestWithStack(messages, effectiveStack);
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
                    iterations: iteration,
                    dryRun: dryRunEnabled
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
                        iterations: iteration,
                        dryRun: dryRunEnabled
                    };
                }

                messages.push({
                    role: 'user',
                    content: 'ERREUR: Ta reponse n\'est pas un JSON strict conforme au schema. Assure-toi que:\n1. Ton reponse commence par { et finit par }\n2. Les champs plan, action, finalAnswer sont tous presents\n3. action.type est l\'une de: read_file|write_file|append_file|search|replace|list_files|none\n4. Tu reponds UNIQUEMENT avec du JSON, rien d\'autre.\nReponds maintenant uniquement avec du JSON strict.'
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
                    iterations: iteration,
                    dryRun: dryRunEnabled
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
                    iterations: iteration,
                    dryRun: dryRunEnabled
                };
            }

            try {
                this.logger.action(action.type, this.stringifyResult(action.args ?? {}));
                const observation = await this.executeAction(action, profile.allowedActions, dryRunEnabled);
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
            iterations: maxIterations,
            dryRun: dryRunEnabled
        };
    }
}
