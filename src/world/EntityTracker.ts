/**
 * Tracks entities in the world.
 * Single Responsibility: entity state management only.
 */

export interface TrackedEntity {
	runtimeId: bigint;
	uniqueId: bigint;
	type: string;
	position: { x: number; y: number; z: number };
	motion: { x: number; y: number; z: number };
	pitch: number;
	yaw: number;
	headYaw: number;
	metadata: Map<number, unknown>;
	/** For player entities only */
	username?: string;
	uuid?: string;
	xuid?: string;
}

export class EntityTracker {
	private readonly entities = new Map<bigint, TrackedEntity>();

	/** Returns all tracked entities. */
	getAll(): ReadonlyMap<bigint, TrackedEntity> {
		return this.entities;
	}

	/** Gets an entity by its runtime ID, or undefined if not tracked. */
	get(runtimeId: bigint): TrackedEntity | undefined {
		return this.entities.get(runtimeId);
	}

	/** Returns the number of tracked entities. */
	get count(): number {
		return this.entities.size;
	}

	/** Adds a non-player entity. */
	addEntity(
		runtimeId: bigint,
		uniqueId: bigint,
		type: string,
		position: { x: number; y: number; z: number },
	): TrackedEntity {
		const entity: TrackedEntity = {
			runtimeId,
			uniqueId,
			type,
			position: { ...position },
			motion: { x: 0, y: 0, z: 0 },
			pitch: 0,
			yaw: 0,
			headYaw: 0,
			metadata: new Map(),
		};
		this.entities.set(runtimeId, entity);
		return entity;
	}

	/** Adds a player entity with extra profile info. */
	addPlayer(
		runtimeId: bigint,
		uniqueId: bigint,
		username: string,
		uuid: string,
		position: { x: number; y: number; z: number },
	): TrackedEntity {
		const entity = this.addEntity(runtimeId, uniqueId, 'minecraft:player', position);
		entity.username = username;
		entity.uuid = uuid;
		return entity;
	}

	/** Removes an entity by its unique ID. */
	removeByUniqueId(uniqueId: bigint): boolean {
		for (const [runtimeId, entity] of this.entities) {
			if (entity.uniqueId === uniqueId) {
				this.entities.delete(runtimeId);
				return true;
			}
		}
		return false;
	}

	/** Removes an entity by its runtime ID. */
	remove(runtimeId: bigint): boolean {
		return this.entities.delete(runtimeId);
	}

	/** Updates an entity's position. */
	updatePosition(
		runtimeId: bigint,
		position: { x: number; y: number; z: number },
		pitch?: number,
		yaw?: number,
		headYaw?: number,
	): void {
		const entity = this.entities.get(runtimeId);
		if (!entity) return;

		entity.position = { ...position };
		if (pitch !== undefined) entity.pitch = pitch;
		if (yaw !== undefined) entity.yaw = yaw;
		if (headYaw !== undefined) entity.headYaw = headYaw;
	}

	/** Updates an entity's motion vector. */
	updateMotion(runtimeId: bigint, motion: { x: number; y: number; z: number }): void {
		const entity = this.entities.get(runtimeId);
		if (entity) entity.motion = { ...motion };
	}

	/** Updates entity metadata. */
	updateMetadata(runtimeId: bigint, metadata: Map<number, unknown>): void {
		const entity = this.entities.get(runtimeId);
		if (!entity) return;
		for (const [key, value] of metadata) {
			entity.metadata.set(key, value);
		}
	}

	/** Returns all tracked players. */
	getPlayers(): TrackedEntity[] {
		return [...this.entities.values()].filter((e) => e.type === 'minecraft:player');
	}

	/** Finds the nearest entity to a position. */
	nearest(position: { x: number; y: number; z: number }): TrackedEntity | undefined {
		let closest: TrackedEntity | undefined;
		let minDist = Infinity;

		for (const entity of this.entities.values()) {
			const dx = entity.position.x - position.x;
			const dy = entity.position.y - position.y;
			const dz = entity.position.z - position.z;
			const dist = dx * dx + dy * dy + dz * dz;
			if (dist < minDist) {
				minDist = dist;
				closest = entity;
			}
		}
		return closest;
	}

	/** Clears all tracked entities. */
	clear(): void {
		this.entities.clear();
	}
}
