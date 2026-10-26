import { computeMapPlane } from './computeMapPlane';
import type { MapPlaneReply, MapPlaneRequest } from './mapPlaneWorkerProtocol';

// This module is loaded only as a dedicated same-origin module worker.
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<MapPlaneRequest>) => void) | null;
  postMessage: (reply: MapPlaneReply) => void;
};
worker.onmessage = ({ data }) => {
  try {
    worker.postMessage({ id: data.id, channel: data.channel, ok: true, result: computeMapPlane(data.input) });
  } catch (error) {
    worker.postMessage({ id: data.id, channel: data.channel, ok: false,
      error: error instanceof Error ? error.message : 'Map calculation failed' });
  }
};
