/** A detached value projection. It performs no lookup and has no registry or
 * instantiation-service dependency; ordinary object reads remain independent. */
export interface BlueprintProvenanceFields {
  blueprintKey?: string;
  blueprintVersion?: number;
  blueprintContentSha256?: string;
  blueprintIdentitySha256?: string;
  instantiationId?: string;
  instantiatedAt?: string;
  instantiatedByPrincipalId?: string;
}
export function blueprintProvenanceOf(row: Record<string,any> | null | undefined): BlueprintProvenanceFields {
  if (!row?.instantiation_id) return {};
  return { blueprintKey:row.blueprint_key,blueprintVersion:row.blueprint_version,
    blueprintContentSha256:row.blueprint_content_sha256,blueprintIdentitySha256:row.blueprint_identity_sha256,
    instantiationId:row.instantiation_id,
    ...(row.instantiated_at ? {instantiatedAt:row.instantiated_at,instantiatedByPrincipalId:row.instantiated_by_principal_id}:{}),
  };
}
