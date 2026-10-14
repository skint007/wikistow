import { createContext, use } from 'react';

/**
 * Where menus and tooltips portal to. A modal <dialog> makes everything
 * outside it inert, so a dialog provides itself here and popups opened
 * inside it render inside it too. Null means the document body.
 */
export const PortalContainer = createContext<HTMLElement | null>(null);

export const usePortalContainer = () => use(PortalContainer) ?? undefined;
