/**
 * Territory scope rules shared by the splits editor, split sheet apply dialog
 * and contract form. Mirrors the backend: WORLD cannot be combined with
 * individual territories, and WORLD can never be excluded.
 */
export const WORLD = "WORLD";

export interface TerritoryScope {
  territories: string[];
  excluded: string[];
}

/** Toggles a code in the included list keeping WORLD exclusive. */
export function toggleTerritory(selected: readonly string[], code: string): string[] {
  if (selected.includes(code)) return selected.filter((item) => item !== code);
  if (code === WORLD) return [WORLD];
  return [...selected.filter((item) => item !== WORLD), code];
}

/** Toggles an exclusion (WORLD is ignored). */
export function toggleExcluded(excluded: readonly string[], code: string): string[] {
  if (code === WORLD) return [...excluded];
  return excluded.includes(code) ? excluded.filter((item) => item !== code) : [...excluded, code];
}

/** Exclusions only make sense on a WORLD scope; drop them otherwise. */
export function normalizeScope(scope: TerritoryScope): TerritoryScope {
  const territories = scope.territories.includes(WORLD) ? [WORLD] : [...new Set(scope.territories)];
  const excluded = territories.includes(WORLD) ? [...new Set(scope.excluded.filter((code) => code !== WORLD))] : [];
  return { territories, excluded };
}

export function scopeError(scope: TerritoryScope): string | null {
  if (scope.territories.length === 0) return "Select at least one territory (or WORLD).";
  if (scope.territories.includes(WORLD) && scope.territories.length > 1) return "WORLD cannot be combined with individual territories.";
  if (scope.excluded.includes(WORLD)) return "WORLD cannot be excluded.";
  return null;
}

export function scopeSummary(scope: TerritoryScope, names?: ReadonlyMap<string, string>): string {
  if (scope.territories.length === 0) return "No territories";
  const label = (code: string) => (code === WORLD ? "Worldwide" : (names?.get(code) ?? code));
  const included =
    scope.territories.length <= 3 ? scope.territories.map(label).join(", ") : `${scope.territories.slice(0, 2).map(label).join(", ")} +${scope.territories.length - 2} more`;
  if (scope.excluded.length === 0) return included;
  const excluded = scope.excluded.length <= 3 ? scope.excluded.join(", ") : `${scope.excluded.slice(0, 3).join(", ")} +${scope.excluded.length - 3}`;
  return `${included} excl. ${excluded}`;
}
