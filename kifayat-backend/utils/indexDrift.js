// ─── Index drift check ──────────────────────────────────────────────────────
//
// The schema declares indexes, and some of them carry options MongoDB will
// refuse to change after the fact (a partial unique filter is the one that
// already bit us). A database created before that declaration — or restored
// from an older backup — keeps the OLD index and then fails in a confusing way
// at runtime instead of at startup.
//
// This module only READS. It never creates or drops anything; it reports what
// is wrong and tells the operator to run `npm run migrate`. Auto-fixing indexes
// on boot would be a much bigger, riskier behaviour change than this needs.
const mongoose = require("mongoose");

/**
 * Key signature for an index — stable regardless of field order, so it can be
 * compared between the schema definition and MongoDB's live description.
 */
function keySignature(key = {}) {
  return Object.keys(key)
    .sort()
    .map((k) => `${k}:${typeof key[k] === "object" ? JSON.stringify(key[k]) : key[k]}`)
    .join("|");
}

/**
 * The fields a text index actually covers.
 *
 * MongoDB reports a text index's `key` as { _fts: "text", _ftsx: 1 } and puts
 * the real field list in `weights` — so comparing `key` against the schema
 * always looks wrong and produces a false "drift" warning.
 */
function textIndexFields(index = {}) {
  return Object.keys(index.weights ?? {}).sort();
}

/** Every model Mongoose knows about, keyed by collection name. */
function registeredModels() {
  return Object.values(mongoose.models || {});
}

/**
 * Compare the live indexes of every registered model against what its schema
 * declares.
 *
 * @returns {Promise<{checked: number, warnings: string[], textIndexWarnings: string[]}>}
 */
async function checkIndexDrift() {
  const warnings = [];
  let checked = 0;

  for (const model of registeredModels()) {
    const collection = model.collection;
    const collectionName = collection.collectionName;

    let live = [];
    try {
      live = await collection.listIndexes().toArray();
    } catch {
      // Collection does not exist yet (fresh database) — nothing to compare.
      continue;
    }

    const declared = model.schema.indexes() || [];
    for (const [key, options] of declared) {
      checked += 1;

      const isText = Object.values(key).includes("text");

      if (isText) {
        const liveText = live.find((i) => Object.values(i.key ?? {}).includes("text"));
        if (!liveText) {
          warnings.push(
            `${collectionName}: the ${Object.keys(key).join("+")} text index is MISSING on this database.`,
          );
        } else {
          const liveFields = textIndexFields(liveText).join(",");
          const wantFields = Object.keys(key).sort().join(",");
          if (liveFields !== wantFields) {
            warnings.push(
              `${collectionName}: text index covers [${liveFields}] but the schema declares [${wantFields}].`,
            );
          }
        }
        continue;
      }

      const wantSig = keySignature(key);
      const liveMatch = live.find((i) => keySignature(i.key ?? {}) === wantSig);

      if (!liveMatch) {
        warnings.push(
          `${collectionName}: index on {${Object.keys(key).join(", ")}} is MISSING on this database.`,
        );
        continue;
      }

      // The index exists — now make sure its options still agree with the
      // schema, because MongoDB will not retro-fit a changed option.
      if (options?.unique && !liveMatch.unique) {
        warnings.push(
          `${collectionName}: index on {${Object.keys(key).join(", ")}} should be UNIQUE but is not.`,
        );
      }
      if (options?.partialFilterExpression && !liveMatch.partialFilterExpression) {
        warnings.push(
          `${collectionName}: index on {${Object.keys(key).join(", ")}} should be PARTIAL ` +
            `(${JSON.stringify(options.partialFilterExpression)}) but is a plain index.`,
        );
      }
      if (
        liveMatch.partialFilterExpression &&
        options?.partialFilterExpression &&
        JSON.stringify(liveMatch.partialFilterExpression) !==
          JSON.stringify(options.partialFilterExpression)
      ) {
        warnings.push(
          `${collectionName}: index on {${Object.keys(key).join(", ")}} has a different partial filter ` +
            `(${JSON.stringify(liveMatch.partialFilterExpression)}) than the schema declares.`,
        );
      }
    }
  }

  return { checked, warnings };
}

/**
 * Log a single, actionable startup summary. Never throws, never blocks boot.
 * @param {object} [logger] a winston-style logger; falls back to console.
 */
async function logIndexDrift(logger = null) {
  const out = logger || console;
  try {
    const { checked, warnings } = await checkIndexDrift();
    if (warnings.length === 0) {
      out.info?.(`Index check: ${checked} declared indexes match this database.`);
      return { checked, warnings };
    }
    out.warn?.(
      `Index check: ${warnings.length} of ${checked} declared indexes do not match this database. ` +
        `Run "npm run migrate" in kifayat-backend to fix them.`,
    );
    for (const w of warnings) out.warn?.(`  • ${w}`);
    return { checked, warnings };
  } catch (err) {
    out.warn?.(`Index check failed to run: ${err.message}`);
    return { checked: 0, warnings: [] };
  }
}

module.exports = { checkIndexDrift, logIndexDrift, keySignature, textIndexFields };
