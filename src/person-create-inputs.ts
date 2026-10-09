/** All-optional person creators start with their names; optional address/contact fields keep native defaults. */
export function minimalPersonCreateInputNames(inputs: Array<{ name?: unknown; required?: unknown }>): Set<string> | null {
  if (inputs.some(field => field.required === true) ||
      !inputs.some(field => typeof field.name === "string" && /^(?:lastname|familyname|surname|lname)$/i.test(field.name))) return null;
  return new Set(inputs.flatMap(field => typeof field.name === "string" &&
    /^(?:firstname|givenname|fname|lastname|familyname|surname|lname)$/i.test(field.name) ? [field.name] : []));
}
