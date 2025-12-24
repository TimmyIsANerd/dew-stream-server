/**
 * Room Manager for mediasoup SFU
 * Handles rooms, producers, and consumers
 */

import { createRouter, createWebRtcTransport } from './mediasoup-config.js';

// Room storage: tokenAddress => Room
const rooms = new Map();

/**
 * Room class - manages a single streaming room
 */
class Room {
  constructor(tokenAddress, router) {
    this.tokenAddress = tokenAddress;
    this.router = router;
    this.publisher = null; // { peerId, ws, producerTransport, producers: Map<kind, Producer> }
    this.viewers = new Map(); // peerId => { ws, consumerTransport, consumers: Map<producerId, Consumer> }
    this.createdAt = Date.now();
  }

  /**
   * Get router RTP capabilities for client
   */
  getRouterRtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  /**
   * Set publisher for this room
   */
  async setPublisher(peerId, ws) {
    if (this.publisher && this.publisher.peerId !== peerId) {
      throw new Error('Room already has a publisher');
    }
    
    // Create producer transport
    const { transport, params } = await createWebRtcTransport(this.router);
    
    this.publisher = {
      peerId,
      ws,
      producerTransport: transport,
      producers: new Map(),
    };
    
    console.log(`🎬 [Room ${this.tokenAddress}] Publisher set: ${peerId}`);
    return params;
  }

  /**
   * Connect publisher transport
   */
  async connectProducerTransport(dtlsParameters) {
    if (!this.publisher || !this.publisher.producerTransport) {
      throw new Error('No publisher transport');
    }
    await this.publisher.producerTransport.connect({ dtlsParameters });
    console.log(`🎬 [Room ${this.tokenAddress}] Producer transport connected`);
  }

  /**
   * Create producer (host starts sending media)
   */
  async produce(kind, rtpParameters, appData = {}) {
    if (!this.publisher || !this.publisher.producerTransport) {
      throw new Error('No publisher transport');
    }
    
    const producer = await this.publisher.producerTransport.produce({
      kind,
      rtpParameters,
      appData,
    });
    
    this.publisher.producers.set(kind, producer);
    
    producer.on('transportclose', () => {
      console.log(`🎬 [Room ${this.tokenAddress}] Producer transport closed for ${kind}`);
      this.publisher?.producers.delete(kind);
    });
    
    console.log(`🎬 [Room ${this.tokenAddress}] Producer created: ${kind} (id: ${producer.id})`);
    
    // Notify existing viewers to consume this new producer
    for (const [viewerId, viewer] of this.viewers) {
      if (viewer.ws.readyState === 1) {
        try {
          viewer.ws.send(JSON.stringify({
            type: 'new-producer',
            producerId: producer.id,
            kind,
          }));
        } catch (e) {
          console.error(`🎬 [Room] Failed to notify viewer ${viewerId}:`, e);
        }
      }
    }
    
    return { id: producer.id };
  }

  /**
   * Add viewer to room
   */
  async addViewer(peerId, ws) {
    // Create consumer transport
    const { transport, params } = await createWebRtcTransport(this.router);
    
    this.viewers.set(peerId, {
      ws,
      consumerTransport: transport,
      consumers: new Map(),
    });
    
    console.log(`🎬 [Room ${this.tokenAddress}] Viewer added: ${peerId} (total: ${this.viewers.size})`);
    return params;
  }

  /**
   * Connect viewer's consumer transport
   */
  async connectConsumerTransport(peerId, dtlsParameters) {
    const viewer = this.viewers.get(peerId);
    if (!viewer || !viewer.consumerTransport) {
      throw new Error('No consumer transport for viewer');
    }
    await viewer.consumerTransport.connect({ dtlsParameters });
    console.log(`🎬 [Room ${this.tokenAddress}] Consumer transport connected for ${peerId}`);
  }

  /**
   * Create consumer (viewer receives media)
   */
  async consume(peerId, producerId, rtpCapabilities) {
    const viewer = this.viewers.get(peerId);
    if (!viewer) {
      throw new Error('Viewer not found');
    }
    
    // Find the producer
    let producer = null;
    if (this.publisher) {
      for (const p of this.publisher.producers.values()) {
        if (p.id === producerId) {
          producer = p;
          break;
        }
      }
    }
    
    if (!producer) {
      throw new Error('Producer not found');
    }
    
    // Check if router can consume
    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error('Cannot consume - incompatible RTP capabilities');
    }
    
    const consumer = await viewer.consumerTransport.consume({
      producerId,
      rtpCapabilities,
      paused: true, // Start paused, client will resume
    });
    
    viewer.consumers.set(producerId, consumer);
    
    consumer.on('transportclose', () => {
      console.log(`🎬 [Room ${this.tokenAddress}] Consumer transport closed`);
      viewer.consumers.delete(producerId);
    });
    
    consumer.on('producerclose', () => {
      console.log(`🎬 [Room ${this.tokenAddress}] Producer closed, closing consumer`);
      viewer.consumers.delete(producerId);
      // Notify viewer
      if (viewer.ws.readyState === 1) {
        try {
          viewer.ws.send(JSON.stringify({
            type: 'producer-closed',
            producerId,
          }));
        } catch (e) {}
      }
    });
    
    console.log(`🎬 [Room ${this.tokenAddress}] Consumer created for ${peerId}: ${producer.kind}`);
    
    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    };
  }

  /**
   * Resume consumer (after client is ready)
   */
  async resumeConsumer(peerId, consumerId) {
    const viewer = this.viewers.get(peerId);
    if (!viewer) return;
    
    for (const consumer of viewer.consumers.values()) {
      if (consumer.id === consumerId) {
        await consumer.resume();
        console.log(`🎬 [Room ${this.tokenAddress}] Consumer resumed: ${consumerId}`);
        return;
      }
    }
  }

  /**
   * Get all producer IDs for a viewer to consume
   */
  getProducerIds() {
    if (!this.publisher) return [];
    return Array.from(this.publisher.producers.values()).map(p => ({
      id: p.id,
      kind: p.kind,
    }));
  }

  /**
   * Remove viewer from room
   */
  removeViewer(peerId) {
    const viewer = this.viewers.get(peerId);
    if (viewer) {
      // Close all consumers
      for (const consumer of viewer.consumers.values()) {
        try { consumer.close(); } catch {}
      }
      // Close transport
      try { viewer.consumerTransport?.close(); } catch {}
      this.viewers.delete(peerId);
      console.log(`🎬 [Room ${this.tokenAddress}] Viewer removed: ${peerId} (remaining: ${this.viewers.size})`);
    }
    return this.viewers.size;
  }

  /**
   * Remove publisher and close room
   */
  removePublisher() {
    if (this.publisher) {
      // Close all producers
      for (const producer of this.publisher.producers.values()) {
        try { producer.close(); } catch {}
      }
      // Close transport
      try { this.publisher.producerTransport?.close(); } catch {}
      this.publisher = null;
      console.log(`🎬 [Room ${this.tokenAddress}] Publisher removed`);
    }
  }

  /**
   * Get viewer count
   */
  getViewerCount() {
    return this.viewers.size;
  }

  /**
   * Check if room has active publisher
   */
  hasPublisher() {
    return this.publisher !== null && this.publisher.producers.size > 0;
  }

  /**
   * Close room and cleanup all resources
   */
  close() {
    // Close all viewers
    for (const [peerId] of this.viewers) {
      this.removeViewer(peerId);
    }
    // Close publisher
    this.removePublisher();
    // Close router
    try { this.router.close(); } catch {}
    console.log(`🎬 [Room ${this.tokenAddress}] Room closed`);
  }
}

/**
 * Get or create a room for a token
 */
async function getOrCreateRoom(tokenAddress) {
  if (rooms.has(tokenAddress)) {
    return rooms.get(tokenAddress);
  }
  
  const router = await createRouter();
  const room = new Room(tokenAddress, router);
  rooms.set(tokenAddress, room);
  console.log(`🎬 [RoomManager] Room created: ${tokenAddress}`);
  return room;
}

/**
 * Get existing room
 */
function getRoom(tokenAddress) {
  return rooms.get(tokenAddress);
}

/**
 * Delete room
 */
function deleteRoom(tokenAddress) {
  const room = rooms.get(tokenAddress);
  if (room) {
    room.close();
    rooms.delete(tokenAddress);
    console.log(`🎬 [RoomManager] Room deleted: ${tokenAddress}`);
  }
}

/**
 * Get all rooms (for monitoring)
 */
function getAllRooms() {
  return Array.from(rooms.entries()).map(([tokenAddress, room]) => ({
    tokenAddress,
    hasPublisher: room.hasPublisher(),
    viewerCount: room.getViewerCount(),
    createdAt: room.createdAt,
  }));
}

export {
  Room,
  getOrCreateRoom,
  getRoom,
  deleteRoom,
  getAllRooms,
};
