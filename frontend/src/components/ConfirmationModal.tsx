import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle } from 'lucide-react';
import { Button } from './Button';
import { IconButton } from './ui/IconButton';
import './ConfirmationModal.css';

interface ConfirmationModalProps {
  title: string;
  message: string | React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  requiresConfirmation?: boolean;
  confirmationPlaceholder?: string;
  confirmationValue?: string;
  /** The caller knows something that forbids confirming — a count it has
   * not established, say. An acknowledgement is an acknowledgement OF
   * something, so the control refuses rather than the server. */
  confirmDisabled?: boolean;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  requiresConfirmation = false,
  confirmationPlaceholder = '',
  confirmationValue = '',
  confirmDisabled = false,
  danger = false,
  onConfirm,
  onCancel
}) => {
  const [confirmText, setConfirmText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  // Focus-trapped dialog (design 986be411 §9): initial focus lands inside,
  // Tab cycles within, and focus returns to the opener on close.
  useEffect(() => {
    const node = modalRef.current;
    if (!node) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(
      node.querySelectorAll<HTMLElement>('button, input, [href], [tabindex]:not([tabindex="-1"])')
    ).filter(el => !el.hasAttribute('disabled'));
    (focusables()[0] ?? node).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);
  
  const canConfirm = (!requiresConfirmation || confirmText === confirmationValue) && !confirmDisabled;
  
  const handleConfirm = async () => {
    if (!canConfirm || isSubmitting) return;
    
    setIsSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setIsSubmitting(false);
    }
  };
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canConfirm && !isSubmitting) {
      handleConfirm();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };
  
  return createPortal(
    <div className="confirmation-modal-overlay" onClick={onCancel}>
      <div
        className="confirmation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-modal-title"
        ref={modalRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="confirmation-modal-header">
          {danger && <AlertTriangle className="confirmation-icon-danger" size={24} />}
          <h2 id="confirmation-modal-title">{title}</h2>
          <IconButton
            className="modal-close"
            variant="ghost"
            ariaLabel="Close"
            icon={<X size={20} />}
            onClick={onCancel}
            disabled={isSubmitting}
          />
        </div>
        
        <div className="confirmation-modal-body">
          {typeof message === 'string' ? <p>{message}</p> : message}
          
          {requiresConfirmation && (
            <div className="confirmation-input-wrapper">
              <label htmlFor="confirm-input">
                Type <strong>{confirmationValue}</strong> to confirm:
              </label>
              <input
                id="confirm-input"
                type="text"
                placeholder={confirmationPlaceholder}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="confirmation-input"
                autoFocus
                disabled={isSubmitting}
              />
            </div>
          )}
        </div>
        
        <div className="confirmation-modal-footer">
          <Button
            variant="secondary"
            size="compact"
            className="confirmation-modal-btn-cancel"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            size="compact"
            className="btn-confirm"
            onClick={handleConfirm}
            disabled={!canConfirm || isSubmitting}
          >
            {isSubmitting ? 'Processing...' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
};
