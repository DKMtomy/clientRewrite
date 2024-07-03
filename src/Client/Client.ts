import { FrameManager } from '../FrameManager'; // Adjust the path if needed
import {
	Address,
	OpenConnectionRequest1,
	OpenConnectionRequest2,
	NewIncomingConnection,
	Packet,
	Reliability,
	Frame,
	Priority,
	ConnectionRequest,
	Ack,
	Nack,
	UnconnectedPing,
	UnconnectedPong,
} from '@serenityjs/raknet';
import { createSocket, RemoteInfo, Socket } from 'dgram';
import { Buffer } from 'buffer';
import { Logger, LoggerColors } from '@serenityjs/logger';
import { Queue } from '../Queue/Queue';
import EventEmitter from 'events';
import { CompressionMethod, DataPacket, Framer, LoginPacket, RequestNetworkSettingsPacket } from '@serenityjs/protocol';
import { createPublicKey, KeyPairKeyObjectResult } from 'crypto';
import { deflateRawSync } from 'zlib';
import { Authflow, Titles } from 'prismarine-auth';
import JWT, { SignOptions } from 'jsonwebtoken';
import * as UUID from 'uuid-1345';

import * as crypto from 'crypto';

const curve = 'secp384r1';
const pem: crypto.KeyExportOptions<'pem'> = { format: 'pem', type: 'spki' };

const GAME_BYTE = 254;

const magic = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');

interface profile {
	name: string;
	uuid: string;
	xuid: number;
}

const PUBLIC_KEY =
	'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAECRXueJeTDqNRRgJi/vlRufByu/2G0i2Ebt6YMar5QX/R0DIIyrJMcUpruK4QveTfJSTp3Shlq4Gk34cD/4GUWwkv0DVuzeuB+tXija7HBxii03NHDbPAD0AKnLr2wdAp';

class Client extends EventEmitter {
	readonly socket: Socket;
	readonly ip: string;
	readonly GUID: bigint;
	readonly port: number;
	readonly frameManager: FrameManager;
	protected connected = false;
	public queue: Queue;
	readonly logger: Logger = new Logger('Serenity Client', LoggerColors.MagentaBright);

	protected ecdhKeyPair: crypto.KeyPairKeyObjectResult;
	protected publicKeyDER: Buffer;
	protected privateKeyPEM: string | Buffer;
	protected clientX509: string;
	protected profile: profile = { name: 'Player', uuid: 'adfcf5ca-206c-404a-aec4-f59fff264c9b', xuid: 0 };
	protected username: string = 'Player';
	protected accessToken: string = '';
	protected clientIdentityChain: string = '';
	protected clientUserChain: string = '';

	constructor(dest: string) {
		super();
		const [ip, port] = dest.split(':');
		this.ip = ip;
		this.port = parseInt(port);

		this.GUID = BigInt(Math.floor(Math.random() * 2 ** 64));

		this.socket = createSocket('udp4');

		this.frameManager = new FrameManager(this);

		const curve = 'secp384r1';
		const der: crypto.KeyExportOptions<'der'> = { format: 'der', type: 'spki' };
		const pem: crypto.KeyExportOptions<'pem'> = { format: 'pem', type: 'sec1' };

		this.ecdhKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: curve });
		this.publicKeyDER = this.ecdhKeyPair.publicKey.export(der);
		this.privateKeyPEM = this.ecdhKeyPair.privateKey.export(pem);
		this.clientX509 = this.publicKeyDER.toString('base64');

		this.queue = new Queue(this);

		this.auth();
		this.createClientChain(null, false);
		this.createClientUserChain(this.ecdhKeyPair.privateKey);

		this.socket.on('message', (msg, rinfo) => this.handleHandshake(msg, rinfo));
		this.socket.on('error', (err) => {
			this.logger.error('Socket error:', err);
		});

		this.on('connect', async () => {
			const chain = [this.clientIdentityChain, ...this.accessToken];

			const encodedChain = JSON.stringify({ chain });

			let login = new LoginPacket();
			login.protocol = 685;
			login.tokens = {
				identity: encodedChain,
				client: this.clientUserChain,
			};

			this.sendPacket(login);
		});
	}

	public uuidFrom(string: string) {
		return UUID.v3({ namespace: '6ba7b811-9dad-11d1-80b4-00c04fd430c8', name: string });
	}

	public nextUUID() {
		return this.uuidFrom(Date.now().toString());
	}

	public createClientUserChain(privateKey: crypto.KeyObject): void {
		const options = {
			version: '1.21.1.03',
			host: this.ip,
			port: this.port,
			skinData: {},
		};

		let payload: any = {
			SkinGeometryDataEngineVersion: '',
			ClientRandomId: Date.now(),
			CurrentInputMode: 1,
			DefaultInputMode: 1,
			DeviceId: this.nextUUID(),
			DeviceModel: 'PrismarineJS',
			DeviceOS: this.profile?.xuid || 7,
			GameVersion: options.version,
			GuiScale: -1,
			LanguageCode: 'en_GB',
			PlatformOfflineId: '',
			PlatformOnlineId: '',
			PlayFabId: this.nextUUID().replace(/-/g, '').slice(0, 16),
			SelfSignedId: this.nextUUID(),
			ServerAddress: `${options.host}:${options.port}`,
			ThirdPartyName: this.profile.name,
			ThirdPartyNameOnly: false,
			UIProfile: 0,
			IsEditorMode: false,
			TrustedSkin: false,
			OverrideSkin: false,
			CompatibleWithClientSideChunkGen: false,
		};

		const customPayload = options.skinData || {};
		payload = { ...payload, ...customPayload };
		payload.ServerAddress = `${options.host}:${options.port}`;

		const algorithm = 'ES384';
		this.clientIdentityChain = JWT.sign(payload, privateKey, {
			algorithm,
			header: { alg: algorithm, x5u: this.clientX509, typ: 'JWT' }, // Ensure `alg` and `typ` are correctly set
			noTimestamp: true,
		});
	}

	public createClientChain(mojangKey: string | null, offline: boolean): void {
		const privateKey = this.ecdhKeyPair.privateKey;

		let token: string;
		const algorithm = 'ES384'; // Define your algorithm here

		if (offline) {
			const payload = {
				extraData: {
					displayName: this.username,
					identity: this.profile.uuid,
					titleId: '89692877',
					XUID: '0',
				},
				certificateAuthority: true,
				identityPublicKey: this.clientX509,
			};
			const signOptions: SignOptions = {
				algorithm: algorithm,
				notBefore: 0,
				issuer: 'self',
				expiresIn: 60 * 60,
				header: { alg: algorithm, x5u: this.clientX509, typ: undefined },
			};
			token = JWT.sign(payload, privateKey, signOptions);
		} else {
			const payload = {
				identityPublicKey: mojangKey || PUBLIC_KEY, // Use the appropriate public key here
				certificateAuthority: true,
			};
			const signOptions: SignOptions = {
				algorithm: algorithm,
				header: { alg: algorithm, x5u: this.clientX509, typ: undefined },
			};
			token = JWT.sign(payload, privateKey, signOptions);
		}

		this.clientIdentityChain = token;
		// this.createClientUserChain(privateKey);
	}

	public async auth() {
		try {
			let auth = new Authflow('Vekqi', 'auth', {
				flow: 'live',
				deviceType: 'Nintendo',
				authTitle: Titles.MinecraftNintendoSwitch,
			});

			//@ts-expect-error
			const chains = await auth.getMinecraftBedrockToken(this.clientX509);

			const jwt = chains[1];
			const [header, payload, signature] = jwt.split('.').map((k) => Buffer.from(k, 'base64')); // eslint-disable-line
			const xboxProfile = JSON.parse(String(payload));

			const profile = {
				name: xboxProfile?.extraData?.displayName || 'Player',
				uuid: xboxProfile?.extraData?.identity || 'adfcf5ca-206c-404a-aec4-f59fff264c9b', // random
				xuid: xboxProfile?.extraData?.XUID || 0,
			};

			this.profile = profile;
			this.username = profile.name;
			this.accessToken = chains;
		} catch (error) {
			this.logger.error('Authentication error:', error);
		}
	}

	sendPackets(priority: Priority | null, ...packets: Array<DataPacket>) {
		if (priority === null) priority = Priority.Normal;
		const payloads: Array<Buffer> = [];

		for (const packet of packets) {
			const serialized = packet.serialize();
			payloads.push(serialized);
		}

		const framed = Framer.frame(...payloads);

		const deflated =
			framed.byteLength > 256 && true
				? Buffer.from([CompressionMethod.Zlib, ...deflateRawSync(framed)])
				: true
				? Buffer.from([CompressionMethod.None, ...framed])
				: framed;
		const encrypted = deflated;

		const payload = Buffer.concat([Buffer.from([GAME_BYTE]), encrypted]);

		const frame = new Frame();
		frame.reliability = Reliability.ReliableOrdered;
		frame.orderChannel = 0;
		frame.payload = payload;
		this.queue.sendFrame(frame, priority);
	}

	sendPacket(packet: DataPacket, priority: Priority = Priority.Normal) {
		const serialized = packet.serialize();
		const framed = Framer.frame(serialized);
		const deflated =
			framed.byteLength > 256 && true
				? Buffer.from([CompressionMethod.Zlib, ...deflateRawSync(framed)])
				: true
				? Buffer.from([CompressionMethod.None, ...framed])
				: framed;
		const encrypted = deflated;
		const payload = Buffer.concat([Buffer.from([GAME_BYTE]), encrypted]);

		const frame = new Frame();
		frame.reliability = Reliability.ReliableOrdered;
		frame.orderChannel = 0;
		frame.payload = payload;
		this.queue.sendFrame(frame, priority);
	}

	send(packet: Buffer) {
		this.logger.log('Sent a ' + Packet[packet[0]]);
		this.socket.send(packet, 0, packet.length, this.port, this.ip, (err) => {
			if (err) {
				this.logger.error('Error sending packet:', err);
			}
		});
	}

	public establishConnection(): void {
		try {
			const packet = new OpenConnectionRequest1();
			packet.magic = magic;
			packet.mtu = 1492;
			packet.protocol = 11;

			this.socket.send(packet.serialize(), this.port, this.ip, (err) => {
				if (err) {
					this.logger.error('Failed to send Open Connection Request 1:', err);
				} else {
					this.logger.log('Open Connection Request 1 sent');
				}
			});
		} catch (error) {
			this.logger.error('Error establishing connection:', error);
		}
	}

	private handleHandshake(msg: Buffer, rinfo: RemoteInfo): void {
		try {
			let packet;

			switch (msg[0]) {
				case Packet.OpenConnectionReply1: {
					packet = new OpenConnectionRequest2();
					packet.magic = magic;
					packet.address = new Address(rinfo.address, rinfo.port, 4);
					packet.mtu = 1492;
					packet.client = this.GUID;
					this.send(packet.serialize());
					break;
				}
				case Packet.OpenConnectionReply2: {
					this.connected = true;
					// Create and send New Incoming Connection packet
					const packet = new ConnectionRequest();
					packet.client = this.GUID;
					packet.timestamp = BigInt(Date.now());

					const frame = new Frame();
					frame.reliability = Reliability.ReliableOrdered;
					frame.orderChannel = 0;
					frame.payload = packet.serialize();

					this.queue.sendFrame(frame, Priority.Immediate);
					break;
				}

				case 192: {
					break;
				}

				case 128:
				case 129:
				case 130:
				case 131:
				case 132:
				case 133: {
					this.frameManager.handleIncomingFrameSet(msg);
					break;
				}

				default: {
					this.logger.warn(`Received unknown packet ${msg[0]}`);
					break;
				}
			}
		} catch (err) {
			this.logger.error('Error handling handshake:', err);
		}
	}
}

export { Client };
