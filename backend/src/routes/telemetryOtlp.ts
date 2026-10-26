/**
 * The OTLP/HTTP receivers and the ingest discovery response (RH-TW1b slice 1,
 * card `dac2ca71`; TELEMETRY-DESIGN `7d5c0cdc` §3.1 item 1, §4.8).
 *
 *   POST /telemetry/otlp/v1/traces | logs | metrics   protobuf or JSON
 *   POST /telemetry/otlp/:version/:signal             any other version or signal:
 *                                                     refused WITH the advertisement
 *   GET  /telemetry/discovery                         what this receiver accepts
 *
 * MOUNTED FLAT on the telemetry router — `registerOtlpRoutes` adds routes to
 * that router rather than mounting a prefixed sub-router. That was first a
 * workaround: the route census (`utils/routeFamilies.collectRouteLayers`)
 * once dropped a nested router's prefix, and candidate A's lane portal, which
 * mounted these receivers as a sub-router, refused to boot. The census now
 * carries a nested prefix at any depth (card `2c000125`), so a sub-router
 * would census to these same full paths; the flat mount stays because the
 * route map (`scopeMap`) and the families are spelled by full path anyway.
 *
 * THE ORDER IS THE CONTRACT, as on `/events`: derive the principal (§4.1/§5.1)
 * before anything is parsed into records; spend the receiver limit (D6) on the
 * signal's own surface; decode; run every record through THE ONE pipeline;
 * record adapter health; answer in the request's encoding.
 *
 * OTLP/gRPC (slice 2, absorbed card `928586a6`) is a SECOND LISTENER that
 * terminates gRPC and dispatches the request message in process, as an
 * `application/x-protobuf` POST, through THIS router to these same handlers
 * (`services/otlp/OtlpGrpcIngress`). The handlers learn the transport from one
 * server-side stamp (`OTLP_GRPC_INGRESS`, a symbol no client input can set) and
 * use it for one thing: the adapter-health source, `otlp-grpc` or `otlp-http`.
 * Every refusal also leaves its code in `res.locals`, which the gRPC ingress
 * carries as a trailer; an HTTP client sees no difference.
 */
import express, { Router, Request, Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { telemetryPrincipalService } from '../services/TelemetryPrincipalService';
import { telemetryRateLimitService, type TelemetryRateSurface } from '../services/TelemetryRateLimitService';
import { auditService } from '../services/AuditService';
import {
  telemetryAdapterHealthService,
  TELEMETRY_ADAPTER_SOURCES,
  TELEMETRY_OTLP_ACCEPTED_VERSIONS,
  type TelemetryAdapterSource,
} from '../services/TelemetryAdapterHealthService';
import { telemetryOtlpReceiver } from '../services/otlp/TelemetryOtlpReceiver';
import {
  OTLP_TRANSLATIONS, OTLP_TRANSLATION_SUPPORT, OTLP_TRANSLATION_VERSION,
} from '../services/otlp/otlpTranslation';
import {
  tryDecodeOtlp, OTLP_MAX_RECORDS, OTLP_SIGNALS,
  type OtlpDecodedExport, type OtlpDecodeErrorCode, type OtlpSignal,
} from '../utils/otlp/otlpDecode';
import {
  OTLP_JSON_TYPE, OTLP_PROTOBUF_MAX_BYTES, OTLP_PROTOBUF_TYPE, OTLP_STATUS,
  otlpEncodingOf, otlpProtobufBodyOptions, otlpRejectionSummary, otlpStatusBody, otlpSuccessBody,
  type OtlpEncoding,
} from '../utils/otlp/otlpHttp';
import {
  OTLP_GRPC_ACCEPTED_ENCODINGS, OTLP_GRPC_INGRESS, OTLP_GRPC_MAX_MESSAGE_BYTES, OTLP_GRPC_METHOD_PATHS,
  OTLP_REFUSAL_CODE_LOCAL, otlpGrpcListening,
} from '../utils/otlp/otlpGrpc';
import { telemetryAcceptedMajorsAdvertisement } from '../utils/telemetryEnvelopeValidator';
import { jsonBodyOptions } from '../utils/jsonBodyTypes';
import { logCaughtFailure, logCaughtWarning } from '../utils/secretSafeLog';
import { TELEMETRY_BATCH_MAX_BYTES, TELEMETRY_BATCH_MAX_RECORDS, NDJSON_BODY_TYPES } from '../utils/ndjsonBodyTypes';

const SURFACE: Readonly<Record<OtlpSignal, TelemetryRateSurface>> = {
  traces: 'otlp_traces',
  logs: 'otlp_logs',
  metrics: 'otlp_metrics',
};

/** The answer to a body the receiver cannot read: fixed sentences, never the decoder's text. */
const DECODE_REFUSALS: Readonly<Record<OtlpDecodeErrorCode, { status: number; message: string }>> = {
  OTLP_UNDECODABLE: {
    status: 400,
    message: 'the body is not an OTLP export request of this signal in the declared encoding',
  },
  OTLP_TOO_MANY_RECORDS: {
    status: 413,
    message: `an OTLP export may carry at most ${OTLP_MAX_RECORDS} records; split the batch`,
  },
};

/** How long a producer should wait before retrying a deployment-fault refusal. */
const DEPLOYMENT_RETRY_AFTER_SECONDS = 30;

/** The accepted-version advertisement every OTLP refusal and the discovery response carry. */
export function otlpAdvertisement(): Record<string, unknown> {
  return {
    ...telemetryAcceptedMajorsAdvertisement(),
    acceptedOtlpVersions: TELEMETRY_OTLP_ACCEPTED_VERSIONS,
    acceptedOtlpSignals: OTLP_SIGNALS,
  };
}

function send(res: Response, encoding: OtlpEncoding, status: number, body: Buffer | Record<string, unknown>): void {
  if (encoding === 'protobuf') {
    res.status(status).type(OTLP_PROTOBUF_TYPE).send(body as Buffer);
  } else {
    res.status(status).type(OTLP_JSON_TYPE).send(JSON.stringify(body));
  }
}

/**
 * A refusal: a `google.rpc.Status` in the request's encoding, and its refusal
 * code left in `res.locals` for the gRPC ingress (a protobuf Status has no
 * field for it). `res.locals` is never serialised, so HTTP answers are unchanged.
 */
function refuse(
  res: Response, encoding: OtlpEncoding, status: number, grpcCode: number, message: string,
  extra: { rhCode: string } & Record<string, unknown>,
): void {
  res.locals[OTLP_REFUSAL_CODE_LOCAL] = extra.rhCode;
  send(res, encoding, status, otlpStatusBody(encoding, grpcCode, message, extra));
}

/** The adapter-health source for this request: the gRPC ingress stamps its own. */
function adapterSourceOf(req: Request): TelemetryAdapterSource {
  return (req as unknown as Record<symbol, unknown>)[OTLP_GRPC_INGRESS] === true
    ? TELEMETRY_ADAPTER_SOURCES.otlpGrpc
    : TELEMETRY_ADAPTER_SOURCES.otlpHttp;
}

function auditRefusal(req: AuthRequest, code: string, surface: string, audit: Record<string, unknown>): void {
  void auditService.record({
    action: 'telemetry.envelope.refused',
    outcome: 'denied',
    actor: {
      principalId: req.principal?.id ?? null,
      handle: req.principal?.handle ?? 'unknown',
      authMethod: req.authMethod ?? 'unknown',
      credentialId: req.credentialId ?? null,
    },
    resourceType: 'telemetry_envelope',
    metadata: { code, surface, ...audit },
  }).catch((err) => logCaughtWarning('[Telemetry OTLP] refusal audit write failed:', err));
}

async function receive(signal: OtlpSignal, req: Request, res: Response): Promise<void> {
  const authReq = req as AuthRequest;
  const encoding = otlpEncodingOf(req.headers['content-type']);
  // A media type this receiver does not speak is answered in JSON, the one
  // encoding every client can read, with what WOULD be accepted.
  const answerIn: OtlpEncoding = encoding ?? 'json';
  try {
    // ---- 1. principal derivation (§4.1 / §5.1) ---------------------------
    const derived = await telemetryPrincipalService.derive({
      actingPrincipalId: authReq.principal?.id,
      delegationLinks: authReq.delegationLinks,
    });
    if (!derived.ok) {
      auditRefusal(authReq, derived.code, SURFACE[signal], derived.audit);
      refuse(res, answerIn, derived.code === 'TELEMETRY_PRINCIPAL_REQUIRED' ? 400 : 403,
        OTLP_STATUS.PERMISSION_DENIED, derived.message, { rhCode: derived.code });
      return;
    }

    if (!encoding) {
      refuse(res, 'json', 415, OTLP_STATUS.INVALID_ARGUMENT,
        `OTLP/HTTP is accepted as ${OTLP_PROTOBUF_TYPE} or ${OTLP_JSON_TYPE}`,
        { rhCode: 'UNSUPPORTED_MEDIA_TYPE', acceptedTypes: [OTLP_PROTOBUF_TYPE, OTLP_JSON_TYPE] });
      return;
    }

    // ---- 2. the receiver limit, on this signal's own surface (D6) ---------
    const rateKey = derived.binding.agentId ?? derived.binding.connectorId;
    const decision = await telemetryRateLimitService.tryAccept(rateKey, SURFACE[signal]);
    if (!decision.accepted) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
      refuse(res, encoding, 429, OTLP_STATUS.RESOURCE_EXHAUSTED,
        `OTLP ${signal} ingest rate limit: one accepted export per interval per principal`,
        { rhCode: 'RATE_LIMITED', retryAfterMs: decision.retryAfterMs });
      return;
    }

    // ---- 3. decode --------------------------------------------------------
    const decodeResult = tryDecodeOtlp(signal, encoding, req.body);
    if (!decodeResult.ok) {
      const refusal = DECODE_REFUSALS[decodeResult.code];
      refuse(res, encoding, refusal.status, OTLP_STATUS.INVALID_ARGUMENT, refusal.message, { rhCode: decodeResult.code });
      return;
    }
    const decoded: OtlpDecodedExport = decodeResult.decoded;

    // ---- 4. every record through THE ONE pipeline -------------------------
    const observedAt = new Date();
    const outcome = await telemetryOtlpReceiver.ingest(derived.binding, derived.descriptor, decoded, observedAt);

    // ---- 5. adapter health (§8.3) — never changes the answer --------------
    const counts: Record<string, number> = {
      requests: 1,
      [`signal.${signal}`]: 1,
      'records.accepted': outcome.accepted,
      'records.duplicate': outcome.duplicates,
      'records.rejected': outcome.rejected,
      'attributes.entries': outcome.attributeEntries,
      'attributes.carried': outcome.attributesCarried,
      'attributes.dropped': outcome.attributesDropped,
      'deployment.failures': outcome.deploymentFailure ? 1 : 0,
    };
    for (const [code, count] of Object.entries(outcome.rejectedBy)) counts[`rejected.${code}`] = count;
    for (const [translation, count] of Object.entries(outcome.translations)) counts[`translation.${translation}`] = count ?? 0;
    const observedNs = BigInt(observedAt.getTime()) * 1_000_000n;
    const latest = outcome.latestOccurredNs;
    await telemetryAdapterHealthService.record({
      source: adapterSourceOf(req),
      connectorId: derived.binding.connectorId,
      adapterVersion: OTLP_TRANSLATION_VERSION,
      counts,
      reasonCode: outcome.deploymentFailure ? 'DEPLOYMENT_UNAVAILABLE'
        : Object.entries(outcome.rejectedBy).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      accepted: outcome.accepted + outcome.duplicates,
      rejected: outcome.rejected + (outcome.deploymentFailure ? 1 : 0),
      lastSourceAt: latest === null ? null : new Date(Number(latest / 1_000_000n)),
      clockSkewMs: latest === null ? null : Number((observedNs - latest) / 1_000_000n),
      facts: { lastSignal: signal, lastEncoding: encoding },
    }, observedAt).catch((err) => logCaughtWarning('[Telemetry OTLP] adapter health write failed:', err));

    if (outcome.deploymentFailure) {
      // B1: a deployment fault refuses the WHOLE export, so the producer
      // retries the batch intact; already-stored records dedupe on the retry.
      res.setHeader('Retry-After', String(DEPLOYMENT_RETRY_AFTER_SECONDS));
      refuse(res, encoding, 503, OTLP_STATUS.UNAVAILABLE,
        'the telemetry ingest pipeline is unavailable; retry the export', { rhCode: 'TELEMETRY_INGEST_UNAVAILABLE' });
      return;
    }

    send(res, encoding, 200, otlpSuccessBody(encoding, signal, outcome.rejected, otlpRejectionSummary(outcome.rejectedBy)));
  } catch (err) {
    const errorId = logCaughtFailure(`[Telemetry OTLP] ${signal} export failed:`, err);
    refuse(res, answerIn, 500, OTLP_STATUS.UNAVAILABLE,
      'Failed to ingest the OTLP export', { rhCode: 'TELEMETRY_INGEST_FAILED', errorId });
  }
}

/**
 * Any OTLP path this receiver does not serve: an unknown protocol VERSION or
 * an unknown SIGNAL. Refused with the accepted-version advertisement (§3.1),
 * and — when the presenter is a telemetry principal — counted on its adapter
 * health row, so a producer pinned to a version this deployment does not speak
 * is visible to the operator rather than only to the producer's own log.
 */
async function unsupported(req: Request, res: Response): Promise<void> {
  const authReq = req as AuthRequest;
  const encoding = otlpEncodingOf(req.headers['content-type']) ?? 'json';
  const version = String(req.params.version ?? '');
  const versionAccepted = TELEMETRY_OTLP_ACCEPTED_VERSIONS.includes(version);
  const code = versionAccepted ? 'OTLP_SIGNAL_NOT_ACCEPTED' : 'OTLP_VERSION_NOT_ACCEPTED';
  try {
    const derived = await telemetryPrincipalService.derive({
      actingPrincipalId: authReq.principal?.id,
      delegationLinks: authReq.delegationLinks,
    });
    if (derived.ok) {
      await telemetryAdapterHealthService.record({
        source: adapterSourceOf(req),
        connectorId: derived.binding.connectorId,
        adapterVersion: OTLP_TRANSLATION_VERSION,
        counts: { requests: 1, [versionAccepted ? 'unsupported.signal' : 'unsupported.version']: 1 },
        reasonCode: code,
        accepted: 0,
        rejected: 1,
        lastSourceAt: null,
        clockSkewMs: null,
      }).catch((err) => logCaughtWarning('[Telemetry OTLP] adapter health write failed:', err));
    }
  } catch (err) {
    logCaughtWarning('[Telemetry OTLP] unsupported-version accounting failed:', err);
  }
  refuse(res, encoding, 404, OTLP_STATUS.NOT_FOUND,
    versionAccepted
      ? `this receiver accepts the OTLP signals ${OTLP_SIGNALS.join(', ')}`
      : `this receiver accepts OTLP ${TELEMETRY_OTLP_ACCEPTED_VERSIONS.join(', ')}; park the export rather than retry it`,
    { rhCode: code, ...otlpAdvertisement() });
}

/** Add the OTLP routes and the discovery route to the telemetry router, FLAT. */
export function registerOtlpRoutes(router: Router): void {
  for (const signal of OTLP_SIGNALS) {
    router.post(`/otlp/v1/${signal}`, express.raw(otlpProtobufBodyOptions),
      (req: Request, res: Response) => receive(signal, req, res));
  }
  router.post('/otlp/:version/:signal', unsupported);

  /**
   * DISCOVERY (§3.1): what this receiver accepts, so a reporter can check
   * before it sends rather than learn from a refusal. The same advertisement
   * every rejection carries, plus the surfaces and their bounds. Nothing in it
   * is per-caller.
   */
  router.get('/discovery', (_req: Request, res: Response) => {
    res.json({
      success: true,
      ...otlpAdvertisement(),
      surfaces: {
        events: { path: '/telemetry/events', contentTypes: ['application/json'], maxBytes: jsonBodyOptions.limit },
        eventsBatch: {
          path: '/telemetry/events/batch', contentTypes: [...NDJSON_BODY_TYPES],
          maxBytes: TELEMETRY_BATCH_MAX_BYTES, maxRecords: TELEMETRY_BATCH_MAX_RECORDS,
        },
        otlp: {
          paths: OTLP_SIGNALS.map((signal) => `/telemetry/otlp/v1/${signal}`),
          contentTypes: [OTLP_PROTOBUF_TYPE, OTLP_JSON_TYPE],
          maxBytes: { protobuf: OTLP_PROTOBUF_MAX_BYTES, json: jsonBodyOptions.limit },
          maxRecords: OTLP_MAX_RECORDS,
          translations: OTLP_TRANSLATIONS.map((id) => ({ id, supportLevel: OTLP_TRANSLATION_SUPPORT[id] })),
          translationVersion: OTLP_TRANSLATION_VERSION,
          // The gRPC receiver is a second listener on its own port, which a
          // deployment may or may not publish: `enabled` says whether THIS
          // process is serving it. The published port is the deployment's to
          // document; it is not knowable from inside the container.
          grpc: {
            enabled: otlpGrpcListening(),
            methods: OTLP_GRPC_METHOD_PATHS,
            maxBytes: OTLP_GRPC_MAX_MESSAGE_BYTES,
            maxRecords: OTLP_MAX_RECORDS,
            compression: OTLP_GRPC_ACCEPTED_ENCODINGS,
          },
        },
      },
    });
  });
}
