import { useEffect, RefObject } from 'react';

/**
 * Focus trap hook for modal accessibility
 * Traps Tab/Shift+Tab within the modal container
 * Restores focus to previously focused element on unmount
 * 
 * Usage:
 * const modalRef = useRef<HTMLDivElement>(null);
 * useFocusTrap(modalRef);
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement>) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Store previously focused element
    const previouslyFocused = document.activeElement as HTMLElement;

    // Get all focusable elements within container
    const getFocusableElements = (): HTMLElement[] => {
      const selectors = [
        'a[href]',
        'button:not([disabled])',
        'textarea:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        '[tabindex]:not([tabindex="-1"])'
      ];
      
      const elements = container.querySelectorAll<HTMLElement>(selectors.join(','));
      return Array.from(elements).filter(el => {
        // Filter out hidden elements
        return el.offsetParent !== null;
      });
    };

    // Handle Tab key
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey) {
        // Shift + Tab: moving backwards
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        // Tab: moving forwards
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    // Focus first focusable element on mount
    const focusableElements = getFocusableElements();
    if (focusableElements.length > 0) {
      focusableElements[0].focus();
    }

    // Add event listener
    container.addEventListener('keydown', handleKeyDown);

    // Cleanup: restore focus to previous element
    return () => {
      container.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused && previouslyFocused.focus) {
        previouslyFocused.focus();
      }
    };
  }, [containerRef]);
}
