import { Client } from '@/Client';
import { Frame, FrameSet, Priority, Reliability } from '@serenityjs/raknet';

export class Queue {
	public outputBackupQueue = new Map<number, Array<Frame>>();
	public outputOrderIndex: Array<number>;
	public outputSequenceIndex: Array<number>;
	public outputFrameQueue: FrameSet;
	public outputSequence = 0;
	public outputReliableIndex = 0;
	public outputFragmentIndex = 0;
	public mtu: number = 1492;

	constructor(private client: Client) {
		this.outputFrameQueue = new FrameSet();
		this.outputFrameQueue.frames = [];
		this.outputOrderIndex = Array.from<number>({ length: 32 }).fill(0);
		this.outputSequenceIndex = Array.from<number>({ length: 32 }).fill(0);
	}

	/**
	 * Sends a frame to the connection.
	 * Handles sequencing, ordering, reliability indexing, and fragmentation.
	 */
	public sendFrame(frame: Frame, priority: Priority): void {
		if (frame.isSequenced()) {
			frame.orderIndex = this.outputOrderIndex[frame.orderChannel] as number;
			frame.sequenceIndex = (this.outputSequenceIndex[frame.orderChannel] as number)++;
		} else if (frame.isOrderExclusive()) {
			frame.orderIndex = (this.outputOrderIndex[frame.orderChannel] as number)++;
			this.outputSequenceIndex[frame.orderChannel] = 0;
		}

		// Set the reliable index
		frame.reliableIndex = this.outputReliableIndex++;

		// Split packet if bigger than MTU size
		const maxSize = this.mtu - 6 - 23;
		if (frame.payload.byteLength > maxSize) {
			const buffer = Buffer.from(frame.payload);
			const fragmentId = this.outputFragmentIndex++ % 65_536;
			const fragmentSize = Math.ceil(buffer.byteLength / maxSize);

			for (let index = 0; index < buffer.byteLength; index += maxSize) {
				if (index !== 0) frame.reliableIndex = this.outputReliableIndex++;

				const fragmentFrame = new Frame();
				fragmentFrame.reliability = frame.reliability;
				fragmentFrame.orderChannel = frame.orderChannel;
				fragmentFrame.orderIndex = frame.orderIndex;
				fragmentFrame.reliableIndex = frame.reliableIndex;
				fragmentFrame.payload = buffer.subarray(index, index + maxSize);
				fragmentFrame.fragmentIndex = index / maxSize;
				fragmentFrame.fragmentId = fragmentId;
				fragmentFrame.fragmentSize = fragmentSize;

				this.addFrameToQueue(fragmentFrame, priority || Priority.Normal);
			}
		} else {
			return this.addFrameToQueue(frame, priority);
		}
	}

	private addFrameToQueue(frame: Frame, priority: Priority): void {
		let length = 4;
		for (const queuedFrame of this.outputFrameQueue.frames) {
			length += queuedFrame.getByteLength();
		}

		// Flush if adding this frame would exceed MTU
		if (length + frame.getByteLength() > this.mtu - 36) {
			this.sendFrameQueue();
		}

		this.outputFrameQueue.frames.push(frame);

		// Immediate priority flushes right away
		if (priority === Priority.Immediate) return this.sendFrameQueue();
	}

	/**
	 * Flushes the output frame queue. Called on each tick and on immediate priority sends.
	 */
	public sendFrameQueue(): void {
		if (this.outputFrameQueue.frames.length > 0) {
			this.outputFrameQueue.sequence = this.outputSequence++;
			this.sendFrameSet(this.outputFrameQueue);

			this.outputFrameQueue = new FrameSet();
			this.outputFrameQueue.frames = [];
		}
	}

	/**
	 * Sends a frame set to the connection and backs up reliable frames.
	 */
	private sendFrameSet(frameset: FrameSet): void {
		this.client.send(frameset.serialize());

		// Backup reliable frames for potential retransmission on NACK
		const reliableFrames = frameset.frames.filter((frame) => frame.isReliable());
		if (reliableFrames.length > 0) {
			this.outputBackupQueue.set(frameset.sequence, reliableFrames);
		}
	}
}
