export type AgentDomain = 'hardware' | 'firmware' | 'pcb' | 'spice' | 'signals' | 'datasheet' | 'general';

export interface SpecialistProfile {
    domain: AgentDomain;
    name: string;
    systemPrompt: string;
    keywords: string[];
    preferredTask: 'analysis' | 'coding';
    allowedActions: Array<'read_file' | 'write_file' | 'append_file' | 'search' | 'replace' | 'list_files' | 'none'>;
}
