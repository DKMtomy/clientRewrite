// ==================== Core ====================
export { Client } from './Client';
export { FrameManager } from './FrameManager';
export { Queue } from './Queue';
export { handleGamePacket, decodeGamePackets, readPacketId } from './handlers';

// ==================== Auth ====================
export { authenticate, generateKeyPair, buildSkinData, generateSkinImage } from './auth';
export type { AuthResult, KeyPair } from './auth';

// ==================== World ====================
export { EntityTracker, PlayerState } from './world';
export type { TrackedEntity, AttributeValue } from './world';

// ==================== Types ====================
export * from './types';

// ==================== Factory ====================
import { Client } from './Client';
import type { ClientOptions } from './types';

/**
 * Creates a new Bedrock client and connects to the server.
 * The easiest way to get started.
 *
 * @example
 * ```ts
 * import { createClient } from 'bedrock-client';
 *
 * const client = await createClient({
 *   host: '127.0.0.1',
 *   port: 19132,
 *   offline: true,
 *   username: 'Bot',
 * });
 *
 * client.on('spawn', () => {
 *   client.chat('Hello world!');
 * });
 * ```
 */
export async function createClient(options: ClientOptions): Promise<Client> {
	const client = new Client(options);
	await client.connect();
	return client;
}

// ============================================================================
//  EXAMPLES
// ============================================================================

// --------------------------------------------------
// Example 1: Basic bot that joins, chats, and tracks health
// --------------------------------------------------
async function basicBot() {
	const client = new Client({
		host: '127.0.0.1',
		port: 19132,
		offline: true,
		username: 'Bot',
		viewDistance: 10,
		autoReconnect: true, // auto-reconnect on disconnect
	});

	client.on('spawn', () => {
		client.setInitialized();
		client.chat('Hello from BedrockClient!');

		// Health/hunger are auto-tracked
		client.logger.info(`Health: ${client.state.health}/${client.state.maxHealth}`);
		client.logger.info(`Hunger: ${client.state.hunger}`);
	});

	client.on('text', (data) => {
		client.logger.info(`[Chat] <${data.source}> ${data.message}`);
		if (data.source !== client.profile.name && data.message.startsWith('!echo ')) {
			client.chat(data.message.slice(6));
		}
	});

	// Health changes are auto-tracked via UpdateAttributes
	client.on('update_attributes', () => {
		if (!client.state.isAlive) {
			client.logger.warn('Player died!');
		}
	});

	client.on('kick', (reason) => client.logger.warn(`Kicked: ${reason}`));
	client.on('disconnect', (reason) => client.logger.info(`Disconnected: ${reason}`));
	client.on('reconnect', (attempt) => client.logger.info(`Reconnected (attempt ${attempt})`));

	await client.connect();
}

// --------------------------------------------------
// Example 2: Entity tracker
// --------------------------------------------------
async function entityTracker() {
	const client = await createClient({
		host: '127.0.0.1',
		port: 19132,
		offline: true,
		username: 'EntityWatcher',
	});

	client.on('spawn', () => {
		client.setInitialized();

		// Print entity stats every 10 seconds
		setInterval(() => {
			const players = client.entities.getPlayers();
			client.logger.info(`Tracking ${client.entities.count} entities (${players.length} players)`);

			for (const player of players) {
				client.logger.info(`  Player: ${player.username} at (${player.position.x.toFixed(1)}, ${player.position.y.toFixed(1)}, ${player.position.z.toFixed(1)})`);
			}

			// Find nearest entity
			if (client.playerData) {
				const nearest = client.entities.nearest(client.playerData.position);
				if (nearest) {
					client.logger.info(`  Nearest: ${nearest.type} (runtime=${nearest.runtimeId})`);
				}
			}
		}, 10_000);
	});
}

// --------------------------------------------------
// Example 3: Packet logger with stats
// --------------------------------------------------
async function packetLogger() {
	const client = new Client({
		host: '127.0.0.1',
		port: 19132,
		offline: true,
		username: 'PacketSniffer',
	});

	const stopLogging = client.enablePacketLogging();
	const packetCounts = new Map<string, number>();

	client.on('packet', (pkt) => {
		packetCounts.set(pkt.name, (packetCounts.get(pkt.name) ?? 0) + 1);
	});

	client.on('spawn', () => {
		client.setInitialized();

		// Print stats every 10 seconds
		setInterval(() => {
			const sorted = [...packetCounts.entries()].sort((a, b) => b[1] - a[1]);
			console.log('\n=== Packet Stats ===');
			for (const [name, count] of sorted.slice(0, 10)) {
				console.log(`  ${name}: ${count}`);
			}
		}, 10_000);

		// Stop logging after 30 seconds
		setTimeout(() => {
			stopLogging();
			console.log('=== Logging stopped ===');
		}, 30_000);
	});

	await client.connect();
}

// --------------------------------------------------
// Run one of the examples:
// --------------------------------------------------
basicBot();
// entityTracker();
// packetLogger();
