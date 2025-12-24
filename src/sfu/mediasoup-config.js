/**
 * mediasoup SFU configuration
 * Handles Worker creation and Router settings
 */

import mediasoup from 'mediasoup';
import os from 'os';

// Store workers for round-robin assignment
const workers = [];
let nextWorkerIndex = 0;

// mediasoup Worker settings
const workerSettings = {
  logLevel: 'warn',
  logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
  rtcMinPort: parseInt(process.env.MEDIASOUP_MIN_PORT) || 10000,
  rtcMaxPort: parseInt(process.env.MEDIASOUP_MAX_PORT) || 10100,
};

// Router media codecs - what the SFU can handle
const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: {
      'profile-id': 2,
      'x-google-start-bitrate': 1000,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '4d0032',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
];

// WebRTC transport settings - computed at runtime to ensure env vars are loaded
function getWebRtcTransportSettings() {
  const announcedIp = process.env.MEDIASOUP_ANNOUNCED_IP || null;
  const listenIp = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
  
  console.log(`🎬 [mediasoup] Transport settings - listenIp: ${listenIp}, announcedIp: ${announcedIp}`);
  
  return {
    listenIps: [
      {
        ip: listenIp,
        announcedIp: announcedIp,
      },
    ],
    initialAvailableOutgoingBitrate: 1000000,
    minimumAvailableOutgoingBitrate: 600000,
    maxSctpMessageSize: 262144,
    maxIncomingBitrate: 3000000,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  };
}

/**
 * Initialize mediasoup workers
 * Creates one worker per CPU core (or configured amount)
 */
async function initializeWorkers() {
  const numWorkers = parseInt(process.env.MEDIASOUP_NUM_WORKERS) || Math.min(os.cpus().length, 4);
  
  console.log(`🎬 [mediasoup] Initializing ${numWorkers} worker(s)...`);
  
  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker(workerSettings);
    
    worker.on('died', (error) => {
      console.error(`🎬 [mediasoup] Worker ${i} died:`, error);
      // Remove dead worker and create new one
      const idx = workers.indexOf(worker);
      if (idx !== -1) workers.splice(idx, 1);
      // Attempt to create replacement worker
      setTimeout(async () => {
        try {
          const newWorker = await mediasoup.createWorker(workerSettings);
          workers.push(newWorker);
          console.log(`🎬 [mediasoup] Replacement worker created`);
        } catch (e) {
          console.error(`🎬 [mediasoup] Failed to create replacement worker:`, e);
        }
      }, 2000);
    });
    
    workers.push(worker);
    console.log(`🎬 [mediasoup] Worker ${i} created (pid: ${worker.pid})`);
  }
  
  return workers;
}

/**
 * Get next available worker (round-robin)
 */
function getNextWorker() {
  if (workers.length === 0) {
    throw new Error('No mediasoup workers available');
  }
  const worker = workers[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
  return worker;
}

/**
 * Create a new Router for a room
 */
async function createRouter() {
  const worker = getNextWorker();
  const router = await worker.createRouter({ mediaCodecs });
  console.log(`🎬 [mediasoup] Router created (id: ${router.id})`);
  return router;
}

/**
 * Create WebRTC transport for producer or consumer
 */
async function createWebRtcTransport(router) {
  const settings = getWebRtcTransportSettings();
  
  console.log(`🎬 [mediasoup] Creating WebRTC transport with settings:`, {
    listenIps: settings.listenIps,
    enableUdp: settings.enableUdp,
    enableTcp: settings.enableTcp,
  });
  
  const transport = await router.createWebRtcTransport(settings);
  
  console.log(`🎬 [mediasoup] Transport created:`, {
    id: transport.id,
    iceCandidates: transport.iceCandidates,
    iceState: transport.iceState,
    dtlsState: transport.dtlsState,
  });
  
  // Monitor transport state changes
  transport.on('icestatechange', (iceState) => {
    console.log(`🎬 [mediasoup] Transport ${transport.id} ICE state: ${iceState}`);
  });
  
  transport.on('dtlsstatechange', (dtlsState) => {
    console.log(`🎬 [mediasoup] Transport ${transport.id} DTLS state: ${dtlsState}`);
    if (dtlsState === 'failed' || dtlsState === 'closed') {
      console.warn(`🎬 [mediasoup] Transport ${transport.id} DTLS failed/closed`);
    }
  });
  
  transport.on('sctpstatechange', (sctpState) => {
    console.log(`🎬 [mediasoup] Transport ${transport.id} SCTP state: ${sctpState}`);
  });
  
  // Set max incoming bitrate
  if (settings.maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(settings.maxIncomingBitrate);
    } catch (e) {
      // Ignore if not supported
    }
  }
  
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    },
  };
}

export {
  initializeWorkers,
  getNextWorker,
  createRouter,
  createWebRtcTransport,
  mediaCodecs,
  workers,
};
