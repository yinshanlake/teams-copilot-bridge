import json
import sys

from jsonschema import Draft4Validator
from referencing import Registry
from referencing.exceptions import NoSuchResource


def refuse_external_reference(uri):
    raise NoSuchResource(ref=uri)


with open(sys.argv[1], encoding="utf-8-sig") as source:
    schema = json.load(source)
manifest = json.load(sys.stdin)
# Teams uses ECMAScript Unicode regexes in optional definitions. Python's
# regex-format meta-check rejects those before it sees the generated manifest.
Draft4Validator.check_schema(schema, format_checker=None)
validator = Draft4Validator(
    schema,
    registry=Registry(retrieve=refuse_external_reference),
    format_checker=Draft4Validator.FORMAT_CHECKER,
)
errors = sorted(
    validator.iter_errors(manifest),
    key=lambda error: "/".join(map(str, error.absolute_path)),
)
for error in errors:
    location = "/".join(map(str, error.absolute_path)) or "<root>"
    print(f"{location}: {error.message}", file=sys.stderr)
sys.exit(1 if errors else 0)
