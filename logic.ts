export type UpdateInfo = {
  piVersion?: string;
  packageNames: string[];
};

export type UpdateChoice = "all" | "pi" | "extensions" | "skip";

export function isNewerVersion(candidate: string, current: string): boolean {
  // ponytail: strict stable x.y.z comparison; prereleases are skipped.
  const parse = (version: string) => {
    const match = version
      .trim()
      .match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/i);
    return match ? match.slice(1).map(Number) : undefined;
  };

  const next = parse(candidate);
  const installed = parse(current);
  if (!next || !installed) return false;

  for (let index = 0; index < 3; index++) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

export function getUpdateOptions(
  info: UpdateInfo,
  currentVersion: string,
): Array<{ choice: UpdateChoice; label: string }> {
  const hasPi = Boolean(info.piVersion);
  const hasExtensions = info.packageNames.length > 0;
  const options: Array<{ choice: UpdateChoice; label: string }> = [];

  if (hasPi && hasExtensions) {
    options.push({
      choice: "all",
      label: `更新全部（Pi ${info.piVersion} + ${info.packageNames.length} 个扩展）`,
    });
    options.push({ choice: "pi", label: "只更新 Pi" });
    options.push({ choice: "extensions", label: "只更新扩展" });
  } else if (hasPi) {
    options.push({
      choice: "pi",
      label: `更新 Pi（${currentVersion} → ${info.piVersion}）`,
    });
  } else if (hasExtensions) {
    options.push({
      choice: "extensions",
      label: `更新扩展（${info.packageNames.join(", ")}）`,
    });
  }

  options.push({ choice: "skip", label: "暂不更新" });
  return options;
}
