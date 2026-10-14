import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { desktop } from '../desktop';
import { usePlugins } from './runtime';

/**
 * Says the desktop app started without plugins, drawn by the app itself so
 * no plugin can hide it, with the way back to Settings → Plugins.
 */
export function SafeModeBanner() {
  const { safeMode } = usePlugins();
  if (!safeMode || !desktop) return null;
  const bridge = desktop;
  return (
    <div
      role="status"
      data-region="safe-mode"
      className="fixed right-4 bottom-4 z-50 flex flex-wrap items-center gap-2 rounded-card bg-card px-4 py-2 text-sm shadow-card"
    >
      <strong>Safe mode:</strong> plugins are off.
      <Button asChild size="sm" variant="outline">
        <Link to="/settings">Manage plugins</Link>
      </Button>
      <Button size="sm" variant="outline" onClick={() => void bridge.setSafeMode(false)}>
        Turn plugins back on
      </Button>
    </div>
  );
}
