import type { MapPlaneInput } from './computeMapPlane';
import type { PlaneLayoutResult } from './mapPlaneModel';

export type MapPlaneChannel = 'layout' | 'switch';
export interface MapPlaneRequest {
  id: number;
  channel: MapPlaneChannel;
  input: MapPlaneInput;
}
export type MapPlaneReply = {
  id: number;
  channel: MapPlaneChannel;
} & ({ ok: true; result: PlaneLayoutResult } | { ok: false; error: string });
