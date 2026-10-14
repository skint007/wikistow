/** Only same-site paths are followed after sign-in, never another origin. */
export function safeRedirect(target: string | undefined): string {
  if (!target || !target.startsWith('/') || target.startsWith('//') || target.includes('\\'))
    return '/';
  return target;
}
