export const entityKinds = ['service', 'module', 'file', 'function', 'class', 'resource'] as const;
export const relationKinds = ['contains', 'calls', 'depends_on', 'communicates_with', 'data_flow'] as const;

export const keyOf = (...parts: (string | number)[]) => JSON.stringify(parts);
export const entityKey = (kind: typeof entityKinds[number], path: string, symbol = '') => keyOf(kind, path, symbol);
export const relationKey = (from: string, kind: typeof relationKinds[number], to: string) => keyOf(from, kind, to);
export const behaviorKey = (entityId: string, name: string) => keyOf(entityId, name);
