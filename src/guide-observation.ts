// Guide exploration acts by refs. Geometry is frozen separately in screenshots;
// repeating it (and full ancestry paths) on every DOM response bloats model input.
function withoutGeometry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutGeometry);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "box")
      .map(([key, item]) => [key, withoutGeometry(item)]),
  );
}
export function compactGuideObservation(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const data = value as Record<string, unknown>;
  if (data.observation)
    return { ...data, observation: compactGuideObservation(data.observation) };
  if (!data.tree || !Array.isArray(data.elements)) return value;
  return {
    ...data,
    tree: withoutGeometry(data.tree),
    elements: data.elements.map((element) => {
      const {
        box: _box,
        path: _path,
        row: _row,
        ...rest
      } = element as Record<string, unknown>;
      return rest;
    }),
    hint: `${data.hint || ""} 几何坐标在核验自动截图的screenshot.elements中冻结；不要为获取相同内容重复观察。`,
  };
}
