import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';

/**
 * Warns the user before they lose unsaved work:
 * - in-app navigation (router blocker with a confirm dialog)
 * - closing / refreshing the tab (beforeunload)
 */
export default function useUnsavedGuard({ active, message }) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      Boolean(active) && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (blocker.state !== 'blocked') return undefined;
    const leave = window.confirm(message);
    if (leave) blocker.proceed();
    else blocker.reset();
    return undefined;
  }, [blocker, message]);

  useEffect(() => {
    if (!active) return undefined;
    function handleBeforeUnload(event) {
      // Chrome/Edge require returnValue to be set; Firefox needs preventDefault.
      event.preventDefault();
      event.returnValue = message;
      return message;
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [active, message]);
}
