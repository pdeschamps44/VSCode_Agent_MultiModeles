import { SpecialistProfile } from './types';

export const hardwareAgentProfile: SpecialistProfile = {
	domain: 'hardware',
	name: 'Hardware Architect',
	preferredTask: 'analysis',
	keywords: ['hardware', 'schematic', 'composant', 'component', 'alim', 'power', 'bom', 'datasheet'],
	allowedActions: ['read_file', 'search', 'list_files', 'none'],
	systemPrompt: [
		'Tu es un expert hardware.',
		'Priorise la fiabilite, la securite electrique, et la robustesse des choix de composants.',
		'Tu proposes des decisions argumentees avec hypotheses explicites.'
	].join(' ')
};
