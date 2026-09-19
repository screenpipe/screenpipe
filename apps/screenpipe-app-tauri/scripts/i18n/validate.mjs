// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { parse, printAST } from "@generaltranslation/icu";

// Providers can preserve English branches that the target locale can never
// select. Drop only those unreachable branches; retain exact-count overrides,
// all live branches, and placeholders, then run the ordinary integrity checks.
export function normalizePluralBranches(message, locale) {
  if (typeof message !== "string") return message;
  try {
    const nodes = parse(message, { requiresOtherClause: true, ignoreTag: true });
    let changed = false;
    function visit(nodes) {
      for (const node of nodes) {
        if (node.type === 6) {
          const categories = new Intl.PluralRules(locale, { type: node.pluralType }).resolvedOptions().pluralCategories;
          for (const category of Object.keys(node.options)) {
            if (!category.startsWith("=") && !categories.includes(category)) {
              delete node.options[category];
              changed = true;
            }
          }
        }
        if (node.options) for (const option of Object.values(node.options)) visit(option.value);
        if (node.children) visit(node.children);
      }
    }
    visit(nodes);
    return changed ? printAST(nodes) : message;
  } catch { return message; }
}

const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

function icuShape(message, locale) {
  const variables = new Set();
  function visit(nodes) {
    for (const node of nodes) {
      if (node.type === 0 || node.type === 7) continue;
      variables.add(`${node.type}:${node.value}`);
      if (node.options) {
        if (!node.options.other) throw new Error("missing_other_plural_branch");
        if (node.type === 6) {
          const categories = new Intl.PluralRules(locale, { type: node.pluralType }).resolvedOptions().pluralCategories;
          for (const category of Object.keys(node.options)) {
            if (!category.startsWith("=") && !categories.includes(category)) throw new Error("invalid_plural_category");
          }
          variables.add(`offset:${node.offset}`);
        } else {
          variables.add(`select:${Object.keys(node.options).sort().join(",")}`);
        }
        for (const [key, option] of Object.entries(node.options)) {
          if (key.startsWith("=")) variables.add(`exact:${key}`);
          visit(option.value);
        }
      }
      if (node.children) visit(node.children);
    }
  }
  // String messages can contain literal CLI examples such as <model>. React
  // element structure is represented separately and checked by richShape.
  visit(parse(message, { requiresOtherClause: true, ignoreTag: true }));
  return [...variables].sort().join("|");
}

// GT represents rich text with element indices and variable tokens. Translations
// may reorder text/elements, but may not introduce components, props or values.
function richShape(value, locale) {
  const tokens = [];
  function visit(node, parent = "") {
    if (typeof node === "string") return;
    if (node === null || typeof node === "boolean") { tokens.push(`${parent}/${node}`); return; }
    if (Array.isArray(node)) { node.forEach((child) => visit(child, parent)); return; }
    if (!node || typeof node !== "object") throw new Error("invalid_message_structure");
    const { c, d, ...identity } = node;
    tokens.push(`${parent}/${stable(identity)}`);
    if (d !== undefined) {
      if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("invalid_message_structure");
      for (const [key, value] of Object.entries(d)) {
        if (["pl", "ti", "alt", "arl"].includes(key)) {
          if (typeof value !== "string") throw new Error("invalid_message_structure");
          tokens.push(`${parent}/${node.i}/attribute:${key}:${icuShape(value, locale)}`);
        } else if (key === "b") {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_message_structure");
          const keys = Object.keys(value).sort();
          if (d.t === "p") {
            const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
            if (!keys.includes("other") || keys.some((key) => !key.startsWith("=") && !categories.includes(key))) throw new Error("invalid_plural_category");
          }
          const branches = Object.values(value).map((branch) => richShape(branch, locale));
          tokens.push(`${parent}/${node.i}/branches:${d.t === "p" ? keys.filter((key) => key.startsWith("=")).join(",") : keys.join(",")}:${[...new Set(branches)].sort().join(";")}`);
        } else {
          // aria-labelledby/describedby are IDs, not prose. Preserve them and
          // every other structural property exactly.
          tokens.push(`${parent}/${node.i}/data:${key}:${stable(value)}`);
        }
      }
    }
    if (c !== undefined) visit(c, `${parent}/${node.i ?? node.t ?? ""}`);
  }
  visit(value);
  return tokens.sort().join("|");
}

export function validateTranslation(source, translated, sourceLocale, locale) {
  if (translated === undefined) return "missing_translation";
  try {
    if (typeof source === "string") {
      if (typeof translated !== "string" || (source.trim() && !translated.trim())) return "invalid_message_structure";
      if (icuShape(source, sourceLocale) !== icuShape(translated, locale)) return "invalid_placeholders";
    } else if (richShape(source, sourceLocale) !== richShape(translated, locale)) return "invalid_message_structure";
    return null;
  } catch { return "invalid_message_structure"; }
}

export function validateCatalog(source, translated, sourceLocale, locale) {
  const valid = {}, fallbacks = {};
  for (const [id, message] of Object.entries(source)) {
    const normalized = normalizePluralBranches(translated[id], locale);
    const reason = validateTranslation(message, normalized, sourceLocale, locale);
    if (reason) fallbacks[id] = reason;
    else valid[id] = normalized;
  }
  return { valid, fallbacks, total: Object.keys(source).length, translated: Object.keys(valid).length };
}
