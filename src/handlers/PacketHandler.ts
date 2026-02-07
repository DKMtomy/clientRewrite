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
	SetLocalPlayerAsInitializedPacket,
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
	ModalFormResponsePacket,
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

type PacketDeserializer = (buffer: Buffer, client: Client) => void;

const handlers = new Map<number, PacketDeserializer>();

function registerHandler(packetId: number, handler: PacketDeserializer): void {
	handlers.set(packetId, handler);
}

// --- Network Settings ---
registerHandler(ProtocolPacket.NetworkSettings, (buffer, client) => {
	const packet = new NetworkSettingsPacket(buffer).deserialize();
	client.logger.info(`Network settings received: compression=${packet.compressionMethod}, threshold=${packet.compressionThreshold}`);

	client.compressionThreshold = packet.compressionThreshold;
	client.compressionMethod = packet.compressionMethod;
	client.compressionReady = true;

	// Now send the login packet
	client.sendLogin();
});

// --- Play Status ---
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

// --- Resource Packs Info ---
registerHandler(ProtocolPacket.ResourcePacksInfo, (buffer, client) => {
	const packet = new ResourcePacksInfoPacket(buffer).deserialize();
	client.logger.info(`Resource packs info: ${packet.texturePacks?.length || 0} texture packs, ${packet.behaviorPacks?.length || 0} behavior packs`);

	const response = new ResourcePackClientResponsePacket();
	response.response = ResourcePackResponse.HaveAllPacks;
	response.packs = [];
	client.sendPacket(response);
});

// --- Resource Pack Stack ---
registerHandler(ProtocolPacket.ResourcePackStack, (buffer, client) => {
	const packet = new ResourcePackStackPacket(buffer).deserialize();
	client.logger.info(`Resource pack stack: version=${packet.gameVersion}`);

	const response = new ResourcePackClientResponsePacket();
	response.response = ResourcePackResponse.Completed;
	response.packs = [];
	client.sendPacket(response);
});

// --- Start Game ---
registerHandler(ProtocolPacket.StartGame, (buffer, client) => {
	const packet = new StartGamePacket(buffer).deserialize();
	client.logger.info(`Start game received - world: ${packet.levelId || 'unknown'}`);

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

	// Request chunk radius
	const radiusPacket = new RequestChunkRadiusPacket();
	radiusPacket.radius = client.options.viewDistance ?? 10;
	radiusPacket.maxRadius = client.options.viewDistance ?? 10;
	client.sendPacket(radiusPacket);
});

// --- Disconnect ---
registerHandler(ProtocolPacket.Disconnect, (buffer, client) => {
	const packet = new DisconnectPacket(buffer).deserialize();
	const reason = packet.message || `Disconnect reason: ${packet.reason}`;
	client.logger.warn(`Disconnected by server: ${reason}`);
	client.emit('kick', reason);
	client.disconnect(reason, false);
});

// --- Text ---
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

// --- Set Title ---
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

// --- Respawn ---
registerHandler(ProtocolPacket.Respawn, (buffer, client) => {
	const packet = new RespawnPacket(buffer).deserialize();
	client.emit('respawn', {
		position: packet.position,
		state: packet.state,
		runtimeEntityId: packet.runtimeEntityId,
	});
});

// --- Change Dimension ---
registerHandler(ProtocolPacket.ChangeDimension, (buffer, client) => {
	const packet = new ChangeDimensionPacket(buffer).deserialize();
	if (client.playerData) {
		client.playerData.dimension = packet.dimension;
		client.playerData.position = packet.position || client.playerData.position;
	}
	client.emit('change_dimension', {
		dimension: packet.dimension,
		position: packet.position,
		respawn: packet.respawn,
	});
});

// --- Transfer ---
registerHandler(ProtocolPacket.Transfer, (buffer, client) => {
	const packet = new TransferPacket(buffer).deserialize();
	client.logger.info(`Transfer to ${packet.address}:${packet.port}`);
	client.emit('transfer', { address: packet.address, port: packet.port });
});

// --- Set Time ---
registerHandler(ProtocolPacket.SetTime, (buffer, client) => {
	const packet = new SetTimePacket(buffer).deserialize();
	client.emit('set_time', packet.time);
});

// --- Chunk Radius Update ---
registerHandler(ProtocolPacket.ChunkRadiusUpdate, (buffer, client) => {
	const packet = new ChunkRadiusUpdatePacket(buffer).deserialize();
	client.logger.info(`Chunk radius updated: ${packet.radius}`);
});

// --- Move Player ---
registerHandler(ProtocolPacket.MovePlayer, (buffer, client) => {
	const packet = new MovePlayerPacket(buffer).deserialize();
	if (client.playerData && packet.runtimeId === client.playerData.runtimeEntityId) {
		client.playerData.position = packet.position || client.playerData.position;
		client.playerData.pitch = packet.pitch ?? client.playerData.pitch;
		client.playerData.yaw = packet.yaw ?? client.playerData.yaw;
		client.playerData.headYaw = packet.headYaw ?? client.playerData.headYaw;
	}
	client.emit('move_player', packet);
});

// --- Network Stack Latency ---
registerHandler(ProtocolPacket.NetworkStackLatency, (buffer, client) => {
	const packet = new NetworkStackLatencyPacket(buffer).deserialize();
	if (packet.fromServer) {
		const response = new NetworkStackLatencyPacket();
		response.timestamp = packet.timestamp;
		response.fromServer = false;
		client.sendPacket(response);
	}
});

// --- Player List ---
registerHandler(ProtocolPacket.PlayerList, (buffer, client) => {
	const packet = new PlayerListPacket(buffer).deserialize();
	client.emit('player_list', { action: packet.action, records: packet.records });
});

// --- Available Commands ---
registerHandler(ProtocolPacket.AvailableCommands, (buffer, client) => {
	const packet = new AvailableCommandsPacket(buffer).deserialize();
	client.emit('available_commands', packet);
});

// --- Update Attributes ---
registerHandler(ProtocolPacket.UpdateAttributes, (buffer, client) => {
	const packet = new UpdateAttributesPacket(buffer).deserialize();
	if (client.playerData && packet.runtimeEntityId === client.playerData.runtimeEntityId) {
		client.emit('update_attributes', packet.attributes);
	}
});

// --- Set Entity Data ---
registerHandler(ProtocolPacket.SetEntityData, (buffer, client) => {
	const packet = new SetEntityDataPacket(buffer).deserialize();
	client.emit('entity_data', packet);
});

// --- Container Open ---
registerHandler(ProtocolPacket.ContainerOpen, (buffer, client) => {
	const packet = new ContainerOpenPacket(buffer).deserialize();
	client.emit('container_open', packet);
});

// --- Container Close ---
registerHandler(ProtocolPacket.ContainerClose, (buffer, client) => {
	const packet = new ContainerClosePacket(buffer).deserialize();
	client.emit('container_close', packet);
});

// --- Inventory Content ---
registerHandler(ProtocolPacket.InventoryContent, (buffer, client) => {
	const packet = new InventoryContentPacket(buffer).deserialize();
	client.emit('inventory_content', packet);
});

// --- Inventory Slot ---
registerHandler(ProtocolPacket.InventorySlot, (buffer, client) => {
	const packet = new InventorySlotPacket(buffer).deserialize();
	client.emit('inventory_slot', packet);
});

// --- Set Player Game Type ---
registerHandler(ProtocolPacket.SetPlayerGameType, (buffer, client) => {
	const packet = new SetPlayerGameTypePacket(buffer).deserialize();
	if (client.playerData) {
		client.playerData.gamemode = packet.gamemode;
	}
	client.emit('gamemode', packet.gamemode);
});

// --- Level Chunk ---
registerHandler(ProtocolPacket.LevelChunk, (buffer, client) => {
	try {
		const packet = new LevelChunkPacket(buffer).deserialize();
		client.emit('level_chunk', { x: packet.x, z: packet.z, dimension: packet.dimension });
	} catch {
		// Chunk deserialization can fail on complex data; silently skip
	}
});

// --- Level Event ---
registerHandler(ProtocolPacket.LevelEvent, (buffer, client) => {
	const packet = new LevelEventPacket(buffer).deserialize();
	client.emit('level_event', packet);
});

// --- Boss Event ---
registerHandler(ProtocolPacket.BossEvent, (buffer, client) => {
	const packet = new BossEventPacket(buffer).deserialize();
	client.emit('boss_event', packet);
});

// --- Set Hud ---
registerHandler(ProtocolPacket.SetHud, (buffer, client) => {
	const packet = new SetHudPacket(buffer).deserialize();
	client.emit('set_hud', packet);
});

// --- Update Abilities ---
registerHandler(ProtocolPacket.UpdateAbilities, (buffer, client) => {
	const packet = new UpdateAbilitiesPacket(buffer).deserialize();
	client.emit('update_abilities', packet);
});

// --- Modal Form Request ---
registerHandler(ProtocolPacket.ModalFormRequest, (buffer, client) => {
	const packet = new ModalFormRequestPacket(buffer).deserialize();
	client.emit('modal_form', { id: packet.id, payload: packet.payload });
});

// --- Toast Request ---
registerHandler(ProtocolPacket.ToastRequest, (buffer, client) => {
	const packet = new ToastRequestPacket(buffer).deserialize();
	client.emit('toast', { title: packet.title, message: packet.message });
});

// --- Creative Content ---
registerHandler(ProtocolPacket.CreativeContent, (buffer, client) => {
	// Just acknowledge, don't store the full creative items list
	new CreativeContentPacket(buffer).deserialize();
});

// --- Biome Definition List ---
registerHandler(ProtocolPacket.BiomeDefinitionList, (buffer, client) => {
	new BiomeDefinitionListPacket(buffer).deserialize();
});

// --- Set Commands Enabled ---
registerHandler(ProtocolPacket.SetCommandsEnabled, (buffer, client) => {
	const packet = new SetCommandsEnabledPacket(buffer).deserialize();
	client.emit('commands_enabled', packet.enabled);
});

// --- Command Output ---
registerHandler(ProtocolPacket.CommandOutput, (buffer, client) => {
	const packet = new CommandOutputPacket(buffer).deserialize();
	client.emit('command_output', packet);
});

// --- Add Player ---
registerHandler(ProtocolPacket.AddPlayer, (buffer, client) => {
	const packet = new AddPlayerPacket(buffer).deserialize();
	client.emit('add_player', packet);
});

// --- Add Entity ---
registerHandler(ProtocolPacket.AddEntity, (buffer, client) => {
	const packet = new AddEntityPacket(buffer).deserialize();
	client.emit('add_entity', packet);
});

// --- Remove Entity ---
registerHandler(ProtocolPacket.RemoveEntity, (buffer, client) => {
	const packet = new RemoveEntityPacket(buffer).deserialize();
	client.emit('remove_entity', packet);
});

// --- Level Sound Event ---
registerHandler(ProtocolPacket.LevelSoundEvent, (buffer, client) => {
	try {
		const packet = new LevelSoundEventPacket(buffer).deserialize();
		client.emit('level_sound', packet);
	} catch {
		// Some sound events have unusual data; skip
	}
});

// --- Item Component ---
registerHandler(ProtocolPacket.ItemComponent, (buffer, client) => {
	new ItemComponentPacket(buffer).deserialize();
});

/**
 * Reads a VarInt-encoded packet ID from a buffer, stripping sub-client bits.
 */
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

	// Strip sender/target sub-client IDs (upper bits)
	return packetId & 0x3ff;
}

/**
 * Processes a decoded game packet buffer and routes it to the correct handler.
 * The buffer should start with the packet header (VarInt packet ID).
 */
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

	// Emit raw packet event for custom handling - includes id, name, and raw buffer
	client.emit('packet', { id: packetId, name, buffer });
}

/**
 * Decodes a game packet payload (after stripping 0xFE byte).
 * Handles decompression and unframing.
 */
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
				data = compressedData;
				break;
			case CompressionMethod.Snappy:
				// Snappy not implemented - treat as raw
				data = compressedData;
				break;
			default:
				data = compressedData;
				break;
		}
	} else {
		// Before compression is negotiated, data is raw framed packets
		data = payload;
	}

	return Framer.unframe(data);
}
