"""The small, closed JSON Schema vocabulary shared with the model and local parser."""

import json

from .contracts import TOOLS


def obj(properties):
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


TEXT = {"type": "string", "minLength": 1, "maxLength": 12000}
STRINGS = {"type": "array", "items": TEXT, "maxItems": 32}
NUMBER = {"type": "integer", "minimum": 0}
SECTIONS = ("summary", "impact", "risks", "test_results", "rollback", "recommendation")
CLAIM_VALUE = {"anyOf": [TEXT, NUMBER, {"type": "array", "items": TEXT, "maxItems": 32}, obj({"passed": NUMBER, "failed": NUMBER})]}
REPORT = obj({
    "title": TEXT, "change_id": TEXT, "source_version": NUMBER, "task_ref": TEXT,
    "risk_level": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]}, "standard_ref": TEXT,
    "claims": {"type": "array", "minItems": 5, "maxItems": 5, "items": obj({
        "path": {"type": "string", "enum": ["version", "service", "dependencies", "tests", "rollback"]},
        "value": CLAIM_VALUE, "evidence_ref": TEXT})},
    "sections": obj({name: TEXT for name in SECTIONS}), "limitations": STRINGS,
})
ARGUMENTS = {
    TOOLS[0]: obj({"project_id": TEXT, "change_id": TEXT}),
    TOOLS[1]: obj({"project_id": TEXT}),
    TOOLS[2]: obj({"project_id": TEXT, "change_id": TEXT, "source_version": NUMBER, "report": REPORT}),
    TOOLS[3]: obj({"project_id": TEXT, "idempotency_key": TEXT}),
}
ACTION = {"anyOf": [obj({"tool_ref": {"type": "string", "enum": [tool]}, "args": args,
    "evidence_refs": STRINGS, "expected_checks": STRINGS, "decision_summary": TEXT}) for tool, args in ARGUMENTS.items()]}
PLAN = obj({"steps": {"type": "array", "minItems": 1, "maxItems": 16, "items": obj({
    "id": TEXT, "description": TEXT, "tool_ref": {"anyOf": [{"type": "string", "enum": list(TOOLS)}, {"type": "null"}]}})}})
DECISION = obj({"kind": {"type": "string", "enum": ["propose_action", "compose_report", "request_finish", "request_input"]},
                "summary": TEXT, "action": {"anyOf": [ACTION, {"type": "null"}]}})
SCHEMAS = {"plan": PLAN, "decide": DECISION, "compose": REPORT}


class SchemaError(ValueError):
    pass


def validate(value, schema, path="$"):
    """Validate only our explicit schema vocabulary, failing closed for unsupported keywords."""
    supported = {"type", "properties", "required", "additionalProperties", "anyOf", "enum", "items",
                 "minItems", "maxItems", "minLength", "maxLength", "minimum"}
    if set(schema) - supported:
        raise SchemaError("unsupported schema keyword")
    if "anyOf" in schema:
        for variant in schema["anyOf"]:
            try:
                validate(value, variant, path)
                return
            except SchemaError:
                pass
        raise SchemaError(path + ": no matching schema variant")
    types = {"object": dict, "array": list, "string": str, "integer": int, "null": type(None)}
    if schema.get("type") not in types or type(value) is not types[schema["type"]]:
        raise SchemaError(path + ": unexpected type")
    if "enum" in schema and value not in schema["enum"]:
        raise SchemaError(path + ": unregistered value")
    if isinstance(value, dict):
        properties = schema["properties"]
        if set(value) != set(schema["required"]) or schema["additionalProperties"] is not False:
            raise SchemaError(path + ": missing or extra fields")
        for name, child in properties.items():
            validate(value[name], child, path + "." + name)
    elif isinstance(value, list):
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 1000):
            raise SchemaError(path + ": invalid array length")
        for child in value:
            validate(child, schema["items"], path + "[]")
    elif isinstance(value, str):
        if not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", 12000):
            raise SchemaError(path + ": invalid text length")
    elif type(value) is int and value < schema.get("minimum", 0):
        raise SchemaError(path + ": invalid integer")


def parse_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise SchemaError("duplicate JSON key")
            result[key] = value
        return result
    def invalid_constant(_):
        raise SchemaError("non-finite JSON number")
    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_constant)
    except (json.JSONDecodeError, RecursionError) as exc:
        raise SchemaError("invalid JSON document") from exc
