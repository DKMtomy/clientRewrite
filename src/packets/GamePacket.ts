import { BasePacket, Packet, Proto } from '@serenityjs/raknet';

/**
 * Represents a game packet.
 */
@Proto(0xfe)
class GamePacket extends BasePacket {
	/**
	 * The body of the game packet, compressed.
	 */
	public _body!: Buffer;
}
