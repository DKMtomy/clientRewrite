import {
	CompressionMethod,
	DisconnectPacket,
	Framer,
	NetworkSettingsPacket,
	Packet as ProtocolPacket,
	PlayStatusPacket,
	ResourcePackClientResponsePacket,
	ResourcePacksInfoPacket,
	ResourcePackStackPacket,
	StartGamePacket,
	TextPacket,
	SetTitlePacket,
	RespawnPacket,
	ChangeDimensionPacket,
	TransferPacket,
	SetTimePacket,
	ChunkRadiusUpdatePacket,
	MovePlayerPacket,
	NetworkStackLatencyPacket,
	RequestChunkRadiusPacket,
	PlayerListPacket,
	AvailableCommandsPacket,
	UpdateAttributesPacket,
	SetEntityDataPacket,
	ContainerOpenPacket,
	ContainerClosePacket,
	InventoryContentPacket,
	InventorySlotPacket,
	SetPlayerGameTypePacket,
	LevelChunkPacket,
	LevelEventPacket,
	BossEventPacket,
	SetHudPacket,
	UpdateAbilitiesPacket,
	ModalFormRequestPacket,
	ToastRequestPacket,
	CreativeContentPacket,
	BiomeDefinitionListPacket,
	SetCommandsEnabledPacket,
	CommandOutputPacket,
	AddPlayerPacket,
	AddEntityPacket,
	RemoveEntityPacket,
	SetActorMotionPacket,
	AnimatePacket,
	LevelSoundEventPacket,
	PlayerActionPacket,
	MobEquipmentPacket,
	ItemComponentPacket,
} from '@serenityjs/protocol';
import { inflateRawSync } from 'zlib';
import { ResourcePackResponse } from '@serenityjs/protocol';
import type { Client } from '@/Client';
import { ClientStatus, getPacketName } from '@/types';

// ==================== HANDLER REGISTRY ====================

type PacketDeserializer = (buffer: Buffer, client: Client) => void;

const handlers = new Map<number, PacketDeserializer>();

function registerHandler(packetId: number, handler: PacketDeserializer): void {
	handlers.set(packetId, handler);
}

// ==================== LOGIN SEQUENCE ====================

registerHandler(ProtocolPacket.NetworkSettings, (buffer, client) => {
	const packet = new NetworkSettingsPacket(buffer).deserialize();
	client.logger.info(`Network settings: compression=${packet.compressionMethod}, threshold=${packet.compressionThreshold}`);

	client.compressionThreshold = packet.compressionThreshold;
	client.compressionMethod = packet.compressionMethod;
	client.compressionReady = true;

	client.sendLogin();
});

registerHandler(ProtocolPacket.PlayStatus, (buffer, client) => {
	const packet = new PlayStatusPacket(buffer).deserialize();
	client.logger.info(`Play status: ${packet.status}`);

	switch (packet.status) {
		case 0: // LoginSuccess
			client.status = ClientStatus.LoggingIn;
			client.emit('login');
			break;
		case 3: // PlayerSpawn
			client.status = ClientStatus.Spawned;
			client.emit('spawn');
			break;
		case 1: // FailedClient
		case 2: // FailedServer
		case 5: // FailedVanillaEdu
		case 6: // FailedIncompatible
		case 7: // FailedServerFull
			client.logger.error(`Login failed with status: ${packet.status}`);
			client.emit('error', new Error(`Login failed with status ${packet.status}`));
			client.disconnect(`Login failed: status ${packet.status}`);
			break;
	}
});

registerHandler(ProtocolPacket.ResourcePacksInfo, (buffer, client) => {
	const packet = new ResourcePacksInfoPacket(buffer).deserialize();
	client.logger.info(`Resource packs: ${packet.texturePacks?.length || 0} texture, ${packet.behaviorPacks?.length || 0} behavior`);

	const response = new ResourcePackClientResponsePacket();
	response.response = ResourcePackResponse.HaveAllPacks;
	response.packs = [];
	client.sendPacket(response);
});

registerHandler(ProtocolPacket.ResourcePackStack, (buffer, client) => {
	const packet = new ResourcePackStackPacket(buffer).deserialize();
	client.logger.info(`Resource pack stack: version=${packet.gameVersion}`);

	const response = new ResourcePackClientResponsePacket();
	response.response = ResourcePackResponse.Completed;
	response.packs = [];
	client.sendPacket(response);
});

registerHandler(ProtocolPacket.StartGame, (buffer, client) => {
	const packet = new StartGamePacket(buffer).deserialize();
	client.logger.info(`Start game - world: ${packet.levelId || 'unknown'}`);

	client.playerData = {
		entityId: packet.entityId,
		runtimeEntityId: packet.runtimeEntityId,
		position: packet.playerPosition || { x: 0, y: 0, z: 0 },
		pitch: packet.pitch || 0,
		yaw: packet.yaw || 0,
		headYaw: 0,
		gamemode: packet.playerGamemode || 0,
		dimension: packet.dimension ?? 0,
		spawnPosition: packet.spawnPosition || { x: 0, y: 0, z: 0 },
		worldName: packet.levelId || '',
		seed: packet.seed ?? 0n,
		difficulty: packet.difficulty ?? 1,
		worldGamemode: packet.worldGamemode ?? 0,
	};

	client.status = ClientStatus.Spawning;
	client.emit('start_game', client.playerData);

	const radiusPacket = new RequestChunkRadiusPacket();
	radiusPacket.radius = client.options.viewDistance ?? 10;
	radiusPacket.maxRadius = client.options.viewDistance ?? 10;
	client.sendPacket(radiusPacket);
});

registerHandler(ProtocolPacket.Disconnect, (buffer, client) => {
	const packet = new DisconnectPacket(buffer).deserialize();
	const reason = packet.message || `Disconnect reason: ${packet.reason}`;
	client.logger.warn(`Disconnected by server: ${reason}`);
	client.emit('kick', reason);
	client.disconnect(reason, false);
});

// ==================== CHAT / UI ====================

registerHandler(ProtocolPacket.Text, (buffer, client) => {
	const packet = new TextPacket(buffer).deserialize();
	client.emit('text', {
		type: packet.type,
		needsTranslation: packet.needsTranslation,
		source: packet.source,
		message: packet.message,
		parameters: packet.parameters,
		xuid: packet.xuid,
		platformChatId: packet.platformChatId,
	});
});

registerHandler(ProtocolPacket.SetTitle, (buffer, client) => {
	const packet = new SetTitlePacket(buffer).deserialize();
	client.emit('title', {
		type: packet.type,
		text: packet.text,
		fadeInTime: packet.fadeInTime,
		stayTime: packet.stayTime,
		fadeOutTime: packet.fadeOutTime,
	});
});

registerHandler(ProtocolPacket.ModalFormRequest, (buffer, client) => {
	const packet = new ModalFormRequestPacket(buffer).deserialize();
	client.emit('modal_form', { id: packet.id, payload: packet.payload });
});

registerHandler(ProtocolPacket.ToastRequest, (buffer, client) => {
	const packet = new ToastRequestPacket(buffer).deserialize();
	client.emit('toast', { title: packet.title, message: packet.message });
});

// ==================== RESPAWN / DIMENSION (with ACKs) ====================

registerHandler(ProtocolPacket.Respawn, (buffer, client) => {
	const packet = new RespawnPacket(buffer).deserialize();

	// Delegate to client for respawn ACK handling
	client.handleRespawn(
		packet.position,
		packet.state,
		packet.runtimeEntityId,
	);

	client.emit('respawn', {
		position: packet.position,
		state: packet.state,
		runtimeEntityId: packet.runtimeEntityId,
	});
});

registerHandler(ProtocolPacket.ChangeDimension, (buffer, client) => {
	const packet = new ChangeDimensionPacket(buffer).deserialize();

	// Delegate to client for dimension ACK handling
	client.handleDimensionChange(
		packet.dimension,
		packet.position || client.playerData?.position || { x: 0, y: 0, z: 0 },
	);

	client.emit('change_dimension', {
		dimension: packet.dimension,
		position: packet.position,
		respawn: packet.respawn,
	});
});

registerHandler(ProtocolPacket.Transfer, (buffer, client) => {
	const packet = new TransferPacket(buffer).deserialize();
	client.logger.info(`Transfer to ${packet.address}:${packet.port}`);
	client.emit('transfer', { address: packet.address, port: packet.port });
});

// ==================== WORLD STATE ====================

registerHandler(ProtocolPacket.SetTime, (buffer, client) => {
	const packet = new SetTimePacket(buffer).deserialize();
	client.emit('set_time', packet.time);
});

registerHandler(ProtocolPacket.ChunkRadiusUpdate, (buffer, client) => {
	const packet = new ChunkRadiusUpdatePacket(buffer).deserialize();
	client.logger.info(`Chunk radius updated: ${packet.radius}`);
});

registerHandler(ProtocolPacket.MovePlayer, (buffer, client) => {
	const packet = new MovePlayerPacket(buffer).deserialize();

	// Update local player data
	if (client.playerData && packet.runtimeId === client.playerData.runtimeEntityId) {
		client.playerData.position = packet.position || client.playerData.position;
		client.playerData.pitch = packet.pitch ?? client.playerData.pitch;
		client.playerData.yaw = packet.yaw ?? client.playerData.yaw;
		client.playerData.headYaw = packet.headYaw ?? client.playerData.headYaw;
	}

	// Update entity tracker
	client.entities.updatePosition(
		packet.runtimeId,
		packet.position || { x: 0, y: 0, z: 0 },
		packet.pitch,
		packet.yaw,
		packet.headYaw,
	);

	client.emit('move_player', packet);
});

registerHandler(ProtocolPacket.NetworkStackLatency, (buffer, client) => {
	const packet = new NetworkStackLatencyPacket(buffer).deserialize();
	if (packet.fromServer) {
		const response = new NetworkStackLatencyPacket();
		response.timestamp = packet.timestamp;
		response.fromServer = false;
		client.sendPacket(response);
	}
});

// ==================== PLAYER STATE ====================

registerHandler(ProtocolPacket.UpdateAttributes, (buffer, client) => {
	const packet = new UpdateAttributesPacket(buffer).deserialize();
	if (client.playerData && packet.runtimeEntityId === client.playerData.runtimeEntityId) {
		// Update player state tracker
		client.state.updateAttributes(
			packet.attributes.map((a) => ({
				name: a.name as string,
				current: a.current,
				default: a.default,
				min: a.min,
				max: a.max,
			})),
		);
		client.emit('update_attributes', packet.attributes);
	}
});

registerHandler(ProtocolPacket.SetPlayerGameType, (buffer, client) => {
	const packet = new SetPlayerGameTypePacket(buffer).deserialize();
	if (client.playerData) {
		client.playerData.gamemode = packet.gamemode;
	}
	client.emit('gamemode', packet.gamemode);
});

registerHandler(ProtocolPacket.UpdateAbilities, (buffer, client) => {
	const packet = new UpdateAbilitiesPacket(buffer).deserialize();
	client.emit('update_abilities', packet);
});

// ==================== ENTITY TRACKING ====================

registerHandler(ProtocolPacket.AddPlayer, (buffer, client) => {
	const packet = new AddPlayerPacket(buffer).deserialize();
	client.entities.addPlayer(
		packet.runtimeId,
		packet.uniqueEntityId,
		packet.username,
		packet.uuid,
		packet.position || { x: 0, y: 0, z: 0 },
	);
	client.emit('add_player', packet);
});

registerHandler(ProtocolPacket.AddEntity, (buffer, client) => {
	const packet = new AddEntityPacket(buffer).deserialize();
	client.entities.addEntity(
		packet.runtimeId,
		packet.uniqueEntityId,
		packet.identifier,
		packet.position || { x: 0, y: 0, z: 0 },
	);
	client.emit('add_entity', packet);
});

registerHandler(ProtocolPacket.RemoveEntity, (buffer, client) => {
	const packet = new RemoveEntityPacket(buffer).deserialize();
	client.entities.removeByUniqueId(packet.uniqueEntityId);
	client.emit('remove_entity', packet);
});

registerHandler(ProtocolPacket.SetActorMotion, (buffer, client) => {
	const packet = new SetActorMotionPacket(buffer).deserialize();
	client.entities.updateMotion(packet.runtimeId, packet.motion || { x: 0, y: 0, z: 0 });
	client.emit('actor_motion', packet);
});

registerHandler(ProtocolPacket.SetEntityData, (buffer, client) => {
	const packet = new SetEntityDataPacket(buffer).deserialize();
	client.emit('entity_data', packet);
});

registerHandler(ProtocolPacket.Animate, (buffer, client) => {
	const packet = new AnimatePacket(buffer).deserialize();
	client.emit('animate', packet);
});

// ==================== PLAYER LIST ====================

registerHandler(ProtocolPacket.PlayerList, (buffer, client) => {
	const packet = new PlayerListPacket(buffer).deserialize();
	client.emit('player_list', { action: packet.action, records: packet.records });
});

// ==================== INVENTORY ====================

registerHandler(ProtocolPacket.ContainerOpen, (buffer, client) => {
	const packet = new ContainerOpenPacket(buffer).deserialize();
	client.emit('container_open', packet);
});

registerHandler(ProtocolPacket.ContainerClose, (buffer, client) => {
	const packet = new ContainerClosePacket(buffer).deserialize();
	client.emit('container_close', packet);
});

registerHandler(ProtocolPacket.InventoryContent, (buffer, client) => {
	const packet = new InventoryContentPacket(buffer).deserialize();
	client.emit('inventory_content', packet);
});

registerHandler(ProtocolPacket.InventorySlot, (buffer, client) => {
	const packet = new InventorySlotPacket(buffer).deserialize();
	client.emit('inventory_slot', packet);
});

// ==================== WORLD ====================

registerHandler(ProtocolPacket.LevelChunk, (buffer, client) => {
	try {
		const packet = new LevelChunkPacket(buffer).deserialize();
		client.emit('level_chunk', { x: packet.x, z: packet.z, dimension: packet.dimension });
	} catch {
		// Chunk deserialization can fail on complex data
	}
});

registerHandler(ProtocolPacket.LevelEvent, (buffer, client) => {
	const packet = new LevelEventPacket(buffer).deserialize();
	client.emit('level_event', packet);
});

registerHandler(ProtocolPacket.BossEvent, (buffer, client) => {
	const packet = new BossEventPacket(buffer).deserialize();
	client.emit('boss_event', packet);
});

registerHandler(ProtocolPacket.SetHud, (buffer, client) => {
	const packet = new SetHudPacket(buffer).deserialize();
	client.emit('set_hud', packet);
});

registerHandler(ProtocolPacket.LevelSoundEvent, (buffer, client) => {
	try {
		const packet = new LevelSoundEventPacket(buffer).deserialize();
		client.emit('level_sound', packet);
	} catch {
		// Some sound events have unusual data
	}
});

// ==================== COMMANDS ====================

registerHandler(ProtocolPacket.AvailableCommands, (buffer, client) => {
	const packet = new AvailableCommandsPacket(buffer).deserialize();
	client.emit('available_commands', packet);
});

registerHandler(ProtocolPacket.SetCommandsEnabled, (buffer, client) => {
	const packet = new SetCommandsEnabledPacket(buffer).deserialize();
	client.emit('commands_enabled', packet.enabled);
});

registerHandler(ProtocolPacket.CommandOutput, (buffer, client) => {
	const packet = new CommandOutputPacket(buffer).deserialize();
	client.emit('command_output', packet);
});

// ==================== PASSTHROUGH (acknowledge only) ====================

registerHandler(ProtocolPacket.CreativeContent, (buffer) => {
	new CreativeContentPacket(buffer).deserialize();
});

registerHandler(ProtocolPacket.BiomeDefinitionList, (buffer) => {
	new BiomeDefinitionListPacket(buffer).deserialize();
});

registerHandler(ProtocolPacket.ItemComponent, (buffer) => {
	new ItemComponentPacket(buffer).deserialize();
});

// ==================== EXPORTS ====================

/** Reads a VarInt-encoded packet ID from a buffer, stripping sub-client bits. */
export function readPacketId(buffer: Buffer): number {
	let packetId = 0;
	let shift = 0;
	let cursor = 0;
	do {
		if (cursor >= buffer.length) return -1;
		const byte = buffer[cursor]!;
		packetId |= (byte & 0x7f) << shift;
		shift += 7;
		cursor++;
		if (!(byte & 0x80)) break;
	} while (shift < 35);
	return packetId & 0x3ff;
}

/** Routes a decoded game packet buffer to the correct handler. */
export function handleGamePacket(buffer: Buffer, client: Client): void {
	if (buffer.length < 1) return;

	const packetId = readPacketId(buffer);
	if (packetId === -1) return;

	const name = getPacketName(packetId);

	const handler = handlers.get(packetId);
	if (handler) {
		try {
			handler(buffer, client);
		} catch (error) {
			client.logger.error(`Error handling packet ${name} (0x${packetId.toString(16).padStart(2, '0')}): ${error}`);
		}
	}

	client.emit('packet', { id: packetId, name, buffer });
}

/** Decodes a game packet payload (after stripping 0xFE byte). */
export function decodeGamePackets(payload: Buffer, compressionReady: boolean): Buffer[] {
	let data: Buffer;

	if (compressionReady) {
		const compressionType = payload[0];
		const compressedData = payload.subarray(1);

		switch (compressionType) {
			case CompressionMethod.Zlib:
				data = inflateRawSync(compressedData);
				break;
			case CompressionMethod.None:
			case CompressionMethod.Snappy:
			default:
				data = compressedData;
				break;
		}
	} else {
		data = payload;
	}

	return Framer.unframe(data);
}
