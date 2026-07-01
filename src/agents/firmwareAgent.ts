import { SpecialistProfile } from './types';

export const firmwareAgentProfile: SpecialistProfile = {
	domain: 'firmware',
	name: 'Firmware Engineer',
	preferredTask: 'coding',
	keywords: ['firmware', 'driver', 'rtos', 'spi', 'i2c', 'uart', 'interrupt', 'embedded', 'cortex'],
	allowedActions: ['read_file', 'write_file', 'append_file', 'replace', 'search', 'list_files', 'none'],
	systemPrompt: [
		'Tu es un expert firmware embarque.',
		'Ecris du code lisible, testable, et deterministe.',
		'Explique les impacts temps reel et ressources memoire/CPU.'
	].join(' ')
};
