import { LlmProvider } from './kimiClient';

export interface ModelCandidate {
    provider: LlmProvider;
    model: string;
}

export function applySingleProviderPolicy(
    stack: ModelCandidate[],
    configuredProvider: LlmProvider,
    singleProviderStrict: boolean
): ModelCandidate[] {
    if (!singleProviderStrict) {
        return stack;
    }

    return stack.filter((candidate) => candidate.provider === configuredProvider);
}
