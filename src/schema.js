// 零依赖的小型 JSON Schema 校验器，只支持本项目契约实际使用的关键字：
// type / required / properties / items / additionalProperties / enum / const /
// minLength / minItems / uniqueItems / pattern / format(date) /
// minimum / maximum / exclusiveMinimum。
function validateValue(schema, value, path, errors) {
  if (schema.const !== undefined) {
    if (value !== schema.const) {
      errors.push(`${path || "/"} 应为固定值 ${JSON.stringify(schema.const)}`);
    }
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path || "/"} 必须是 ${schema.enum.join(" / ")} 之一`);
  }
  switch (schema.type) {
    case "object":
      validateObject(schema, value, path, errors);
      break;
    case "array":
      validateArray(schema, value, path, errors);
      break;
    case "string":
      if (typeof value !== "string") {
        errors.push(`${path || "/"} 应为字符串`);
      } else {
        validateString(schema, value, path, errors);
      }
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        errors.push(`${path || "/"} 应为整数`);
      } else {
        validateNumber(schema, value, path, errors);
      }
      break;
    case "number":
      if (typeof value !== "number") {
        errors.push(`${path || "/"} 应为数字`);
      } else {
        validateNumber(schema, value, path, errors);
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path || "/"} 应为布尔值`);
      break;
    default:
      break;
  }
}

function validateObject(schema, value, path, errors) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${path || "/"} 应为对象`);
    return;
  }
  for (const key of schema.required ?? []) {
    if (!(key in value)) errors.push(`${path || "/"} 缺少必填字段 ${key}`);
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (key in value) validateValue(child, value[key], `${path}/${key}`, errors);
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) errors.push(`${path || "/"} 存在未约定字段 ${key}`);
    }
  }
}

function validateArray(schema, value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path || "/"} 应为数组`);
    return;
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push(`${path || "/"} 至少应有 ${schema.minItems} 项`);
  }
  if (schema.uniqueItems) {
    const seen = new Set();
    value.forEach((item, i) => {
      const marker = JSON.stringify(item);
      if (seen.has(marker)) errors.push(`${path}/${i} 与前面的项重复`);
      seen.add(marker);
    });
  }
  if (schema.items) {
    value.forEach((item, i) => validateValue(schema.items, item, `${path}/${i}`, errors));
  }
}

function validateString(schema, value, path, errors) {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path || "/"} 长度不能少于 ${schema.minLength}`);
  }
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path || "/"} 不符合编号规则 ${schema.pattern}`);
  }
  if (schema.format === "date" && !isDate(value)) {
    errors.push(`${path || "/"} 应为 YYYY-MM-DD 日期`);
  }
}

function validateNumber(schema, value, path, errors) {
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path || "/"} 不能小于 ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${path || "/"} 不能大于 ${schema.maximum}`);
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    errors.push(`${path || "/"} 必须大于 ${schema.exclusiveMinimum}`);
  }
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// 按契约校验，返回错误列表（空列表表示通过）。
export function validate(schema, value) {
  const errors = [];
  validateValue(schema, value, "", errors);
  return errors;
}
