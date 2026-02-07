/**
 * Tracks the local player's attributes (health, hunger, XP, etc.).
 * Single Responsibility: player state/attribute management.
 */

export interface AttributeValue {
	current: number;
	default: number;
	min: number;
	max: number;
}

export class PlayerState {
	private readonly attributes = new Map<string, AttributeValue>();

	/** Updates attributes from an UpdateAttributes packet. */
	updateAttributes(
		attrs: Array<{ name: string; current: number; default: number; min: number; max: number }>,
	): void {
		for (const attr of attrs) {
			this.attributes.set(attr.name, {
				current: attr.current,
				default: attr.default,
				min: attr.min,
				max: attr.max,
			});
		}
	}

	/** Gets a specific attribute by name. */
	getAttribute(name: string): AttributeValue | undefined {
		return this.attributes.get(name);
	}

	/** Gets all attributes as a read-only map. */
	getAllAttributes(): ReadonlyMap<string, AttributeValue> {
		return this.attributes;
	}

	// --- Convenience getters for common attributes ---

	get health(): number {
		return this.attributes.get('minecraft:health')?.current ?? 20;
	}

	get maxHealth(): number {
		return this.attributes.get('minecraft:health')?.max ?? 20;
	}

	get hunger(): number {
		return this.attributes.get('minecraft:player.hunger')?.current ?? 20;
	}

	get saturation(): number {
		return this.attributes.get('minecraft:player.saturation')?.current ?? 5;
	}

	get exhaustion(): number {
		return this.attributes.get('minecraft:player.exhaustion')?.current ?? 0;
	}

	get experience(): number {
		return this.attributes.get('minecraft:player.experience')?.current ?? 0;
	}

	get level(): number {
		return this.attributes.get('minecraft:player.level')?.current ?? 0;
	}

	get movementSpeed(): number {
		return this.attributes.get('minecraft:movement')?.current ?? 0.1;
	}

	get absorption(): number {
		return this.attributes.get('minecraft:absorption')?.current ?? 0;
	}

	/** Returns true if the player is alive (health > 0). */
	get isAlive(): boolean {
		return this.health > 0;
	}

	/** Returns health as a percentage (0-100). */
	get healthPercent(): number {
		const max = this.maxHealth;
		return max > 0 ? (this.health / max) * 100 : 0;
	}

	/** Clears all tracked attributes (e.g., on dimension change). */
	clear(): void {
		this.attributes.clear();
	}
}
