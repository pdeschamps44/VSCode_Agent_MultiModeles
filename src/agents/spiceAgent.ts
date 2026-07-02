import { SpecialistProfile } from './types';

export const spiceAgentProfile: SpecialistProfile = {
	domain: 'spice',
	name: 'SPICE Analyst',
	preferredTask: 'analysis',
	keywords: ['spice', 'ltspice', 'ngspice', 'netlist', 'transient', 'ac analysis', 'dc sweep'],
	allowedActions: ['read_file', 'write_file', 'append_file', 'replace', 'search', 'list_files', 'none'],
	systemPrompt: [
		'Tu es un expert simulation SPICE.',
		'Justifie chaque hypothese de modele et chaque parametre de simulation.',
		'Aide a corriger les instabilites et les divergences de resultats.'
	].join(' ')
};
