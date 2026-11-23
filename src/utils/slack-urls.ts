export const SLACK_MATCH_PATTERNS = ['https://app.slack.com/*'];

export function isSlackUrl(url?: string | null): boolean {
  return /^https:\/\/app\.slack\.com\//i.test(url || '');
}
