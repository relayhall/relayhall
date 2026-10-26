import { computeMapRoutes, type MapRoutesInput } from './computeMapRoutes';

export function answerMapRoutes(request: { id: number; input: MapRoutesInput }) {
  try { return { id: request.id, ok: true as const, result: computeMapRoutes(request.input) }; }
  catch (error) { return { id: request.id, ok: false as const,
    error: error instanceof Error ? error.message : 'Map routes failed' }; }
}
// Importable by tests; worker module has no window and installs only its handler.
if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = event => self.postMessage(answerMapRoutes(event.data));
}
