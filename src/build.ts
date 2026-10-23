/** The build this page was loaded from, or null in development. Matches the server's welcome build. */
export function pageBuild(): string | null {
  return document.querySelector<HTMLMetaElement>('meta[name="bespingle-build"]')?.content || null;
}
