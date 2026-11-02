/**
 * Composes domain method classes onto one target class.
 */

/**
 * Copy every instance and static member of each source class onto `target`, so a large API can live in
 * cohesive files while callers keep using a single class. Fails on a name defined twice, which would
 * otherwise silently let one module override another.
 * @param {Function} target - Class receiving the members
 * @param {Function[]} sources - Classes whose members are copied
 */
export function composeMethods(target, sources) {
  const owners = new Map();
  const copy = (from, to, kind, source) => {
    for (const name of Object.getOwnPropertyNames(from)) {
      if (['constructor', 'length', 'name', 'prototype'].includes(name)) continue;
      const key = `${kind}:${name}`;
      if (owners.has(key) || Object.hasOwn(to, name)) {
        throw new Error(`${kind} member ${name} is defined by both ${owners.get(key) ?? target.name} and ${source.name}`);
      }
      owners.set(key, source.name);
      Object.defineProperty(to, name, Object.getOwnPropertyDescriptor(from, name));
    }
  };
  for (const source of sources) {
    copy(source.prototype, target.prototype, 'instance', source);
    copy(source, target, 'static', source);
  }
}
