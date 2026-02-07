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

/**
 * Map of all known Bedrock protocol packet IDs to human-readable names.
 * Use `getPacketName(id)` for quick lookups.
 */
export const PACKET_NAMES: Record<number, string> = {
	1: 'Login',
	2: 'PlayStatus',
	5: 'Disconnect',
	6: 'ResourcePacksInfo',
	7: 'ResourcePackStack',
	8: 'ResourcePackClientResponse',
	9: 'Text',
	10: 'SetTime',
	11: 'StartGame',
	12: 'AddPlayer',
	13: 'AddEntity',
	14: 'RemoveEntity',
	15: 'AddItemActor',
	17: 'TakeItemActor',
	18: 'MoveActorAbsolute',
	19: 'MovePlayer',
	21: 'UpdateBlock',
	25: 'LevelEvent',
	29: 'UpdateAttributes',
	30: 'InventoryTransaction',
	31: 'MobEquipment',
	33: 'Interact',
	34: 'BlockPickRequest',
	36: 'PlayerAction',
	39: 'SetEntityData',
	40: 'SetActorMotion',
	44: 'Animate',
	45: 'Respawn',
	46: 'ContainerOpen',
	47: 'ContainerClose',
	48: 'PlayerHotbar',
	49: 'InventoryContent',
	50: 'InventorySlot',
	58: 'LevelChunk',
	59: 'SetCommandsEnabled',
	61: 'ChangeDimension',
	62: 'SetPlayerGameType',
	63: 'PlayerList',
	69: 'RequestChunkRadius',
	70: 'ChunkRadiusUpdate',
	74: 'BossEvent',
	76: 'AvailableCommands',
	77: 'CommandRequest',
	79: 'CommandOutput',
	82: 'ResourcePackDataInfo',
	83: 'ResourcePackChunkData',
	84: 'ResourcePackChunkRequest',
	85: 'Transfer',
	88: 'SetTitle',
	100: 'ModalFormRequest',
	101: 'ModalFormResponse',
	106: 'RemoveObjective',
	107: 'SetDisplayObjective',
	108: 'SetScore',
	112: 'SetScoreboardIdentity',
	113: 'SetLocalPlayerAsInitialized',
	115: 'NetworkStackLatency',
	121: 'NetworkChunkPublisherUpdate',
	122: 'BiomeDefinitionList',
	123: 'LevelSoundEvent',
	143: 'NetworkSettings',
	144: 'PlayerAuthInput',
	145: 'CreativeContent',
	147: 'ItemStackRequest',
	148: 'ItemStackResponse',
	156: 'PacketViolationWarning',
	162: 'ItemComponent',
	169: 'NpcDialogue',
	177: 'ScriptMessage',
	186: 'ToastRequest',
	187: 'UpdateAbilities',
	188: 'UpdateAdventureSettings',
	193: 'RequestNetworkSettings',
	308: 'SetHud',
};

/**
 * Gets the human-readable name for a packet ID, or a hex fallback.
 */
export function getPacketName(id: number): string {
	return PACKET_NAMES[id] ?? `Unknown(0x${id.toString(16).padStart(2, '0')})`;
}
