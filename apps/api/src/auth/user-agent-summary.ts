/**
 * Batch 2: a short, human description of a session's device ("Firefox on Windows") from its
 * user agent, for the user's own session list. Unknown agents read "Unknown browser"; the raw
 * header is never returned.
 */
export function userAgentSummary(userAgent: string | null | undefined): {
  browser: string;
  os: string;
} {
  const agent = (userAgent ?? '').slice(0, 512);
  const browser = /\bEdg(?:e|A|iOS)?\//.test(agent)
    ? 'Edge'
    : /\bOPR\/|\bOpera\b/.test(agent)
      ? 'Opera'
      : /\bFirefox\/|\bFxiOS\//.test(agent)
        ? 'Firefox'
        : /\bChrome\/|\bCriOS\//.test(agent)
          ? 'Chrome'
          : /\bSafari\//.test(agent)
            ? 'Safari'
            : 'Unknown browser';
  const os = /\bAndroid\b/.test(agent)
    ? 'Android'
    : /\b(iPhone|iPad|iPod)\b/.test(agent)
      ? 'iOS'
      : /\bWindows\b/.test(agent)
        ? 'Windows'
        : /\bCrOS\b/.test(agent)
          ? 'ChromeOS'
          : /\bMac OS X\b|\bMacintosh\b/.test(agent)
            ? 'macOS'
            : /\bLinux\b/.test(agent)
              ? 'Linux'
              : 'Unknown system';
  return { browser, os };
}
