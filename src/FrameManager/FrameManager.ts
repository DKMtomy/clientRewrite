import {
	Address,
	ConnectedPing,
	ConnectedPong,
	ConnectionRequestAccepted,
	Frame,
	FrameSet,
	NewIncomingConnection,
	Packet,
	Priority,
	Reliability,
} from '@serenityjs/raknet';
import { BinaryStream } from '@serenityjs/binarystream';
import { Client } from '@/Client';
import { GAME_BYTE } from '@/types';
import { handleGamePacket, decodeGamePackets } from '@/handlers';

export class FrameManager {
	private receivedFrameSequences = new Set<number>();
	private lostFrameSequences = new Set<number>();
	private fragmentsQueue = new Map<number, Map<number, Frame>>();
	private inputOrderIndex = Array<number>(32).fill(0);
	private inputOrderingQueue = new Map<number, Map<number, Frame>>();
	private lastInputSequence = -1;

	// ACK/NACK batching - collect sequences and send periodically
	private pendingAcks: number[] = [];
	private pendingNacks: number[] = [];
	private ackInterval: ReturnType<typeof setInterval> | null = null;

	constructor(private client: Client) {
		for (let i = 0; i < 32; i++) {
			this.inputOrderingQueue.set(i, new Map());
		}

		// Send ACKs/NACKs every 10ms (RakNet tick rate)
		this.ackInterval = setInterval(() => this.flushAcknowledgements(), 10);
	}

	/**
	 * Stops the ACK/NACK flush interval. Call when disconnecting.
	 */
	public destroy(): void {
		if (this.ackInterval) {
			clearInterval(this.ackInterval);
			this.ackInterval = null;
		}
	}

	/**
	 * Sends batched ACKs and NACKs to the server.
	 */
	private flushAcknowledgements(): void {
		if (this.pendingAcks.length > 0) {
			this.client.sendAck(this.pendingAcks);
			this.pendingAcks = [];
		}
		if (this.pendingNacks.length > 0) {
			this.client.sendNack(this.pendingNacks);
			this.pendingNacks = [];
		}
	}

	// ==================== FRAME SET PROCESSING ====================

	public handleIncomingFrameSet(buffer: Buffer): void {
		const frameset = new FrameSet(buffer).deserialize();

		// Duplicate/out-of-order check
		if (frameset.sequence <= this.lastInputSequence) {
			return;
		}

		// Track received sequence and queue ACK
		this.receivedFrameSequences.add(frameset.sequence);
		this.pendingAcks.push(frameset.sequence);

		// Detect lost frames and queue NACKs
		for (let i = this.lastInputSequence + 1; i < frameset.sequence; i++) {
			if (!this.receivedFrameSequences.has(i)) {
				this.lostFrameSequences.add(i);
				this.pendingNacks.push(i);
			}
		}

		this.lastInputSequence = frameset.sequence;

		// Process each frame in the set
		for (const frame of frameset.frames) {
			this.handleFrame(frame);
		}
	}

	// ==================== FRAME ROUTING ====================

	public handleFrame(frame: Frame): void {
		if (frame.isFragmented()) {
			this.handleFragment(frame);
			return;
		}

		if (frame.isOrdered()) {
			this.handleOrderedFrame(frame);
		} else {
			this.processFrame(frame);
		}
	}

	private handleOrderedFrame(frame: Frame): void {
		const orderChannel = frame.orderChannel;
		const currentOrderIndex = this.inputOrderIndex[orderChannel]!;

		if (frame.orderIndex === currentOrderIndex) {
			this.inputOrderIndex[orderChannel]!++;
			this.processFrame(frame);

			// Process any queued out-of-order frames that are now in sequence
			const outOfOrderQueue = this.inputOrderingQueue.get(orderChannel)!;
			let nextOrderIndex = this.inputOrderIndex[orderChannel]!;
			while (outOfOrderQueue.has(nextOrderIndex)) {
				this.processFrame(outOfOrderQueue.get(nextOrderIndex)!);
				outOfOrderQueue.delete(nextOrderIndex);
				nextOrderIndex++;
			}
			this.inputOrderIndex[orderChannel] = nextOrderIndex;
		} else if (frame.orderIndex > currentOrderIndex) {
			this.inputOrderingQueue.get(orderChannel)?.set(frame.orderIndex, frame);
		}
	}

	public handleFragment(frame: Frame): void {
		const fragmentQueue = this.fragmentsQueue.get(frame.fragmentId) || new Map<number, Frame>();
		fragmentQueue.set(frame.fragmentIndex, frame);

		if (fragmentQueue.size === frame.fragmentSize) {
			// All fragments received - reassemble
			const stream = new BinaryStream();
			for (let i = 0; i < fragmentQueue.size; i++) {
				const frag = fragmentQueue.get(i);
				if (frag) {
					stream.writeBuffer(frag.payload);
				}
			}

			const reassembledFrame = new Frame();
			reassembledFrame.reliability = frame.reliability;
			reassembledFrame.reliableIndex = frame.reliableIndex;
			reassembledFrame.sequenceIndex = frame.sequenceIndex;
			reassembledFrame.orderIndex = frame.orderIndex;
			reassembledFrame.orderChannel = frame.orderChannel;
			reassembledFrame.payload = stream.getBuffer();

			this.fragmentsQueue.delete(frame.fragmentId);
			this.handleFrame(reassembledFrame);
		} else {
			this.fragmentsQueue.set(frame.fragmentId, fragmentQueue);
		}
	}

	// ==================== PAYLOAD PROCESSING ====================

	private processFrame(frame: Frame): void {
		try {
			this.incomingBatch(frame.payload);
		} catch (error) {
			this.client.logger.error(`Error processing frame (header=0x${frame.payload[0]?.toString(16)}): ${error}`);
		}
	}

	public incomingBatch(buffer: Buffer): void {
		if (buffer.length <= 0) return;

		const header = buffer[0]!;

		switch (header) {
			case Packet.ConnectedPing:
				this.handleConnectedPing(buffer);
				break;

			case Packet.ConnectionRequestAccepted:
				this.handleConnectionRequestAccepted(buffer);
				break;

			case Packet.Disconnect:
				this.client.logger.warn('Server sent RakNet disconnect');
				this.client.disconnect('Server disconnect', false);
				break;

			case GAME_BYTE:
				this.handleGamePacketBatch(buffer);
				break;

			default:
				// Unknown internal RakNet packet
				break;
		}
	}

	// ==================== RAKNET PACKET HANDLERS ====================

	private handleConnectedPing(buffer: Buffer): void {
		const packet = new ConnectedPing(buffer).deserialize();
		const pong = new ConnectedPong();
		pong.pingTimestamp = packet.timestamp;
		pong.timestamp = BigInt(Date.now());

		const frame = new Frame();
		frame.reliability = Reliability.Unreliable;
		frame.orderChannel = 0;
		frame.payload = pong.serialize();
		this.client.queue.sendFrame(frame, Priority.Immediate);
	}

	private handleConnectionRequestAccepted(buffer: Buffer): void {
		const incomingPacket = new ConnectionRequestAccepted(buffer).deserialize();
		if (!incomingPacket) {
			this.client.logger.error('Failed to deserialize ConnectionRequestAccepted');
			return;
		}

		const packet = new NewIncomingConnection();
		// @ts-expect-error - Address construction
		packet.serverAddress = new Address(incomingPacket.address.address, incomingPacket.address.port, 4);
		// @ts-expect-error - Address construction
		packet.internalAddress = new Address(
			this.client.socket.address().address,
			this.client.socket.address().port,
			6,
		);
		packet.incomingTimestamp = BigInt(Date.now());
		packet.serverTimestamp = incomingPacket.timestamp;

		try {
			const frame = new Frame();
			frame.reliability = Reliability.ReliableOrdered;
			frame.orderChannel = 0;
			frame.payload = packet.serialize();

			this.client.queue.sendFrame(frame, Priority.Immediate);

			// Emit raknet_connect to trigger login sequence
			this.client.emit('raknet_connect');
		} catch (error) {
			this.client.logger.error('Error sending NewIncomingConnection:', error);
		}
	}

	// ==================== GAME PACKET HANDLING ====================

	private handleGamePacketBatch(buffer: Buffer): void {
		try {
			// Strip the 0xFE game byte
			const payload = buffer.subarray(1);

			// Decode (decompress + unframe) into individual packet buffers
			const packets = decodeGamePackets(payload, this.client.compressionReady);

			// Route each packet to its handler
			for (const packetBuffer of packets) {
				handleGamePacket(packetBuffer, this.client);
			}
		} catch (error) {
			this.client.logger.error(`Error decoding game packet batch: ${error}`);
		}
	}
}
