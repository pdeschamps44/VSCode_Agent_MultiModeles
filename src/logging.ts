import * as vscode from 'vscode';

export class AgentLogger {
    private readonly output: vscode.OutputChannel;
    private hasShown: boolean = false;

    constructor() {
        this.output = vscode.window.createOutputChannel('Kimi Hardware Agent');
        // Afficher le canal dès sa création pour que les logs soient visibles
        this.output.show(true);
        this.hasShown = true;
    }

    info(message: string): void {
        this.write('INFO', message);
    }

    warn(message: string): void {
        this.write('WARN', message);
    }

    error(message: string): void {
        this.write('ERROR', message);
    }

    decision(topic: string, payload: string): void {
        this.write('DECISION', `${topic}: ${payload}`);
    }

    action(action: string, payload: string): void {
        this.write('ACTION', `${action}: ${payload}`);
    }

    private write(level: string, message: string): void {
        const ts = new Date().toISOString();
        this.output.appendLine(`[${ts}] [${level}] ${message}`);
    }
}
