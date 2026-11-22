/** Whether two of the router's addresses are the same place, a path's trailing slash aside. */
export function sameHref(a: string, b: string): boolean {
  const trimmed = (href: string) => href.replace(/(.)\/+(?=$|[?#])/, '$1');
  return trimmed(a) === trimmed(b);
}
