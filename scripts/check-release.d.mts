export interface ReleaseInput {
  /** Text of the built privacy.html, null when the file is missing. */
  privacyHtml: string | null;
  scripts: { name: string; text: string }[];
}
export function checkRelease(input: ReleaseInput): string[];
