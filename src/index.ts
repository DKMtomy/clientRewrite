export { Client } from './Client';
export { FrameManager } from './FrameManager';
export { Queue } from './Queue';
export { handleGamePacket, decodeGamePackets, readPacketId } from './handlers';
export * from './types';

import { Client } from './Client';
import type { ClientOptions } from './types';

/**
 * Creates a new Bedrock client and connects it to the server.
 * This is the easiest way to get started.
 *
 * @example
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
 */
export async function createClient(options: ClientOptions): Promise<Client> {
	const client = new Client(options);
	await client.connect();
	return client;
}

// ============================================================================
//  EXAMPLES — Run with: npm run dev
// ============================================================================

// --------------------------------------------------
// Example 1: Basic bot that joins and chats
// --------------------------------------------------
async function basicBot() {
	const client = new Client({
		host: '127.0.0.1',
		port: 19132,
		offline: true,
		username: 'Bot',
		viewDistance: 10,
	});

	client.on('spawn', () => {
		client.logger.info('Spawned! Sending hello message...');
		client.setInitialized();
		client.chat('Hello from BedrockClient!');
	});

	client.on('text', (data) => {
		client.logger.info(`[Chat] <${data.source}> ${data.message}`);

		// Echo bot: reply to messages
		if (data.source !== client.profile.name && data.message.startsWith('!echo ')) {
			client.chat(data.message.slice(6));
		}
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

	await client.connect();
}

// --------------------------------------------------
// Example 2: Log ALL packet IDs and names
// --------------------------------------------------
async function packetLogger() {
	const client = new Client({
		host: '127.0.0.1',
		port: 19132,
		offline: true,
		username: 'PacketSniffer',
	});

	// Enable built-in packet logging (logs every packet with ID, name, and size)
	const stopLogging = client.enablePacketLogging();
	// Call stopLogging() later to disable

	client.on('spawn', () => {
		client.setInitialized();
		client.logger.info('=== Now logging all packets ===');

		// Stop logging after 30 seconds
		setTimeout(() => {
			stopLogging();
			client.logger.info('=== Packet logging stopped ===');
		}, 30_000);
	});

	await client.connect();
}

// --------------------------------------------------
// Example 3: Custom packet capture with filtering
// --------------------------------------------------
async function packetCapture() {
	const client = new Client({
		host: '127.0.0.1',
		port: 19132,
		offline: true,
		username: 'Watcher',
	});

	// Listen to the raw 'packet' event — every game packet triggers this
	client.on('packet', (pkt) => {
		// pkt.id   = numeric packet ID (e.g. 9)
		// pkt.name = human-readable name (e.g. "Text")
		// pkt.buffer = raw packet buffer
		console.log(`[PACKET] ${pkt.name} (0x${pkt.id.toString(16)}) — ${pkt.buffer.length} bytes`);
	});

	// Or filter for specific packets using onPacket() — by name or ID:

	// By name:
	const offText = client.onPacket('Text', (pkt) => {
		console.log(`Text packet received! ${pkt.buffer.length} bytes`);
	});

	// By ID (MovePlayer = 19 = 0x13):
	const offMove = client.onPacket(19, (pkt) => {
		console.log(`MovePlayer packet! ${pkt.buffer.length} bytes`);
	});

	// waitForPacket() — waits for ONE specific packet, with optional timeout:
	client.on('spawn', async () => {
		client.setInitialized();

		// Wait for a Text packet within 60 seconds
		try {
			const textPkt = await client.waitForPacket('Text', 60_000);
			console.log(`Got first Text packet after spawn! ID=${textPkt.id}`);
		} catch (e) {
			console.log('No Text packet received within timeout');
		}

		// Clean up specific listeners when done
		offText();
		offMove();
	});

	await client.connect();
}

// --------------------------------------------------
// Example 4: Packet counter / stats
// --------------------------------------------------
async function packetStats() {
	const client = new Client({
		host: '127.0.0.1',
		port: 19132,
		offline: true,
		username: 'Stats',
	});

	const packetCounts = new Map<string, number>();

	client.on('packet', (pkt) => {
		packetCounts.set(pkt.name, (packetCounts.get(pkt.name) ?? 0) + 1);
	});

	client.on('spawn', () => {
		client.setInitialized();

		// Print packet stats every 10 seconds
		setInterval(() => {
			console.log('\n=== Packet Stats ===');
			const sorted = [...packetCounts.entries()].sort((a, b) => b[1] - a[1]);
			for (const [name, count] of sorted) {
				console.log(`  ${name}: ${count}`);
			}
			console.log(`  TOTAL: ${sorted.reduce((sum, [, c]) => sum + c, 0)}`);
		}, 10_000);
	});

	await client.connect();
}

// --------------------------------------------------
// Example 5: Using getPacketName() for manual lookup
// --------------------------------------------------
function packetNameLookup() {
	const { getPacketName, PACKET_NAMES } = require('./types');

	// Look up a single ID
	console.log(getPacketName(9)); // "Text"
	console.log(getPacketName(11)); // "StartGame"
	console.log(getPacketName(999)); // "Unknown(0x3e7)"

	// Print all known packets
	console.log('\nAll known packets:');
	for (const [id, name] of Object.entries(PACKET_NAMES)) {
		console.log(`  0x${Number(id).toString(16).padStart(2, '0')} (${id}) = ${name}`);
	}
}

// --------------------------------------------------
// Run one of the examples:
// --------------------------------------------------
basicBot();

// Uncomment any of these to try different examples:
// packetLogger();
// packetCapture();
// packetStats();
// packetNameLookup();
