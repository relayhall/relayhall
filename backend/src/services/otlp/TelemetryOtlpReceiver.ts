/**
 * TelemetryOtlpReceiver — one OTLP export through THE ONE ingest pipeline
 * (RH-TW1b slice 1, card `dac2ca71`).
 *
 * Each decoded record is translated into an `rh.ai.telemetry/1.0` envelope and
 * handed to `telemetryEnvelopeStore.store` — the same validate → redact → store
 * entry point the native endpoints use. There is no second write path: the
 * Tier-0 policy, the governed raw store, the quarantine and the dedupe
 * constraint are TW1a's, unchanged (run packet `bb83d616` §8: "a second write
 * path is the defect").
 *
 * PER-RECORD OUTCOMES, ONE EXPORT-LEVEL REFUSAL. A record refused by its
 * translation, by the descriptor's product list or by the validator is
 * counted and reported in `partial_success`; the export as a whole is still
 * accepted, because the OTLP contract makes a 200 with rejected counts the
 * honest answer for a partly usable batch. A DEPLOYMENT fault (the store
 * throws — an unconfigured pepper, an unreachable database) is different: it
 * refuses THE WHOLE EXPORT, stops the loop, and lets the producer retry the
 * batch intact. Answering 200 with a partial success there would tell an SDK
 * that the data was delivered when it was not (candidate A round 1, B1).
 * Records stored before the fault are deduplicated on the retry by their
 * content-hash identity.
 *
 * THE DROPPED-ATTRIBUTE COUNT IS A SUBTRACTION (evidence `aec6ab9f` §14, shape
 * 2): `attributesDropped = decoder.attributeEntries - carried`, where
 * `carried` is the number of DISTINCT producer entries whose mapped field is
 * present in a record the store returned. Duplicates, keyless entries, nested
 * kvlists, entries past the retention ceiling, refused records and fields the
 * policy dropped all fall out of that one subtraction.
 */
import type { TelemetryPrincipalBinding } from '../../types/TelemetryEnvelope';
import { telemetryEnvelopeStore, type TelemetryEnvelopeStore } from '../TelemetryEnvelopeStore';
import { telemetryQuarantineService, type TelemetryQuarantineService } from '../TelemetryQuarantineService';
import { productIsDeclared, type TelemetryDescriptorPolicy } from '../TelemetryDescriptorPolicy';
import { logCaughtWarning } from '../../utils/secretSafeLog';
import type { OtlpDecodedExport } from '../../utils/otlp/otlpDecode';
import {
  OTLP_ATTRIBUTE_PROFILE,
  otlpProductOf,
  recordHas,
  translateOtlpItem,
  type OtlpTranslationId,
} from './otlpTranslation';

export interface OtlpIngestOutcome {
  /** True when a deployment fault stopped the export; nothing after it was attempted. */
  deploymentFailure: boolean;
  records: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  /** Refusal code → count. */
  rejectedBy: Record<string, number>;
  /** Translation id → records it carried (accepted or duplicate). */
  translations: Partial<Record<OtlpTranslationId, number>>;
  attributeEntries: number;
  attributesCarried: number;
  attributesDropped: number;
  /** Latest source timestamp among carried records, in nanoseconds. */
  latestOccurredNs: bigint | null;
}

export class TelemetryOtlpReceiver {
  constructor(
    private readonly store: Pick<TelemetryEnvelopeStore, 'store'> = telemetryEnvelopeStore,
    private readonly quarantine: Pick<TelemetryQuarantineService, 'record'> = telemetryQuarantineService,
  ) {}

  async ingest(
    binding: TelemetryPrincipalBinding,
    descriptor: TelemetryDescriptorPolicy,
    decoded: OtlpDecodedExport,
    observedAt: Date,
  ): Promise<OtlpIngestOutcome> {
    const outcome: OtlpIngestOutcome = {
      deploymentFailure: false,
      records: decoded.items.length,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
      rejectedBy: {},
      translations: {},
      attributeEntries: decoded.attributeEntries,
      attributesCarried: 0,
      attributesDropped: 0,
      latestOccurredNs: null,
    };
    const carried = new Set<number>();
    const reject = (code: string): void => {
      outcome.rejected += 1;
      outcome.rejectedBy[code] = (outcome.rejectedBy[code] ?? 0) + 1;
    };

    for (const item of decoded.items) {
      const product = otlpProductOf(item);
      if (!product || !productIsDeclared(descriptor, product)) {
        // Not quarantined: the record may be perfectly well formed, and it is
        // the deployment's own declaration that refused it (§5.2).
        reject('OTLP_PRODUCT_NOT_DECLARED');
        continue;
      }

      const translated = translateOtlpItem(item, product);
      if (!translated.ok) { reject(translated.code); continue; }

      let stored;
      try {
        stored = await this.store.store(binding, translated.envelope, {
          observedAt,
          identity: 'content_hash',
          attributeAllowlist: OTLP_ATTRIBUTE_PROFILE,
        });
      } catch (err) {
        logCaughtWarning('[Telemetry OTLP] the ingest pipeline failed; refusing the whole export:', err);
        outcome.deploymentFailure = true;
        break;
      }

      if (!stored.accepted) {
        reject(stored.code);
        if (stored.stage === 'validation') {
          // The TRANSLATED envelope is quarantined — never the producer's raw
          // OTLP bytes — and the quarantine stores only its hash and shape.
          await this.quarantine.record(binding, {
            reasonCode: stored.code,
            field: stored.field,
            sourceKey: `${binding.connectorId}:${stored.code}`,
            payload: translated.envelope,
          }).catch((err) => logCaughtWarning('[Telemetry OTLP] quarantine write failed:', err));
        }
        continue;
      }

      if (stored.duplicate) outcome.duplicates += 1; else outcome.accepted += 1;
      outcome.translations[translated.translation] = (outcome.translations[translated.translation] ?? 0) + 1;
      for (const entry of translated.carried) {
        if (recordHas(stored.record, entry.path)) carried.add(entry.id);
      }
      if (translated.occurredNs !== null
        && (outcome.latestOccurredNs === null || translated.occurredNs > outcome.latestOccurredNs)) {
        outcome.latestOccurredNs = translated.occurredNs;
      }
    }

    outcome.attributesCarried = carried.size;
    outcome.attributesDropped = outcome.attributeEntries - carried.size;
    return outcome;
  }
}

export const telemetryOtlpReceiver = new TelemetryOtlpReceiver();
