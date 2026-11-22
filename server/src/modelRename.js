// Renaming a model has to reach the places that reference it BY NAME.
//
// WHY: the console's own forms write names, not ids, for these references
// (Models.vue sends `routing.targets[].model`, `semantic.routes[].target`, …,
// and the API-key form sends `allowed_models`). So renaming a model in the UI
// left every key scoped to the old name behind, and the failure is doubly
// misleading: the old name answers 404 "model not found" (as if the model were
// gone) while the new name answers 403 "API key is not allowed to use model"
// (as if the key lacked permission). Neither points at "the rename did not
// propagate", and GET /v1/models comes back empty so the caller cannot even see
// what they are allowed to use.
//
// SCOPE: only references to MODELS, and only exact string matches. A wildcard
// entry (`*`, `provider/*`) is left alone — it matches the model either way, and
// rewriting it would corrupt the pattern. Id-based references need no help:
// an id does not change when a display name does.
//
// The rewrite is reported back to the caller ("updated N references") rather
// than performed quietly, because a save that edits rows the operator did not
// select is exactly the kind of surprise this codebase keeps getting bitten by.

// Where a model name can appear. `in` is the property holding the name; `at` is
// the path to its container (an array of objects, an object, or null for the row
// itself).
const MODEL_NAME_REFERENCES = [
  { kind: 'models', at: ['routing', 'targets'], in: 'model' },
  { kind: 'models', at: ['ensemble', 'panel'], in: 'model' },
  { kind: 'models', at: ['ensemble', 'judge'], in: 'model' },
  { kind: 'models', at: ['semantic', 'routes'], in: 'target' },
  { kind: 'models', at: ['semantic'], in: 'default' },
  { kind: 'models', at: ['semantic'], in: 'embedding_model' },
  // A list of names on the API key itself.
  { kind: 'api_keys', at: null, in: 'allowed_models', isList: true },
  // An embedded form: "model:<name>".
  { kind: 'cache_policies', at: null, in: 'applies_to', prefix: 'model:' },
];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const containers = (row, at) => {
  if (!at) return [row];
  let cur = row;
  for (const key of at) {
    cur = cur?.[key];
    if (cur === undefined || cur === null) return [];
  }
  return Array.isArray(cur) ? cur : [cur];
};

/**
 * Rewrite name references from `oldName` to `newName`, in place.
 *
 * @returns descriptions of what changed, e.g. `api_keys[2].allowed_models[0]`,
 *          for the save notice. Empty when nothing referenced the old name.
 */
export function renameModelReferences(doc, oldName, newName) {
  const changed = [];
  if (!oldName || !newName || oldName === newName) return changed;

  for (const ref of MODEL_NAME_REFERENCES) {
    const rows = Array.isArray(doc?.[ref.kind]) ? doc[ref.kind] : [];
    rows.forEach((row, rowIdx) => {
      if (!isObject(row)) return;
      containers(row, ref.at).forEach((container, contIdx) => {
        if (!isObject(container)) return;
        const current = container[ref.in];

        if (ref.isList) {
          if (!Array.isArray(current)) return;
          current.forEach((value, i) => {
            if (value === oldName) {
              current[i] = newName;
              changed.push(ref.at
                ? `${ref.kind}[${rowIdx}].${ref.at.join('.')}[${i}]`
                : `${ref.kind}[${rowIdx}].${ref.in}[${i}]`);
            }
          });
          return;
        }

        if (ref.prefix) {
          if (current === `${ref.prefix}${oldName}`) {
            container[ref.in] = `${ref.prefix}${newName}`;
            changed.push(`${ref.kind}[${rowIdx}].${ref.in}`);
          }
          return;
        }

        if (current === oldName) {
          container[ref.in] = newName;
          const where = ref.at ? `${ref.at.join('.')}[${contIdx}]` : `[${rowIdx}]`;
          changed.push(`${ref.kind}[${where}].${ref.in}`);
        }
      });
    });
  }
  return changed;
}

/**
 * What a PUT to a `models` row should propagate: nothing unless the display
 * name actually changed.
 */
export function propagateModelRename(doc, stored, entry) {
  const oldName = stored?.display_name;
  const newName = entry?.display_name;
  return renameModelReferences(doc, oldName, newName);
}
