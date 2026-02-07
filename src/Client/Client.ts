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
} from '@serenityjs/protocol';
import { deflateRawSync } from 'zlib';
import { Authflow, Titles } from 'prismarine-auth';
import JWT, { SignOptions } from 'jsonwebtoken';
import * as UUID from 'uuid-1345';
import * as crypto from 'crypto';

import {
	ClientOptions,
	ClientStatus,
	PlayerProfile,
	PlayerData,
	GAME_BYTE,
	RAKNET_MAGIC,
	MOJANG_PUBLIC_KEY,
	DEFAULT_PROTOCOL_VERSION,
	DEFAULT_GAME_VERSION,
	DEFAULT_VIEW_DISTANCE,
	CLIENT_TICK_RATE,
	getPacketName,
	PACKET_NAMES,
} from '@/types';

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
	public readonly options: ClientOptions;

	// --- State ---
	public status: ClientStatus = ClientStatus.Disconnected;

	// --- Crypto ---
	private readonly ecdhKeyPair: crypto.KeyPairKeyObjectResult;
	private readonly publicKeyDER: Buffer;
	private readonly privateKeyPEM: string | Buffer;
	public readonly clientX509: string;

	// --- Auth ---
	public profile: PlayerProfile = { name: 'Player', uuid: 'adfcf5ca-206c-404a-aec4-f59fff264c9b', xuid: '0' };
	private accessTokenChains: string[] = [];
	private clientIdentityChain: string = '';
	private clientUserChain: string = '';

	// --- Compression (public so handlers can set them) ---
	public compressionReady: boolean = false;
	public compressionThreshold: number = 256;
	public compressionMethod: CompressionMethod = CompressionMethod.Zlib;

	// --- Player Data ---
	public playerData: PlayerData | null = null;

	// --- Tick ---
	private tickInterval: ReturnType<typeof setInterval> | null = null;
	private tickCount: bigint = 0n;

	constructor(options: ClientOptions) {
		super();
		this.options = {
			viewDistance: DEFAULT_VIEW_DISTANCE,
			protocolVersion: DEFAULT_PROTOCOL_VERSION,
			gameVersion: DEFAULT_GAME_VERSION,
			offline: false,
			username: 'Player',
			...options,
		};

		this.ip = this.options.host;
		this.port = this.options.port;

		this.GUID = BigInt(Math.floor(Math.random() * 2 ** 64));

		this.socket = createSocket('udp4');

		// Generate ECDH key pair for authentication
		const curve = 'secp384r1';
		const der: crypto.KeyExportOptions<'der'> = { format: 'der', type: 'spki' };
		const pem: crypto.KeyExportOptions<'pem'> = { format: 'pem', type: 'sec1' };

		this.ecdhKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: curve });
		this.publicKeyDER = this.ecdhKeyPair.publicKey.export(der);
		this.privateKeyPEM = this.ecdhKeyPair.privateKey.export(pem);
		this.clientX509 = this.publicKeyDER.toString('base64');

		this.frameManager = new FrameManager(this);
		this.queue = new Queue(this);

		// Socket handlers
		this.socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
		this.socket.on('error', (err) => {
			this.logger.error('Socket error:', err);
			this.emit('error', err);
		});
		this.socket.on('close', () => {
			this.logger.info('Socket closed');
			this.cleanup();
		});

		// When RakNet connection is established, begin login sequence
		this.on('raknet_connect', () => {
			this.status = ClientStatus.Connected;
			this.logger.info('RakNet connection established, sending network settings request...');

			const packet = new RequestNetworkSettingsPacket();
			packet.protocol = this.options.protocolVersion!;

			// Send WITHOUT compression (compression not yet negotiated)
			this.sendRawGamePacket(packet);
		});
	}

	// ==================== PUBLIC API ====================

	/**
	 * Connects to the server. Handles authentication (if online mode) and starts the RakNet handshake.
	 */
	public async connect(): Promise<void> {
		if (this.status !== ClientStatus.Disconnected) {
			throw new Error('Client is already connected or connecting');
		}

		this.status = ClientStatus.Connecting;

		// Authenticate if online mode
		if (!this.options.offline) {
			await this.authenticate();
		} else {
			this.profile = {
				name: this.options.username || 'Player',
				uuid: this.uuidFrom(this.options.username || 'Player'),
				xuid: '0',
			};
		}

		// Build JWT chains for login
		this.buildChains();

		// Start the tick loop
		this.startTicking();

		// Begin RakNet handshake
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
				const frame = new Frame();
				frame.reliability = Reliability.ReliableOrdered;
				frame.orderChannel = 0;
				frame.payload = Buffer.from([0x15]); // RakNet disconnect
				this.queue.sendFrame(frame, Priority.Immediate);
			} catch {
				// Best effort
			}
		}

		this.cleanup();
		this.emit('disconnect', reason);
	}

	/**
	 * Sends a chat message to the server.
	 */
	public chat(message: string): void {
		if (this.status !== ClientStatus.Spawned) {
			this.logger.warn('Cannot send chat: not spawned');
			return;
		}

		const packet = new TextPacket();
		packet.type = 1; // Chat
		packet.needsTranslation = false;
		packet.source = this.profile.name;
		packet.message = message;
		packet.parameters = [];
		packet.xuid = this.profile.xuid;
		packet.platformChatId = '';
		this.sendPacket(packet);
	}

	/**
	 * Sends a command to the server (without the leading slash).
	 */
	public sendCommand(command: string): void {
		if (this.status !== ClientStatus.Spawned) {
			this.logger.warn('Cannot send command: not spawned');
			return;
		}

		const packet = new CommandRequestPacket();
		packet.command = command.startsWith('/') ? command : `/${command}`;
		packet.origin = {
			type: 0,
			uuid: this.profile.uuid,
			requestId: this.nextUUID(),
			uniqueEntityId: this.playerData?.entityId ?? 0n,
		} as any;
		packet.isInternal = false;
		packet.version = 0;
		this.sendPacket(packet);
	}

	/**
	 * Responds to a modal form from the server.
	 */
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

	/**
	 * Sends SetLocalPlayerAsInitialized to the server (marks player as ready).
	 */
	public setInitialized(): void {
		if (!this.playerData) return;
		const packet = new SetLocalPlayerAsInitializedPacket();
		packet.runtimeEntityId = this.playerData.runtimeEntityId;
		this.sendPacket(packet);
	}

	/**
	 * Gets the current tick count.
	 */
	public getTick(): bigint {
		return this.tickCount;
	}

	/**
	 * Listens for a specific packet by ID or name.
	 * Returns a cleanup function to remove the listener.
	 *
	 * @example
	 * // By packet ID
	 * const off = client.onPacket(9, (data) => console.log('Text packet:', data));
	 * // By name
	 * const off = client.onPacket('Text', (data) => console.log('Text packet:', data));
	 * // Later: off() to stop listening
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
	 * Waits for a specific packet to arrive. Resolves with the packet data.
	 * Optionally accepts a timeout in milliseconds.
	 *
	 * @example
	 * const startGame = await client.waitForPacket('StartGame', 30000);
	 * console.log('Game started!', startGame);
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

	/**
	 * Enables logging of ALL incoming packet IDs and names.
	 * Returns a cleanup function to stop logging.
	 *
	 * @example
	 * const stopLogging = client.enablePacketLogging();
	 * // ... packets get logged ...
	 * stopLogging(); // disable
	 */
	public enablePacketLogging(): () => void {
		const handler = (data: { id: number; name: string; buffer: Buffer }) => {
			this.logger.info(`[PKT] 0x${data.id.toString(16).padStart(2, '0')} ${data.name} (${data.buffer.length} bytes)`);
		};
		this.on('packet', handler);
		return () => this.off('packet', handler);
	}

	/**
	 * Returns the human-readable name for a packet ID.
	 */
	public getPacketName(id: number): string {
		return getPacketName(id);
	}

	/**
	 * Returns true if the client is fully spawned and ready to interact.
	 */
	public get isSpawned(): boolean {
		return this.status === ClientStatus.Spawned;
	}

	/**
	 * Returns true if the client has an active connection (any state past Disconnected).
	 */
	public get isConnected(): boolean {
		return this.status >= ClientStatus.Connected;
	}

	/**
	 * Resolves a packet name string to its numeric ID.
	 */
	private resolvePacketName(name: string): number {
		const lower = name.toLowerCase();
		for (const [id, pktName] of Object.entries(PACKET_NAMES)) {
			if (pktName.toLowerCase() === lower) return Number(id);
		}
		return -1;
	}

	// ==================== LOGIN FLOW ====================

	/**
	 * Called by the NetworkSettings handler to send the login packet.
	 * @internal
	 */
	public sendLogin(): void {
		const chain = this.options.offline
			? [this.clientIdentityChain]
			: [this.clientIdentityChain, ...this.accessTokenChains];

		const encodedChain = JSON.stringify({ chain });

		const login = new LoginPacket();
		login.protocol = this.options.protocolVersion!;
		login.tokens = {
			identity: encodedChain,
			client: this.clientUserChain,
		};

		this.sendPacket(login);
		this.logger.info('Login packet sent');
	}

	// ==================== AUTHENTICATION ====================

	private async authenticate(): Promise<void> {
		try {
			this.logger.info('Authenticating with Xbox Live...');

			const auth = new Authflow(this.options.username || 'Player', 'auth', {
				flow: 'live',
				deviceType: 'Nintendo',
				authTitle: Titles.MinecraftNintendoSwitch,
			});

			// @ts-expect-error - prismarine-auth types may not match exactly
			const chains: string[] = await auth.getMinecraftBedrockToken(this.clientX509);

			// Extract profile from the last JWT chain
			const profileJwt = chains[chains.length - 1]!;
			const payload = JSON.parse(Buffer.from(profileJwt.split('.')[1]!, 'base64').toString());

			this.profile = {
				name: payload?.extraData?.displayName || this.options.username || 'Player',
				uuid: payload?.extraData?.identity || this.uuidFrom(this.options.username || 'Player'),
				xuid: payload?.extraData?.XUID || '0',
			};

			this.accessTokenChains = chains;
			this.logger.info(`Authenticated as ${this.profile.name} (${this.profile.xuid})`);
		} catch (error) {
			this.logger.error('Authentication failed:', error);
			throw error;
		}
	}

	// ==================== JWT CHAIN BUILDING ====================

	private buildChains(): void {
		this.buildIdentityChain();
		this.buildUserChain();
	}

	private buildIdentityChain(): void {
		const privateKey = this.ecdhKeyPair.privateKey;
		const algorithm = 'ES384';

		if (this.options.offline) {
			const payload = {
				extraData: {
					displayName: this.profile.name,
					identity: this.profile.uuid,
					titleId: '89692877',
					XUID: this.profile.xuid,
				},
				certificateAuthority: true,
				identityPublicKey: this.clientX509,
			};
			const signOptions: SignOptions = {
				algorithm,
				notBefore: 0,
				issuer: 'self',
				expiresIn: 60 * 60,
				header: { alg: algorithm, x5u: this.clientX509, typ: undefined },
			};
			this.clientIdentityChain = JWT.sign(payload, privateKey, signOptions);
		} else {
			// Online: extract Mojang key from auth chains
			let mojangKey = MOJANG_PUBLIC_KEY;
			if (this.accessTokenChains.length > 0) {
				try {
					const firstChainHeader = JSON.parse(
						Buffer.from(this.accessTokenChains[0]!.split('.')[0]!, 'base64').toString(),
					);
					if (firstChainHeader.x5u) {
						mojangKey = firstChainHeader.x5u;
					}
				} catch {
					// Fallback to default Mojang key
				}
			}

			const payload = {
				identityPublicKey: mojangKey,
				certificateAuthority: true,
			};
			const signOptions: SignOptions = {
				algorithm,
				header: { alg: algorithm, x5u: this.clientX509, typ: undefined },
			};
			this.clientIdentityChain = JWT.sign(payload, privateKey, signOptions);
		}
	}

	private buildUserChain(): void {
		const privateKey = this.ecdhKeyPair.privateKey;
		const algorithm = 'ES384';

		const payload: Record<string, unknown> = {
			SkinGeometryDataEngineVersion: '',
			ClientRandomId: Date.now(),
			CurrentInputMode: 1,
			DefaultInputMode: 1,
			DeviceId: this.nextUUID(),
			DeviceModel: 'BedrockClient',
			DeviceOS: this.options.deviceOS ?? 7,
			GameVersion: this.options.gameVersion!,
			GuiScale: -1,
			LanguageCode: 'en_GB',
			PlatformOfflineId: '',
			PlatformOnlineId: '',
			PlayFabId: this.nextUUID().replace(/-/g, '').slice(0, 16),
			SelfSignedId: this.nextUUID(),
			ServerAddress: `${this.ip}:${this.port}`,
			ThirdPartyName: this.profile.name,
			ThirdPartyNameOnly: false,
			UIProfile: 0,
			IsEditorMode: false,
			TrustedSkin: false,
			OverrideSkin: false,
			CompatibleWithClientSideChunkGen: false,
			...(this.options.skinData || {}),
		};

		this.clientUserChain = JWT.sign(payload, privateKey, {
			algorithm,
			header: { alg: algorithm, x5u: this.clientX509, typ: 'JWT' },
			noTimestamp: true,
		});
	}

	// ==================== PACKET SENDING ====================

	/**
	 * Sends a protocol packet with compression (if enabled).
	 */
	public sendPacket(packet: DataPacket, priority: Priority = Priority.Normal): void {
		const serialized = packet.serialize();
		const framed = Framer.frame(serialized);
		const payload = this.compressPayload(framed);
		const gamePacket = Buffer.concat([Buffer.from([GAME_BYTE]), payload]);

		const frame = new Frame();
		frame.reliability = Reliability.ReliableOrdered;
		frame.orderChannel = 0;
		frame.payload = gamePacket;
		this.queue.sendFrame(frame, priority);
	}

	/**
	 * Sends multiple protocol packets in one batch.
	 */
	public sendPackets(packets: DataPacket[], priority: Priority = Priority.Normal): void {
		const payloads = packets.map((p) => p.serialize());
		const framed = Framer.frame(...payloads);
		const payload = this.compressPayload(framed);
		const gamePacket = Buffer.concat([Buffer.from([GAME_BYTE]), payload]);

		const frame = new Frame();
		frame.reliability = Reliability.ReliableOrdered;
		frame.orderChannel = 0;
		frame.payload = gamePacket;
		this.queue.sendFrame(frame, priority);
	}

	/**
	 * Sends a raw game packet without compression (used before NetworkSettings).
	 */
	private sendRawGamePacket(packet: DataPacket): void {
		const serialized = packet.serialize();
		const framed = Framer.frame(serialized);
		const gamePacket = Buffer.concat([Buffer.from([GAME_BYTE]), framed]);

		const frame = new Frame();
		frame.reliability = Reliability.ReliableOrdered;
		frame.orderChannel = 0;
		frame.payload = gamePacket;
		this.queue.sendFrame(frame, Priority.Immediate);
	}

	/**
	 * Compresses a framed payload based on current compression settings.
	 */
	private compressPayload(framed: Buffer): Buffer {
		if (!this.compressionReady) {
			return framed;
		}

		if (framed.byteLength > this.compressionThreshold) {
			switch (this.compressionMethod) {
				case CompressionMethod.Zlib:
					return Buffer.from([CompressionMethod.Zlib, ...deflateRawSync(framed)]);
				default:
					return Buffer.from([CompressionMethod.None, ...framed]);
			}
		}

		return Buffer.from([CompressionMethod.None, ...framed]);
	}

	/**
	 * Sends a raw RakNet packet over the socket.
	 */
	public send(packet: Buffer): void {
		this.socket.send(packet, 0, packet.length, this.port, this.ip, (err) => {
			if (err) {
				this.logger.error('Socket send error:', err);
			}
		});
	}

	/**
	 * Sends an ACK for received frame sequences.
	 */
	public sendAck(sequences: number[]): void {
		if (sequences.length === 0) return;
		const ack = new Ack();
		ack.sequences = sequences;
		this.send(ack.serialize());
	}

	/**
	 * Sends a NACK for lost frame sequences.
	 */
	public sendNack(sequences: number[]): void {
		if (sequences.length === 0) return;
		const nack = new Nack();
		nack.sequences = sequences;
		this.send(nack.serialize());
	}

	// ==================== RAKNET HANDSHAKE ====================

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

					const frame = new Frame();
					frame.reliability = Reliability.ReliableOrdered;
					frame.orderChannel = 0;
					frame.payload = connReq.serialize();
					this.queue.sendFrame(frame, Priority.Immediate);
					break;
				}

				// ACK from server
				case Packet.Ack: {
					const ack = new Ack(msg).deserialize();
					for (const seq of ack.sequences) {
						this.queue.outputBackupQueue.delete(seq);
					}
					break;
				}

				// NACK from server - resend lost frames
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

				// FrameSet packets (128-143)
				default: {
					if (packetId >= 128 && packetId < 144) {
						this.frameManager.handleIncomingFrameSet(msg);
					} else if (packetId !== 0x1c && packetId !== 0x01) {
						this.logger.warn(`Unknown packet: 0x${packetId.toString(16).padStart(2, '0')}`);
					}
					break;
				}
			}
		} catch (err) {
			this.logger.error('Error handling message:', err);
		}
	}

	// ==================== TICK SYSTEM ====================

	private startTicking(): void {
		if (this.tickInterval) return;

		const tickMs = 1000 / CLIENT_TICK_RATE;
		this.tickInterval = setInterval(() => {
			this.tick();
		}, tickMs);
	}

	private tick(): void {
		this.tickCount++;

		// Flush the outgoing queue
		this.queue.sendFrameQueue();

		// Emit tick event for custom logic
		this.emit('tick', this.tickCount);
	}

	// ==================== UTILITY ====================

	public uuidFrom(input: string): string {
		return UUID.v3({ namespace: '6ba7b811-9dad-11d1-80b4-00c04fd430c8', name: input });
	}

	public nextUUID(): string {
		return this.uuidFrom(Date.now().toString() + Math.random().toString());
	}

	private cleanup(): void {
		this.status = ClientStatus.Disconnected;
		this.compressionReady = false;

		if (this.tickInterval) {
			clearInterval(this.tickInterval);
			this.tickInterval = null;
		}

		try {
			this.socket.close();
		} catch {
			// Socket may already be closed
		}
	}
}

export { Client };
