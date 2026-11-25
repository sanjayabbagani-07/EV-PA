// Minimal JSON-Schema-subset validator + converter to Gemini's function-declaration schema.
// Supported: type (object|string|number|integer|boolean|array), properties, required, enum,
// minLength, maxLength, pattern, minimum, maximum, items, minItems, maxItems, default, description.
// Objects reject unknown keys, so a model cannot smuggle extra parameters into a tool.
const TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function assertValidSchema(schema, path = 'parameters') {
  if (!schema || typeof schema !== 'object' || !TYPES.has(schema.type)) {
    throw new Error(`${path}: "type" must be one of ${[...TYPES].join(', ')}`);
  }
  if (schema.type === 'object') {
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(props)) assertValidSchema(v, `${path}.${k}`);
    for (const r of schema.required || []) {
      if (!has(props, r)) throw new Error(`${path}: required key "${r}" is not in properties`);
    }
  }
  if (schema.type === 'array') {
    if (!schema.items) throw new Error(`${path}: arrays need "items"`);
    assertValidSchema(schema.items, `${path}[]`);
  }
}

export function validate(schema, value, path = 'args') {
  const errors = [];
  const out = walk(schema, value, path, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

function walk(schema, value, path, errors) {
  if (value === undefined || value === null) {
    if (has(schema, 'default')) return structuredClone(schema.default);
    errors.push(`${path} is required`);
    return undefined;
  }
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') { errors.push(`${path} must be a string`); return undefined; }
      if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path} must be at least ${schema.minLength} characters`);
      if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path} must be at most ${schema.maxLength} characters`);
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of: ${schema.enum.join(', ')}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has an invalid format`);
      return value;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(`${path} must be a number`); return undefined; }
      if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${path} must be an integer`);
      if (schema.minimum != null && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
      if (schema.maximum != null && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of: ${schema.enum.join(', ')}`);
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') { errors.push(`${path} must be a boolean`); return undefined; }
      return value;
    }
    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${path} must be an array`); return undefined; }
      if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
      if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} items`);
      return value.slice(0, schema.maxItems ?? 100).map((v, i) => walk(schema.items, v, `${path}[${i}]`, errors));
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) { errors.push(`${path} must be an object`); return undefined; }
      const props = schema.properties || {};
      const out = {};
      for (const k of Object.keys(value)) {
        if (!has(props, k)) errors.push(`${path}.${k} is not an allowed parameter`);
      }
      for (const [k, sub] of Object.entries(props)) {
        const present = has(value, k) && value[k] !== undefined && value[k] !== null;
        if (!present) {
          if (has(sub, 'default')) out[k] = structuredClone(sub.default);
          else if ((schema.required || []).includes(k)) errors.push(`${path}.${k} is required`);
          continue;
        }
        out[k] = walk(sub, value[k], `${path}.${k}`, errors);
      }
      return out;
    }
    default:
      errors.push(`${path}: unsupported schema type`);
      return undefined;
  }
}

// Gemini accepts an OpenAPI subset; strip keywords it may reject. Server-side validation still enforces them.
export function toGeminiSchema(schema) {
  const out = { type: schema.type };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.minimum != null) out.minimum = schema.minimum;
  if (schema.maximum != null) out.maximum = schema.maximum;
  if (schema.type === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties || {})) out.properties[k] = toGeminiSchema(v);
    if (schema.required?.length) out.required = [...schema.required];
  }
  if (schema.type === 'array') out.items = toGeminiSchema(schema.items);
  return out;
}
