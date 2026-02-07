import { FrameManager } from '../FrameManager';
import {
	Address,
	OpenConnectionRequest1,
	OpenConnectionRequest2,
	Packet,
	Reliability,
	Frame,
	Priority,
	ConnectionRequest,
	Ack,
	Nack,
} from '@serenityjs/raknet';
import { createSocket, RemoteInfo, Socket } from 'dgram';
import { Buffer } from 'buffer';
import { Logger, LoggerColors } from '@serenityjs/logger';
import { Queue } from '../Queue/Queue';
import EventEmitter from 'events';
import {
	CompressionMethod,
	DataPacket,
	Framer,
	LoginPacket,
	RequestNetworkSettingsPacket,
	TextPacket,
	CommandRequestPacket,
	SetLocalPlayerAsInitializedPacket,
	ModalFormResponsePacket,
	PlayerAuthInputPacket,
	PlayerActionPacket,
	RespawnPacket,
	Vector3f,
	Vector2f,
	BlockCoordinates,
	ActionIds,
	RespawnState,
} from '@serenityjs/protocol';
import { deflateRawSync } from 'zlib';

import {
	ClientOptions,
	ClientStatus,
	PlayerProfile,
	PlayerData,
	GAME_BYTE,
	RAKNET_MAGIC,
	DEFAULT_PROTOCOL_VERSION,
	DEFAULT_GAME_VERSION,
	DEFAULT_VIEW_DISTANCE,
	TICK_MS,
	getPacketName,
	PACKET_NAMES,
} from '@/types';
import { authenticate, generateKeyPair } from '@/auth';
import type { AuthResult, KeyPair } from '@/auth';
import { EntityTracker } from '@/world/EntityTracker';
import { PlayerState } from '@/world/PlayerState';

class Client extends EventEmitter {
	// --- Connection ---
	readonly socket: Socket;
	readonly ip: string;
	readonly port: number;
	readonly GUID: bigint;
	readonly frameManager: FrameManager;
	public queue: Queue;
	readonly logger: Logger = new Logger('BedrockClient', LoggerColors.MagentaBright);

	// --- Options ---
	public readonly options: Required<
		Pick<ClientOptions, 'host' | 'port' | 'viewDistance' | 'protocolVersion' | 'gameVersion' | 'offline'>
	> &
		ClientOptions;

	// --- State ---
	public status: ClientStatus = ClientStatus.Disconnected;

	// --- Crypto ---
	private readonly keyPair: KeyPair;
	public readonly clientX509: string;

	// --- Auth ---
	public profile: PlayerProfile = { name: 'Player', uuid: 'adfcf5ca-206c-404a-aec4-f59fff264c9b', xuid: '0' };
	private authResult: AuthResult | null = null;

	// --- Compression ---
	public compressionReady: boolean = false;
	public compressionThreshold: number = 256;
	public compressionMethod: CompressionMethod = CompressionMethod.Zlib;

	// --- Player Data ---
	public playerData: PlayerData | null = null;

	// --- World State ---
	public readonly entities: EntityTracker = new EntityTracker();
	public readonly state: PlayerState = new PlayerState();

	// --- Tick ---
	private tickInterval: ReturnType<typeof setInterval> | null = null;
	private tickCount: bigint = 0n;

	// --- Reconnect ---
	private reconnectAttempts = 0;
	private isReconnecting = false;

	// --- Dimension change tracking ---
	private awaitingDimensionAck = false;

	constructor(options: ClientOptions) {
		super();
		this.options = {
			viewDistance: DEFAULT_VIEW_DISTANCE,
			protocolVersion: DEFAULT_PROTOCOL_VERSION,
			gameVersion: DEFAULT_GAME_VERSION,
			offline: false,
			username: 'Player',
			autoReconnect: false,
			maxReconnectAttempts: 3,
			reconnectDelay: 3000,
			...options,
		};

		this.ip = this.options.host;
		this.port = this.options.port;
		this.GUID = BigInt(Math.floor(Math.random() * 2 ** 64));

		this.socket = createSocket('udp4');

		// Generate ECDH key pair
		this.keyPair = generateKeyPair();
		this.clientX509 = this.keyPair.x509;

		this.frameManager = new FrameManager(this);
		this.queue = new Queue(this);

		this.bindSocketEvents();
		this.bindRakNetConnect();
	}

	// ==================== PUBLIC API ====================

	/**
	 * Connects to the server. Authenticates (if online mode) and starts the RakNet handshake.
	 *
	 * @example
	 * const client = new Client({ host: '127.0.0.1', port: 19132, offline: true });
	 * await client.connect();
	 */
	public async connect(): Promise<void> {
		if (this.status !== ClientStatus.Disconnected) {
			throw new Error('Client is already connected or connecting');
		}

		this.status = ClientStatus.Connecting;
		this.reconnectAttempts = 0;

		// Authenticate + build JWT chains
		this.authResult = await authenticate(this.keyPair, this.options);
		this.profile = this.authResult.profile;
		this.logger.info(`Authenticated as ${this.profile.name} (xuid: ${this.profile.xuid})`);

		// Start tick loop and begin RakNet handshake
		this.startTicking();
		this.establishConnection();
	}

	/**
	 * Disconnects from the server gracefully.
	 */
	public disconnect(reason: string = 'Client disconnect', sendToServer: boolean = true): void {
		if (this.status === ClientStatus.Disconnected) return;

		this.logger.info(`Disconnecting: ${reason}`);

		if (sendToServer && this.status >= ClientStatus.Connected) {
			try {
				this.sendFrameRaw(Buffer.from([0x15]), Priority.Immediate); // RakNet disconnect
			} catch {
				// Best effort
			}
		}

		const wasSpawned = this.status >= ClientStatus.Spawned;
		this.cleanup();
		this.emit('disconnect', reason);

		// Auto-reconnect on unexpected disconnects
		if (
			wasSpawned &&
			this.options.autoReconnect &&
			!this.isReconnecting &&
			this.reconnectAttempts < (this.options.maxReconnectAttempts ?? 3)
		) {
			this.attemptReconnect();
		}
	}

	/** Sends a chat message. */
	public chat(message: string): void {
		this.requireSpawned('chat');
		const packet = new TextPacket();
		packet.type = 1;
		packet.needsTranslation = false;
		packet.source = this.profile.name;
		packet.message = message;
		packet.parameters = [];
		packet.xuid = this.profile.xuid;
		packet.platformChatId = '';
		this.sendPacket(packet);
	}

	/** Sends a command (with or without the leading slash). */
	public sendCommand(command: string): void {
		this.requireSpawned('sendCommand');
		const packet = new CommandRequestPacket();
		packet.command = command.startsWith('/') ? command : `/${command}`;
		packet.origin = {
			type: 0,
			uuid: this.profile.uuid,
			requestId: '',
			uniqueEntityId: this.playerData?.entityId ?? 0n,
		} as any;
		packet.isInternal = false;
		packet.version = 0;
		this.sendPacket(packet);
	}

	/** Responds to a modal form. Pass `null` to cancel. */
	public respondToForm(formId: number, data: string | null): void {
		const packet = new ModalFormResponsePacket();
		packet.id = formId;
		if (data === null) {
			packet.canceled = true;
			packet.reason = 0 as any;
		} else {
			packet.canceled = false;
			packet.data = data;
		}
		this.sendPacket(packet);
	}

	/** Sends SetLocalPlayerAsInitialized to mark the player as ready. */
	public setInitialized(): void {
		if (!this.playerData) return;
		const packet = new SetLocalPlayerAsInitializedPacket();
		packet.runtimeEntityId = this.playerData.runtimeEntityId;
		this.sendPacket(packet);
	}

	/** Returns the current tick count. */
	public getTick(): bigint {
		return this.tickCount;
	}

	/**
	 * Listens for a specific packet by ID or name. Returns a cleanup function.
	 *
	 * @example
	 * const off = client.onPacket('Text', (data) => console.log(data));
	 * off(); // stop listening
	 */
	public onPacket(
		idOrName: number | string,
		callback: (data: { id: number; name: string; buffer: Buffer }) => void,
	): () => void {
		const targetId = typeof idOrName === 'string' ? this.resolvePacketName(idOrName) : idOrName;
		const handler = (data: { id: number; name: string; buffer: Buffer }) => {
			if (data.id === targetId) callback(data);
		};
		this.on('packet', handler);
		return () => this.off('packet', handler);
	}

	/**
	 * Waits for a specific packet. Resolves with the packet data.
	 *
	 * @example
	 * const pkt = await client.waitForPacket('StartGame', 30_000);
	 */
	public waitForPacket(
		idOrName: number | string,
		timeoutMs?: number,
	): Promise<{ id: number; name: string; buffer: Buffer }> {
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const off = this.onPacket(idOrName, (data) => {
				if (timer) clearTimeout(timer);
				off();
				resolve(data);
			});
			if (timeoutMs) {
				timer = setTimeout(() => {
					off();
					reject(new Error(`Timed out waiting for packet ${idOrName} after ${timeoutMs}ms`));
				}, timeoutMs);
			}
		});
	}

	/** Enables logging of all incoming packets. Returns a cleanup function. */
	public enablePacketLogging(): () => void {
		const handler = (data: { id: number; name: string; buffer: Buffer }) => {
			this.logger.info(`[PKT] 0x${data.id.toString(16).padStart(2, '0')} ${data.name} (${data.buffer.length} bytes)`);
		};
		this.on('packet', handler);
		return () => this.off('packet', handler);
	}

	/** Returns the human-readable name for a packet ID. */
	public getPacketName(id: number): string {
		return getPacketName(id);
	}

	/** True if the client is fully spawned. */
	public get isSpawned(): boolean {
		return this.status === ClientStatus.Spawned;
	}

	/** True if the client has an active connection. */
	public get isConnected(): boolean {
		return this.status >= ClientStatus.Connected;
	}

	// ==================== RESPAWN / DIMENSION ACKs ====================

	/**
	 * Handles a Respawn packet from the server.
	 * When state=ServerReadyToSpawn, responds with ClientReadyToSpawn.
	 * @internal Called by PacketHandler.
	 */
	public handleRespawn(position: { x: number; y: number; z: number }, respawnState: number, runtimeEntityId: bigint): void {
		if (respawnState === RespawnState.ServerReadyToSpawn) {
			const response = new RespawnPacket();
			response.position = new Vector3f(position.x, position.y, position.z);
			response.state = RespawnState.ClientReadyToSpawn;
			response.runtimeEntityId = runtimeEntityId;
			this.sendPacket(response);
			this.logger.info('Sent respawn ACK (ClientReadyToSpawn)');
		}

		if (this.playerData) {
			this.playerData.position = { ...position };
		}
	}

	/**
	 * Handles a ChangeDimension packet from the server.
	 * Responds with PlayerAction(DimensionChangeAck).
	 * @internal Called by PacketHandler.
	 */
	public handleDimensionChange(dimension: number, position: { x: number; y: number; z: number }): void {
		this.awaitingDimensionAck = true;

		if (this.playerData) {
			this.playerData.dimension = dimension;
			this.playerData.position = { ...position };
		}

		// Send DimensionChangeDone
		const action = new PlayerActionPacket();
		action.entityRuntimeId = this.playerData?.runtimeEntityId ?? 0n;
		action.action = ActionIds.DimensionChangeAck;
		action.blockPosition = new BlockCoordinates(0, 0, 0);
		action.resultPosition = new BlockCoordinates(0, 0, 0);
		action.face = 0;
		this.sendPacket(action);

		this.awaitingDimensionAck = false;
		this.logger.info(`Dimension change ACK sent (dim=${dimension})`);
	}

	// ==================== LOGIN FLOW ====================

	/**
	 * Called by the NetworkSettings handler to send the login packet.
	 * @internal
	 */
	public sendLogin(): void {
		if (!this.authResult) {
			this.logger.error('Cannot send login: no auth result');
			return;
		}

		const chain = this.options.offline
			? [this.authResult.identityChain]
			: [this.authResult.identityChain, ...this.authResult.accessTokenChains];

		const login = new LoginPacket();
		login.protocol = this.options.protocolVersion;
		login.tokens = {
			identity: JSON.stringify({ chain }),
			client: this.authResult.userChain,
		};

		this.sendPacket(login);
		this.logger.info('Login packet sent');
	}

	// ==================== PACKET SENDING (DRY) ====================

	/**
	 * Core method: wraps payload in a RakNet frame and queues it.
	 * All frame-sending routes through here (DRY).
	 */
	private sendFrameRaw(
		payload: Buffer,
		priority: Priority = Priority.Normal,
		reliability: Reliability = Reliability.ReliableOrdered,
		orderChannel: number = 0,
	): void {
		const frame = new Frame();
		frame.reliability = reliability;
		frame.orderChannel = orderChannel;
		frame.payload = payload;
		this.queue.sendFrame(frame, priority);
	}

	/** Sends a protocol packet with compression (if enabled). */
	public sendPacket(packet: DataPacket, priority: Priority = Priority.Normal): void {
		const gamePayload = this.buildGamePayload(Framer.frame(packet.serialize()));
		this.sendFrameRaw(gamePayload, priority);
	}

	/** Sends multiple protocol packets in one batch. */
	public sendPackets(packets: DataPacket[], priority: Priority = Priority.Normal): void {
		const serialized = packets.map((p) => p.serialize());
		const gamePayload = this.buildGamePayload(Framer.frame(...serialized));
		this.sendFrameRaw(gamePayload, priority);
	}

	/** Sends a raw game packet without compression (used before NetworkSettings). */
	public sendRawGamePacket(packet: DataPacket): void {
		const framed = Framer.frame(packet.serialize());
		const gamePayload = Buffer.concat([Buffer.from([GAME_BYTE]), framed]);
		this.sendFrameRaw(gamePayload, Priority.Immediate);
	}

	/** Builds a 0xFE game payload, applying compression if ready. */
	private buildGamePayload(framed: Buffer): Buffer {
		const compressed = this.compressPayload(framed);
		return Buffer.concat([Buffer.from([GAME_BYTE]), compressed]);
	}

	/** Compresses a framed payload based on current settings. */
	private compressPayload(framed: Buffer): Buffer {
		if (!this.compressionReady) return framed;

		if (framed.byteLength > this.compressionThreshold && this.compressionMethod === CompressionMethod.Zlib) {
			return Buffer.from([CompressionMethod.Zlib, ...deflateRawSync(framed)]);
		}
		return Buffer.from([CompressionMethod.None, ...framed]);
	}

	/** Sends a raw buffer over the UDP socket. */
	public send(packet: Buffer): void {
		this.socket.send(packet, 0, packet.length, this.port, this.ip, (err) => {
			if (err) this.logger.error('Socket send error:', err);
		});
	}

	/** Sends an ACK for received frame sequences. */
	public sendAck(sequences: number[]): void {
		if (sequences.length === 0) return;
		const ack = new Ack();
		ack.sequences = sequences;
		this.send(ack.serialize());
	}

	/** Sends a NACK for lost frame sequences. */
	public sendNack(sequences: number[]): void {
		if (sequences.length === 0) return;
		const nack = new Nack();
		nack.sequences = sequences;
		this.send(nack.serialize());
	}

	// ==================== RAKNET HANDSHAKE ====================

	private bindSocketEvents(): void {
		this.socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
		this.socket.on('error', (err) => {
			this.logger.error('Socket error:', err);
			this.emit('error', err);
		});
		this.socket.on('close', () => {
			this.logger.info('Socket closed');
			this.cleanup();
		});
	}

	private bindRakNetConnect(): void {
		this.on('raknet_connect', () => {
			this.status = ClientStatus.Connected;
			this.logger.info('RakNet connection established, sending network settings request...');

			const packet = new RequestNetworkSettingsPacket();
			packet.protocol = this.options.protocolVersion;
			this.sendRawGamePacket(packet);
		});
	}

	private establishConnection(): void {
		try {
			const packet = new OpenConnectionRequest1();
			packet.magic = RAKNET_MAGIC;
			packet.mtu = 1492;
			packet.protocol = 11;

			this.socket.send(packet.serialize(), this.port, this.ip, (err) => {
				if (err) {
					this.logger.error('Failed to send OpenConnectionRequest1:', err);
					this.emit('error', err);
				} else {
					this.logger.info('OpenConnectionRequest1 sent');
				}
			});
		} catch (error) {
			this.logger.error('Error establishing connection:', error);
			this.emit('error', error);
		}
	}

	private handleMessage(msg: Buffer, rinfo: RemoteInfo): void {
		try {
			const packetId = msg[0]!;

			switch (packetId) {
				case Packet.OpenConnectionReply1: {
					const response = new OpenConnectionRequest2();
					response.magic = RAKNET_MAGIC;
					response.address = new Address(rinfo.address, rinfo.port, 4);
					response.mtu = 1492;
					response.client = this.GUID;
					this.send(response.serialize());
					this.logger.info('OpenConnectionReply1 received, sending Request2');
					break;
				}

				case Packet.OpenConnectionReply2: {
					this.logger.info('OpenConnectionReply2 received, sending ConnectionRequest');
					const connReq = new ConnectionRequest();
					connReq.client = this.GUID;
					connReq.timestamp = BigInt(Date.now());
					this.sendFrameRaw(connReq.serialize(), Priority.Immediate);
					break;
				}

				case Packet.Ack: {
					const ack = new Ack(msg).deserialize();
					for (const seq of ack.sequences) {
						this.queue.outputBackupQueue.delete(seq);
					}
					break;
				}

				case Packet.Nack: {
					const nack = new Nack(msg).deserialize();
					for (const seq of nack.sequences) {
						const frames = this.queue.outputBackupQueue.get(seq);
						if (frames) {
							for (const frame of frames) {
								this.queue.sendFrame(frame, Priority.Immediate);
							}
						}
					}
					break;
				}

				default: {
					if (packetId >= 128 && packetId < 144) {
						this.frameManager.handleIncomingFrameSet(msg);
					}
					break;
				}
			}
		} catch (err) {
			this.logger.error('Error handling message:', err);
		}
	}

	// ==================== TICK SYSTEM + PlayerAuthInput ====================

	private startTicking(): void {
		if (this.tickInterval) return;
		this.tickInterval = setInterval(() => this.tick(), TICK_MS);
	}

	private tick(): void {
		this.tickCount++;

		// Flush outgoing queue
		this.queue.sendFrameQueue();

		// Send PlayerAuthInput every tick after spawn to prevent timeout kick
		if (this.status === ClientStatus.Spawned && this.playerData && !this.awaitingDimensionAck) {
			this.sendPlayerAuthInput();
		}

		this.emit('tick', this.tickCount);
	}

	/** Sends a PlayerAuthInput packet with current position/rotation. */
	private sendPlayerAuthInput(): void {
		if (!this.playerData) return;

		const packet = new PlayerAuthInputPacket();
		packet.pitch = this.playerData.pitch;
		packet.yaw = this.playerData.yaw;
		packet.headYaw = this.playerData.headYaw;
		packet.position = new Vector3f(
			this.playerData.position.x,
			this.playerData.position.y,
			this.playerData.position.z,
		);
		packet.motion = new Vector2f(0, 0);
		packet.inputData = 0n;
		packet.inputMode = 1; // Mouse
		packet.playMode = 0; // Normal
		packet.newInteractionModel = 0;
		packet.currentTick = this.tickCount;
		packet.positionDelta = new Vector3f(0, 0, 0);

		this.sendPacket(packet);
	}

	// ==================== AUTO-RECONNECT ====================

	private async attemptReconnect(): Promise<void> {
		this.isReconnecting = true;
		this.reconnectAttempts++;

		const delay = (this.options.reconnectDelay ?? 3000) * this.reconnectAttempts;
		this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.options.maxReconnectAttempts})...`);

		await new Promise((resolve) => setTimeout(resolve, delay));

		try {
			// Create fresh socket and state
			this.resetForReconnect();
			await this.connect();
			this.isReconnecting = false;
			this.logger.info('Reconnected successfully');
			this.emit('reconnect', this.reconnectAttempts);
		} catch (error) {
			this.logger.error('Reconnect failed:', error);
			this.isReconnecting = false;
			if (this.reconnectAttempts < (this.options.maxReconnectAttempts ?? 3)) {
				this.attemptReconnect();
			} else {
				this.emit('reconnect_failed', this.reconnectAttempts);
			}
		}
	}

	private resetForReconnect(): void {
		this.status = ClientStatus.Disconnected;
		this.compressionReady = false;
		this.playerData = null;
		this.entities.clear();
		this.state.clear();
		this.tickCount = 0n;
		this.awaitingDimensionAck = false;
	}

	// ==================== UTILITY ====================

	private resolvePacketName(name: string): number {
		const lower = name.toLowerCase();
		for (const [id, pktName] of Object.entries(PACKET_NAMES)) {
			if (pktName.toLowerCase() === lower) return Number(id);
		}
		return -1;
	}

	private requireSpawned(action: string): void {
		if (this.status !== ClientStatus.Spawned) {
			this.logger.warn(`Cannot ${action}: not spawned`);
		}
	}

	private cleanup(): void {
		this.status = ClientStatus.Disconnected;
		this.compressionReady = false;

		if (this.tickInterval) {
			clearInterval(this.tickInterval);
			this.tickInterval = null;
		}

		this.frameManager.destroy();

		try {
			this.socket.close();
		} catch {
			// Socket may already be closed
		}
	}
}

export { Client };
