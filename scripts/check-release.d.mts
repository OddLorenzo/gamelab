export interface ReleaseInput {
  /** Text of the built privacy.html, null when the file is missing. */
  privacyHtml: string | null;
  scripts: { name: string; text: string }[];
  /** VITE_WORKER_URL of the environment running the check; undefined when it is not set. */
  workerUrl?: string;
}
export function checkRelease(input: ReleaseInput): string[];
export function releaseWarnings(input: Pick<ReleaseInput, 'workerUrl'>): string[];
