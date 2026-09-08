/**
 * The bounded dynamic execution-profile editor (RH-P2.2, task a44b9b06).
 *
 * Service-first: pick "Basic" (no Connector — model/thinking stay the
 * board-native fields, rendered by the host modal) or a published Connector,
 * after which every remaining field is DISCOVERED from that Connector's
 * pinned capability descriptor and rendered by type:
 * enum → select · boolean → checkbox · number/string → input ·
 * secretReference → select over the connector-declared reference NAMES
 * (never free-form; never secret bytes — RH-DESIGN.5 R5) ·
 * resourceSelector → input (v1).
 * One level of per-option parameters (E-17). The board renders and
 * validates shape client-side for usability; the server re-validates
 * against the pinned version and answers stale-descriptor errors when a
 * newer version published mid-edit.
 */
import { useEffect } from 'react';
import { Select } from '../ui/Select';
import { TaskExecutionProfile } from '../../types/task';
import {
  useConnectors,
  useConnectorDescriptor,
  DescriptorField,
} from '../../hooks/useConnectorOptions';

interface Props {
  value: TaskExecutionProfile | null;
  onChange: (profile: TaskExecutionProfile | null) => void;
}

type Scalar = string | number | boolean;

function fieldValue(field: DescriptorField, raw: Scalar | undefined): Scalar {
  if (raw !== undefined) return raw;
  if (field.default !== undefined) return field.default;
  if (field.type === 'boolean') return false;
  return '';
}

function coerce(field: DescriptorField, raw: string): Scalar {
  if (field.type === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

function FieldControl({
  field,
  raw,
  onSet,
  idPrefix,
}: {
  field: DescriptorField;
  raw: Scalar | undefined;
  onSet: (value: Scalar | undefined) => void;
  idPrefix: string;
}) {
  const inputId = `${idPrefix}-${field.key}`;
  const label = field.label || field.key;
  const current = fieldValue(field, raw);

  return (
    <div className="task-detail-ai-field execution-profile-field">
      <label htmlFor={inputId}>
        {label}
        {field.required ? ' *' : ''}
      </label>
      {field.type === 'enum' || field.type === 'secretReference' ? (
        <Select
          id={inputId}
          value={String(current)}
          onChange={(e) => onSet(e.target.value === '' ? undefined : e.target.value)}
        >
          <option value="">{field.required ? 'Select…' : '(unset)'}</option>
          {field.type === 'enum'
            ? (field.values || []).map((v) => (
                <option key={v.value} value={v.value}>{v.label || v.value}</option>
              ))
            : (field.allowedReferences || []).map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
        </Select>
      ) : field.type === 'boolean' ? (
        <input
          id={inputId}
          type="checkbox"
          checked={current === true}
          onChange={(e) => onSet(e.target.checked)}
        />
      ) : (
        <input
          id={inputId}
          type={field.type === 'number' ? 'number' : 'text'}
          value={String(current)}
          onChange={(e) => onSet(e.target.value === '' ? undefined : coerce(field, e.target.value))}
        />
      )}
      {field.help ? <p className="task-detail-hint execution-profile-help">{field.help}</p> : null}
    </div>
  );
}

export default function ExecutionProfileEditor({ value, onChange }: Props) {
  const { connectors, loading: connectorsLoading, error: connectorsError } = useConnectors();
  const serviceId = value?.serviceId ?? null;
  const { descriptor, loading: descriptorLoading, error: descriptorError } = useConnectorDescriptor(serviceId);

  // Materialize declared defaults into the ACTUAL profile payload (review
  // 66c78a1d F3): what the form shows selected must be what submits, or a
  // required defaulted option renders complete yet fails validation.
  // Secret references are never defaulted (they carry no defaults by
  // contract) and user-set values are never overwritten.
  useEffect(() => {
    if (!value || !descriptor || descriptor.retired) return;
    const options = { ...value.options };
    let parameters = value.parameters ? { ...value.parameters } : undefined;
    let changed = false;
    for (const field of descriptor.options) {
      if (field.default !== undefined && field.type !== 'secretReference' && !(field.key in options)) {
        options[field.key] = field.default;
        changed = true;
      }
      if (field.parameters && field.key in options) {
        for (const param of field.parameters) {
          const existing = parameters?.[field.key]?.[param.key];
          if (param.default !== undefined && param.type !== 'secretReference' && existing === undefined) {
            parameters = { ...(parameters || {}), [field.key]: { ...(parameters?.[field.key] || {}), [param.key]: param.default } };
            changed = true;
          }
        }
      }
    }
    if (changed || value.descriptorVersion !== descriptor.version) {
      onChange({
        ...value,
        descriptorVersion: descriptor.version,
        options,
        ...(parameters && Object.keys(parameters).length > 0 ? { parameters } : {}),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descriptor, serviceId]);

  const selectService = (nextServiceId: string) => {
    if (!nextServiceId) {
      onChange(null);
      return;
    }
    onChange({ serviceId: nextServiceId, options: {} });
  };

  const setOption = (field: DescriptorField, next: Scalar | undefined) => {
    if (!value) return;
    const options = { ...value.options };
    if (next === undefined) {
      delete options[field.key];
    } else {
      options[field.key] = next;
    }
    // Dropping an option drops its parameters with it; setting an option
    // seeds its declared parameter defaults (same F3 rule as the effect).
    const parameters = { ...(value.parameters || {}) };
    if (next === undefined) {
      delete parameters[field.key];
    } else if (field.parameters) {
      const seeded = { ...(parameters[field.key] || {}) };
      for (const param of field.parameters) {
        if (param.default !== undefined && param.type !== 'secretReference' && seeded[param.key] === undefined) {
          seeded[param.key] = param.default;
        }
      }
      if (Object.keys(seeded).length > 0) parameters[field.key] = seeded;
    }
    onChange({
      ...value,
      descriptorVersion: descriptor?.version,
      options,
      ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
    });
  };

  const setParameter = (optionKey: string, field: DescriptorField, next: Scalar | undefined) => {
    if (!value) return;
    const forOption = { ...(value.parameters?.[optionKey] || {}) };
    if (next === undefined) {
      delete forOption[field.key];
    } else {
      forOption[field.key] = next;
    }
    const parameters = { ...(value.parameters || {}) };
    if (Object.keys(forOption).length > 0) {
      parameters[optionKey] = forOption;
    } else {
      delete parameters[optionKey];
    }
    onChange({
      ...value,
      descriptorVersion: descriptor?.version,
      ...(Object.keys(parameters).length > 0 ? { parameters } : { parameters: undefined }),
    });
  };

  return (
    <div className="execution-profile-editor">
      <div className="task-detail-ai-field execution-profile-field">
        <label htmlFor="execution-profile-service">Service</label>
        <Select
          id="execution-profile-service"
          value={serviceId ?? ''}
          onChange={(e) => selectService(e.target.value)}
        >
          <option value="">Basic (no Connector)</option>
          {connectors.map((connector) => (
            <option key={connector.id} value={connector.id}>{connector.name}</option>
          ))}
        </Select>
        {connectorsLoading ? <p className="task-detail-hint">Loading the Service registry…</p> : null}
        {connectorsError ? (
          <p className="task-detail-hint execution-profile-error">Service registry unavailable — basic profile only ({connectorsError})</p>
        ) : null}
        {!connectorsLoading && !connectorsError && connectors.length === 0 ? (
          <p className="task-detail-hint">No published Connectors are registered yet — basic profile only.</p>
        ) : null}
      </div>

      {serviceId && descriptorLoading ? <p className="task-detail-hint">Loading the capability descriptor…</p> : null}
      {serviceId && descriptorError ? (
        <p className="task-detail-hint execution-profile-error">Descriptor unavailable: {descriptorError}</p>
      ) : null}

      {serviceId && descriptor ? (
        <>
          <p className="task-detail-hint execution-profile-pin">
            Descriptor v{descriptor.version}
            {descriptor.retired ? ' (RETIRED — pick another Connector or wait for a live version)' : ''}
            {' — options are declared by the Connector; the board validates and never interprets them.'}
          </p>
          {descriptor.options.map((field) => (
            <div key={field.key} className="execution-profile-option">
              <FieldControl
                field={field}
                raw={value?.options?.[field.key]}
                onSet={(next) => setOption(field, next)}
                idPrefix="execution-option"
              />
              {field.parameters && value?.options?.[field.key] !== undefined
                ? field.parameters.map((param) => (
                    <FieldControl
                      key={param.key}
                      field={param}
                      raw={value?.parameters?.[field.key]?.[param.key]}
                      onSet={(next) => setParameter(field.key, param, next)}
                      idPrefix={`execution-param-${field.key}`}
                    />
                  ))
                : null}
            </div>
          ))}
          {descriptor.options.length === 0 ? (
            <p className="task-detail-hint">This Connector declares no execution options.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
