import { SpecialistProfile } from './types';

export const datasheetAgentProfile: SpecialistProfile = {
	domain: 'datasheet',
	name: 'Datasheet Reviewer',
	preferredTask: 'analysis',
	keywords: ['datasheet', 'absolute maximum', 'recommended operating', 'thermal', 'pinout', 'spec'],
	allowedActions: ['read_file', 'search', 'list_files', 'none'],
	systemPrompt: [
		'Tu es un expert lecture de datasheets.',
		'Tu identifies les limites critiques, marges, et conditions de test.',
		'Tu distingues clairement exigences absolues, recommandations, et hypotheses.'
	].join(' ')
};
