import { Client } from './Client';

export { Client } from './Client';
export { FrameManager } from './FrameManager';
export { Queue } from './Queue';
export * from './types';

// --- Example Usage ---
const client = new Client({
	host: '127.0.0.1',
	port: 19132,
	offline: true,
	username: 'Bot',
	viewDistance: 10,
});

client.on('login', () => {
	client.logger.info('Login accepted by server!');
});

client.on('start_game', (data) => {
	client.logger.info(`Game started - Entity ID: ${data.runtimeEntityId}`);
});

client.on('spawn', () => {
	client.logger.info('Player spawned into the world!');
	client.setInitialized();
	client.chat('Hello from BedrockClient!');
});

client.on('text', (data) => {
	client.logger.info(`[Chat] <${data.source}> ${data.message}`);
});

client.on('kick', (reason) => {
	client.logger.warn(`Kicked: ${reason}`);
});

client.on('disconnect', (reason) => {
	client.logger.info(`Disconnected: ${reason}`);
	process.exit(0);
});

client.on('error', (error) => {
	client.logger.error('Client error:', error);
});

client.on('modal_form', (form) => {
	client.logger.info(`Form received: ${form.id}`);
	// Respond or close the form
	client.respondToForm(form.id, null);
});

client.connect().catch((err) => {
	client.logger.error('Failed to connect:', err);
	process.exit(1);
});
