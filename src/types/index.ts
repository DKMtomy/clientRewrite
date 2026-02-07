export interface ClientOptions {
	host: string;
	port: number;
	username?: string;
	offline?: boolean;
	protocolVersion?: number;
	viewDistance?: number;
	connectTimeout?: number;
	skinData?: Record<string, unknown>;
	deviceOS?: number;
	gameVersion?: string;
}

export interface PlayerProfile {
	name: string;
	uuid: string;
	xuid: string;
}

export interface PlayerData {
	entityId: bigint;
	runtimeEntityId: bigint;
	position: Vector3;
	pitch: number;
	yaw: number;
	headYaw: number;
	gamemode: number;
	dimension: number;
	spawnPosition: Vector3;
	worldName: string;
	seed: bigint;
	difficulty: number;
	worldGamemode: number;
}

export interface Vector3 {
	x: number;
	y: number;
	z: number;
}

export enum ClientStatus {
	Disconnected = 0,
	Connecting = 1,
	Connected = 2,
	LoggingIn = 3,
	Spawning = 4,
	Spawned = 5,
}

// ResourcePackResponse is exported from @serenityjs/protocol:
// None = 0, Refused = 1, SendPacks = 2, HaveAllPacks = 3, Completed = 4

export const GAME_BYTE = 0xfe;

export const RAKNET_MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');

export const MOJANG_PUBLIC_KEY =
	'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAECRXueJeTDqNRRgJi/vlRufByu/2G0i2Ebt6YMar5QX/R0DIIyrJMcUpruK4QveTfJSTp3Shlq4Gk34cD/4GUWwkv0DVuzeuB+tXija7HBxii03NHDbPAD0AKnLr2wdAp';

export const DEFAULT_PROTOCOL_VERSION = 685;
export const DEFAULT_GAME_VERSION = '1.21.1.03';
export const DEFAULT_VIEW_DISTANCE = 10;
export const CLIENT_TICK_RATE = 20;
export const RAKNET_TPS = 100;
