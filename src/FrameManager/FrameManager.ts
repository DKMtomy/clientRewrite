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
import {
	DisconnectPacket,
	DisconnectReason,
	NetworkSettingsPacket,
	Packet as ProtocolPackets,
	RequestNetworkSettingsPacket,
} from '@serenityjs/protocol';
import { Client } from '@/Client';

export class FrameManager {
	private receivedFrameSequences = new Set<number>();
	private lostFrameSequences = new Set<number>();
	private inputHighestSequenceIndex = Array<number>(32).fill(0);
	private fragmentsQueue = new Map<number, Map<number, Frame>>();
	private inputOrderIndex = Array<number>(32).fill(0);
	private inputOrderingQueue = new Map<number, Map<number, Frame>>();
	private lastInputSequence = -1;

	constructor(private client: Client) {
		for (let i = 0; i < 32; i++) {
			this.inputOrderingQueue.set(i, new Map());
		}
	}

	public handleBatchError(error: Error | unknown, packetID: number): void {
		console.info('Error at packet', packetID);
		console.error(error);
	}

	public incomingBatch(buffer: Buffer): void {
		if (buffer.length <= 0) {
			console.error('Received an empty buffer!');
			return;
		}

		const header = buffer[0];

		switch (header) {
			case Packet.ConnectedPing:
				this.handleConnectedPing(buffer);
				break;
			case Packet.ConnectionRequestAccepted:
				this.handleConnectionRequestAccepted(buffer);
				break;
			case 254:
			case 0xfe: {
				this.handleGamePacket(buffer);
			}
			default:
				this.handleUnknownPacket(buffer, header);
				break;
		}
	}

	private handleGamePacket(buffer: Buffer) {
		switch (buffer[2]) {
			case ProtocolPackets.Disconnect: {
				const packet = new DisconnectPacket(buffer).deserialize();

				console.log('Disconnect packet received:', packet);
			}
		}
	}

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
			console.error('Failed to deserialize IncomingPacket!');
			return;
		}

		const packet = new NewIncomingConnection();
		//@ts-expect-error
		packet.serverAddress = new Address(incomingPacket.address.address, incomingPacket.address.port, 4);
		//@ts-expect-error
		packet.internalAddress = new Address(this.client.socket.address().address, this.client.socket.address().port, 6);
		packet.incomingTimestamp = BigInt(Date.now());
		packet.serverTimestamp = incomingPacket.timestamp;

		try {
			const frame = new Frame();
			frame.reliability = Reliability.ReliableOrdered;
			frame.orderChannel = 0;
			frame.payload = packet.serialize();

			if (!frame.payload) {
				console.error('Failed to serialize the packet!');
				return;
			}

			this.client.queue.sendFrame(frame, Priority.Immediate);
			this.client.emit('connect', this);
		} catch (error) {
			this.client.logger.log('Error in Frame Serialise');
			console.error(error);
		}
	}

	private handleUnknownPacket(buffer: Buffer, header: number): void {
		const id = header.toString(16).padStart(2, '0');
		this.client.logger.log(`Caught unhandled packet 0x${id}!`);
	}

	public handleFragment(frame: Frame): void {
		const fragmentQueue = this.fragmentsQueue.get(frame.fragmentId) || new Map<number, Frame>();
		fragmentQueue.set(frame.fragmentIndex, frame);

		if (fragmentQueue.size === frame.fragmentSize) {
			const stream = new BinaryStream();
			for (let i = 0; i < fragmentQueue.size; i++) {
				stream.writeBuffer(fragmentQueue.get(i)?.payload || Buffer.alloc(0));
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

	public handleFrame(frame: Frame): void {
		if (frame.isFragmented()) {
			this.handleFragment(frame);
			return;
		}

		if (frame.isOrdered()) {
			this.handleOrderedFrame(frame);
		} else {
			try {
				this.incomingBatch(frame.payload);
			} catch (error) {
				this.handleBatchError(error, frame.payload[0]);
			}
		}
	}

	private handleOrderedFrame(frame: Frame): void {
		const orderChannel = frame.orderChannel;
		const currentOrderIndex = this.inputOrderIndex[orderChannel];
		if (frame.orderIndex === currentOrderIndex) {
			this.inputOrderIndex[orderChannel]++;
			this.processFrame(frame);

			const outOfOrderQueue = this.inputOrderingQueue.get(orderChannel) as Map<number, Frame>;
			let nextOrderIndex = this.inputOrderIndex[orderChannel];
			while (outOfOrderQueue.has(nextOrderIndex)) {
				this.processFrame(outOfOrderQueue.get(nextOrderIndex) as Frame);
				outOfOrderQueue.delete(nextOrderIndex);
				nextOrderIndex++;
			}
		} else if (frame.orderIndex > currentOrderIndex) {
			this.inputOrderingQueue.get(orderChannel)?.set(frame.orderIndex, frame);
		}
	}

	private processFrame(frame: Frame): void {
		try {
			this.incomingBatch(frame.payload);
		} catch (error) {
			this.handleBatchError(error, frame.payload[0]);
		}
	}

	public handleIncomingFrameSet(buffer: Buffer): void {
		const frameset = new FrameSet(buffer).deserialize();
		if (frameset.sequence <= this.lastInputSequence) {
			this.client.logger.log(`Received out of order frameset ${frameset.sequence}`);
			return;
		}

		this.receivedFrameSequences.add(frameset.sequence);
		for (let i = this.lastInputSequence + 1; i < frameset.sequence; i++) {
			if (!this.receivedFrameSequences.has(i)) {
				this.lostFrameSequences.add(i);
			}
		}
		this.lastInputSequence = frameset.sequence;
		frameset.frames.forEach((frame) => this.handleFrame(frame));
	}
}
